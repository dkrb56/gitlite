// Thin wrapper around the git CLI. Every public function takes the repo path first.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  Branch,
  Commit,
  DiffTarget,
  FileChange,
  FileChangeKind,
  OpState,
  PatchMode,
  RefLabel,
  RepoSnapshot,
  ResolveSide,
  StashEntry,
  WorkingStatus,
} from '../shared/types';

const RS = '\x1e'; // record separator
const US = '\x1f'; // unit separator
const MAX_COMMITS = 2000;

/** Extra environment for every git call: the askpass bridge, set by main once its server runs. */
let extraEnv: Record<string, string> = {};
export function setExtraEnv(env: Record<string, string>): void {
  extraEnv = env;
}

interface RunOptions {
  okCodes?: number[];
  input?: string;
}

export function run(cwd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const okCodes = opts.okCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
        // GIT_EDITOR=true accepts default messages (merge --continue, rebase), so no editor ever opens.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_PAGER: 'cat', GIT_EDITOR: 'true', ...extraEnv },
      },
      (err, stdout, stderr) => {
        const code = (err as (NodeJS.ErrnoException & { code?: number | string }) | null)?.code;
        if (!err || (typeof code === 'number' && okCodes.includes(code))) {
          resolve(stdout);
          return;
        }
        const msg = (stderr || stdout || err.message).trim();
        reject(new Error(msg));
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}

export async function toplevel(dir: string): Promise<string> {
  return (await run(dir, ['rev-parse', '--show-toplevel'])).trim();
}

// ---------- log ----------

function parseRefs(decoration: string, remoteNames: Set<string>): RefLabel[] {
  const labels: RefLabel[] = [];
  if (!decoration.trim()) return labels;
  for (const raw of decoration.split(',')) {
    let part = raw.trim();
    if (!part) continue;
    if (part.startsWith('HEAD -> ')) {
      labels.push({ kind: 'head', name: 'HEAD' });
      part = part.slice('HEAD -> '.length);
    } else if (part === 'HEAD') {
      labels.push({ kind: 'head', name: 'HEAD' });
      continue;
    }
    if (part.startsWith('tag: ')) {
      labels.push({ kind: 'tag', name: part.slice(5) });
    } else if (remoteNames.has(part) || part.endsWith('/HEAD')) {
      labels.push({ kind: 'remote', name: part });
    } else {
      labels.push({ kind: 'branch', name: part });
    }
  }
  return labels;
}

export async function log(repo: string, remoteNames: Set<string>): Promise<Commit[]> {
  const format = ['%H', '%P', '%an', '%ae', '%aI', '%D', '%s', '%B'].join(US) + RS;
  let out: string;
  try {
    // Not --all: that would also walk refs/stash and show every stash as a commit.
    out = await run(repo, [
      'log',
      'HEAD',
      '--branches',
      '--tags',
      '--remotes',
      '--topo-order',
      `--max-count=${MAX_COMMITS}`,
      `--format=${format}`,
    ]);
  } catch (e) {
    // An unborn repository has nothing to log.
    if (/does not have any commits yet|bad default revision|ambiguous argument 'HEAD'|unknown revision/i.test(String(e))) return [];
    throw e;
  }
  const commits: Commit[] = [];
  for (const record of out.split(RS)) {
    const rec = record.replace(/^\r?\n/, '');
    if (!rec.trim()) continue;
    const f = rec.split(US);
    if (f.length < 8) continue;
    const body = f[7].replace(/\r?\n$/, '');
    commits.push({
      hash: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      authorName: f[2],
      authorEmail: f[3],
      date: f[4],
      refs: parseRefs(f[5], remoteNames),
      subject: f[6],
      body,
    });
  }
  return commits;
}

// ---------- status ----------

function kindFromCode(x: string): FileChangeKind {
  switch (x) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    case 'U':
      return 'conflict';
    default:
      return 'unknown';
  }
}

export async function status(repo: string): Promise<WorkingStatus> {
  const out = await run(repo, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']);
  const tokens = out.split('\0');
  const st: WorkingStatus = {
    branch: null,
    head: null,
    detached: false,
    staged: [],
    unstaged: [],
    ahead: 0,
    behind: 0,
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith('# ')) {
      const [key, ...rest] = t.slice(2).split(' ');
      const val = rest.join(' ');
      if (key === 'branch.head') {
        if (val === '(detached)') st.detached = true;
        else st.branch = val;
      } else if (key === 'branch.oid') {
        st.head = val === '(initial)' ? null : val;
      } else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(val);
        if (m) {
          st.ahead = Number(m[1]);
          st.behind = Number(m[2]);
        }
      }
      continue;
    }
    const type = t[0];
    if (type === '1' || type === '2') {
      const parts = t.split(' ');
      const xy = parts[1];
      let path: string;
      let oldPath: string | undefined;
      if (type === '1') {
        path = parts.slice(8).join(' ');
      } else {
        path = parts.slice(9).join(' ');
        oldPath = tokens[++i];
      }
      const x = xy[0];
      const y = xy[1];
      if (x !== '.') st.staged.push({ path, oldPath, kind: kindFromCode(x) });
      if (y !== '.') st.unstaged.push({ path, kind: kindFromCode(y) });
    } else if (type === 'u') {
      const parts = t.split(' ');
      const path = parts.slice(10).join(' ');
      st.unstaged.push({ path, kind: 'conflict' });
    } else if (type === '?') {
      st.unstaged.push({ path: t.slice(2), kind: 'untracked' });
    }
  }
  return st;
}

// ---------- branches ----------

export async function branches(repo: string): Promise<Branch[]> {
  const fmt = ['%(refname:short)', '%(HEAD)', '%(upstream:short)', '%(refname)'].join(US);
  const out = await run(repo, ['branch', '--all', '--no-color', `--format=${fmt}`]);
  const list: Branch[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [name, head, upstream, refname] = line.replace(/\r$/, '').split(US);
    if (name.endsWith('/HEAD')) continue; // origin/HEAD symbolic ref
    list.push({
      name,
      current: head === '*',
      upstream: upstream || null,
      remote: refname.startsWith('refs/remotes/'),
    });
  }
  return list;
}

export async function snapshot(repo: string): Promise<RepoSnapshot> {
  const [st, br, stashes, op] = await Promise.all([status(repo), branches(repo), stashList(repo), opState(repo)]);
  const remoteNames = new Set(br.filter((b) => b.remote).map((b) => b.name));
  const commits = await log(repo, remoteNames);
  return { commits, status: st, branches: br, stashes, op };
}

// ---------- stashes ----------

export async function stashList(repo: string): Promise<StashEntry[]> {
  const out = await run(repo, ['stash', 'list', `--format=%gd${US}%s${US}%ci`]);
  const list: StashEntry[] = [];
  for (const line of out.split('\n')) {
    const [ref, message, date] = line.replace(/\r$/, '').split(US);
    const m = /^stash@\{(\d+)\}$/.exec(ref ?? '');
    if (!m) continue;
    list.push({ index: Number(m[1]), ref, message, date });
  }
  return list;
}

export async function stashPush(repo: string, message: string, includeUntracked: boolean): Promise<void> {
  const args = ['stash', 'push'];
  if (includeUntracked) args.push('--include-untracked');
  if (message.trim()) args.push('-m', message.trim());
  await run(repo, args);
}

export async function stashApply(repo: string, index: number, pop: boolean): Promise<string> {
  // Exit 1 means the stash applied with conflicts; the files show up as conflicts in the status.
  return run(repo, ['stash', pop ? 'pop' : 'apply', `stash@{${index}}`], { okCodes: [0, 1] });
}

export async function stashDrop(repo: string, index: number): Promise<void> {
  await run(repo, ['stash', 'drop', `stash@{${index}}`]);
}

// ---------- merge / rebase / cherry-pick state ----------

async function gitDir(repo: string): Promise<string> {
  const dir = (await run(repo, ['rev-parse', '--git-dir'])).trim();
  return path.isAbsolute(dir) ? dir : path.join(repo, dir);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readTrimmed(p: string): Promise<string | null> {
  try {
    return (await fs.readFile(p, 'utf8')).trim();
  } catch {
    return null;
  }
}

export async function opState(repo: string): Promise<OpState | null> {
  const dir = await gitDir(repo);
  if (await exists(path.join(dir, 'rebase-merge'))) {
    const head = await readTrimmed(path.join(dir, 'rebase-merge', 'head-name'));
    return { kind: 'rebase', detail: head?.replace(/^refs\/heads\//, '') ?? null };
  }
  if (await exists(path.join(dir, 'rebase-apply'))) {
    const head = await readTrimmed(path.join(dir, 'rebase-apply', 'head-name'));
    return { kind: 'rebase', detail: head?.replace(/^refs\/heads\//, '') ?? null };
  }
  if (await exists(path.join(dir, 'MERGE_HEAD'))) {
    return { kind: 'merge', detail: (await readTrimmed(path.join(dir, 'MERGE_HEAD')))?.slice(0, 7) ?? null };
  }
  if (await exists(path.join(dir, 'CHERRY_PICK_HEAD'))) {
    return { kind: 'cherry-pick', detail: (await readTrimmed(path.join(dir, 'CHERRY_PICK_HEAD')))?.slice(0, 7) ?? null };
  }
  if (await exists(path.join(dir, 'REVERT_HEAD'))) {
    return { kind: 'revert', detail: (await readTrimmed(path.join(dir, 'REVERT_HEAD')))?.slice(0, 7) ?? null };
  }
  return null;
}

/** Conflicts give exit code 1 with the explanation on stdout; the caller shows it and the status shows the files. */
export async function merge(repo: string, branch: string): Promise<string> {
  return run(repo, ['merge', '--no-edit', branch], { okCodes: [0, 1] });
}

export async function rebase(repo: string, onto: string): Promise<string> {
  return run(repo, ['rebase', onto], { okCodes: [0, 1] });
}

export async function cherryPick(repo: string, hash: string): Promise<string> {
  return run(repo, ['cherry-pick', hash], { okCodes: [0, 1] });
}

export async function opContinue(repo: string): Promise<string> {
  const op = await opState(repo);
  if (!op) return 'Nothing to continue.';
  return run(repo, [op.kind, '--continue'], { okCodes: [0, 1] });
}

export async function opAbort(repo: string): Promise<void> {
  const op = await opState(repo);
  if (!op) return;
  await run(repo, [op.kind, '--abort']);
}

/**
 * Takes one side of conflicted files, then marks them resolved.
 * During a rebase git swaps the meaning of ours/theirs; the renderer labels sides by branch, so swap back here.
 */
export async function resolve(repo: string, paths: string[], side: ResolveSide): Promise<void> {
  if (!paths.length) return;
  const op = await opState(repo);
  const flag = op?.kind === 'rebase' ? (side === 'ours' ? '--theirs' : '--ours') : side === 'ours' ? '--ours' : '--theirs';
  await run(repo, ['checkout', flag, '--', ...paths]);
  await run(repo, ['add', '--', ...paths]);
}

export async function markResolved(repo: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  await run(repo, ['add', '--', ...paths]);
}

export async function readFile(repo: string, rel: string): Promise<string> {
  return fs.readFile(path.join(repo, rel), 'utf8');
}

// ---------- tags ----------

export async function createTag(repo: string, name: string, hash: string, message: string | null): Promise<void> {
  const args = message ? ['tag', '-a', name, hash, '-m', message] : ['tag', name, hash];
  await run(repo, args);
}

export async function deleteTag(repo: string, name: string): Promise<void> {
  await run(repo, ['tag', '-d', name]);
}

export async function pushTag(repo: string, name: string): Promise<string> {
  return run(repo, ['push', 'origin', `refs/tags/${name}`]);
}

// ---------- partial staging ----------

export async function applyPatch(repo: string, patch: string, mode: PatchMode): Promise<void> {
  const args = ['apply', '--whitespace=nowarn'];
  if (mode === 'stage') args.push('--cached');
  if (mode === 'unstage') args.push('--cached', '--reverse');
  if (mode === 'discard') args.push('--reverse');
  await run(repo, args, { input: patch });
}

// ---------- commit contents ----------

function parseNameStatus(out: string): FileChange[] {
  const tokens = out.split('\0');
  const files: FileChange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[++i];
      const path = tokens[++i];
      files.push({ path, oldPath, kind: kindFromCode(letter) });
    } else {
      const path = tokens[++i];
      files.push({ path, kind: kindFromCode(letter) });
    }
  }
  return files;
}

export async function commitFiles(repo: string, hash: string, parent: string | null): Promise<FileChange[]> {
  const args = parent
    ? ['diff', '--name-status', '-z', '-M', parent, hash]
    : ['diff-tree', '--root', '-r', '--no-commit-id', '--name-status', '-z', '-M', hash];
  return parseNameStatus(await run(repo, args));
}

export async function diff(repo: string, target: DiffTarget): Promise<string> {
  const common = ['--no-color', '-M'];
  switch (target.kind) {
    case 'commit': {
      const paths = target.oldPath ? [target.oldPath, target.path] : [target.path];
      if (!target.parent) {
        return run(repo, ['diff-tree', '-p', '--root', '-r', '--no-commit-id', ...common, target.hash, '--', ...paths]);
      }
      return run(repo, ['diff', ...common, target.parent, target.hash, '--', ...paths]);
    }
    case 'staged': {
      const paths = target.oldPath ? [target.oldPath, target.path] : [target.path];
      return run(repo, ['diff', '--cached', ...common, '--', ...paths]);
    }
    case 'unstaged':
      return run(repo, ['diff', ...common, '--', target.path]);
    case 'untracked':
      return run(repo, ['diff', '--no-index', '--no-color', '--', '/dev/null', target.path], { okCodes: [0, 1] });
    case 'conflict':
      // The renderer shows the file with its conflict markers; git's combined diff is not useful here.
      return readFile(repo, target.path);
  }
}

// ---------- working copy actions ----------

export async function stage(repo: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  await run(repo, ['add', '-A', '--', ...paths]);
}

export async function unstage(repo: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  try {
    await run(repo, ['restore', '--staged', '--', ...paths]);
  } catch {
    // Unborn branch: there is no HEAD to restore from.
    await run(repo, ['rm', '--cached', '-r', '-q', '--', ...paths]);
  }
}

export async function discard(repo: string, files: FileChange[]): Promise<void> {
  const untracked = files.filter((f) => f.kind === 'untracked').map((f) => f.path);
  const tracked = files.filter((f) => f.kind !== 'untracked').map((f) => f.path);
  if (tracked.length) await run(repo, ['checkout', '--', ...tracked]);
  if (untracked.length) await run(repo, ['clean', '-f', '--', ...untracked]);
}

export async function commit(repo: string, message: string): Promise<void> {
  await run(repo, ['commit', '-F', '-'], { input: message });
}

// ---------- branches / remotes ----------

export async function checkout(repo: string, branch: string, remote: boolean): Promise<void> {
  if (remote) {
    // origin/feature -> local "feature" tracking origin/feature
    const local = branch.split('/').slice(1).join('/');
    await run(repo, ['checkout', '--track', '-b', local, branch]);
  } else {
    await run(repo, ['checkout', branch]);
  }
}

export async function checkoutCommit(repo: string, hash: string): Promise<void> {
  await run(repo, ['checkout', '--detach', hash]);
}

export async function createBranch(repo: string, name: string, startPoint: string | null): Promise<void> {
  const args = ['checkout', '-b', name];
  if (startPoint) args.push(startPoint);
  await run(repo, args);
}

export async function deleteBranch(repo: string, name: string, remote: boolean): Promise<void> {
  if (remote) {
    const [origin, ...rest] = name.split('/');
    await run(repo, ['push', origin, '--delete', rest.join('/')]);
  } else {
    await run(repo, ['branch', '-D', name]);
  }
}

export async function fetch(repo: string): Promise<string> {
  return run(repo, ['fetch', '--all', '--prune']);
}

export async function pull(repo: string): Promise<string> {
  return run(repo, ['pull']);
}

export async function push(repo: string): Promise<string> {
  const st = await status(repo);
  const br = await branches(repo);
  const current = br.find((b) => b.current);
  if (st.branch && current && !current.upstream) {
    return run(repo, ['push', '-u', 'origin', st.branch]);
  }
  return run(repo, ['push']);
}
