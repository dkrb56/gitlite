import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import type { AskpassRequest, Commit, DiffTarget, FileChange, GitApi, RepoEntry, RepoSnapshot, StashEntry } from '../shared/types';
import { $, clear, el } from './dom';
import { renderConflict, renderDiff, type PatchAction } from './diff';
import { graphWidth, layoutGraph, renderRowSvg, type GraphNode } from './graph';
import { ACCENTS, applySettings, formatDate, formatDateLong, loadSettings, saveSettings, type Settings } from './theme';

declare global { interface Window { git: GitApi; } }
const git = window.git;
const WORKING = '@working';
const STASH = 'stash:'; // selected = "stash:<index>"

interface State {
  repos: RepoEntry[]; repo: RepoEntry | null; snap: RepoSnapshot | null;
  selected: string | null; selectedFile: { key: string; target: DiffTarget; label: string } | null;
  commitFilesCache: Map<string, FileChange[]>; busy: number; settings: Settings; branchOpen: boolean;
  commitDraft: string; // survives pane rebuilds after stage/unstage
}
const state: State = {
  repos: [], repo: null, snap: null, selected: null, selectedFile: null,
  commitFilesCache: new Map(), busy: 0, settings: loadSettings(), branchOpen: false, commitDraft: '',
};

// ---------- toast / busy ----------
let toastTimer: number | undefined;
function toast(text: string, isError = false): void {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('error', isError);
  t.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), isError ? 5000 : 2400);
}
function errText(e: unknown): string { return e instanceof Error ? e.message : String(e); }

async function busy<T>(label: string, fn: () => Promise<T>, done?: string): Promise<T | undefined> {
  state.busy++;
  const b = $('busy');
  b.textContent = `${label}…`;
  b.hidden = false;
  try {
    const result = await fn();
    if (done) toast(done);
    return result;
  } catch (e) {
    toast(`${label} failed: ${errText(e)}`, true);
    return undefined;
  } finally {
    state.busy--;
    if (state.busy === 0) b.hidden = true;
  }
}

/** Git's conflict / "nothing to do" messages come back as text; show the first useful line. */
function firstLine(out: string | undefined, fallback: string): string {
  const line = (out ?? '').split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('hint:'));
  return line ?? fallback;
}

// ---------- sheets ----------
function confirmSheet(title: string, text: Node | string, okLabel = 'Discard', cancelLabel = 'Keep'): Promise<boolean> {
  const box = $('confirm');
  $('confirm-title').textContent = title;
  const t = $('confirm-text'); clear(t); t.append(text);
  const ok = $('confirm-ok'), cancel = $('confirm-cancel');
  ok.textContent = okLabel; cancel.textContent = cancelLabel;
  box.hidden = false;
  return new Promise((resolve) => {
    const done = (v: boolean) => { box.hidden = true; ok.removeEventListener('click', onOk); cancel.removeEventListener('click', onCancel); document.removeEventListener('keydown', onKey); resolve(v); };
    const onOk = () => done(true), onCancel = () => done(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    ok.addEventListener('click', onOk); cancel.addEventListener('click', onCancel); document.addEventListener('keydown', onKey);
    ok.focus();
  });
}

interface PromptOptions { title: string; text?: string; placeholder?: string; value?: string; okLabel?: string; password?: boolean; check?: string; checked?: boolean; allowEmpty?: boolean; }
interface PromptResult { value: string; checked: boolean; }
function promptSheet(o: PromptOptions): Promise<PromptResult | null> {
  const box = $('prompt'), input = $<HTMLInputElement>('prompt-input'), check = $<HTMLInputElement>('prompt-check');
  $('prompt-title').textContent = o.title;
  $('prompt-text').textContent = o.text ?? '';
  $('prompt-text').hidden = !o.text;
  input.type = o.password ? 'password' : 'text';
  input.placeholder = o.placeholder ?? '';
  input.value = o.value ?? '';
  $('prompt-check-row').hidden = !o.check;
  $('prompt-check-label').textContent = o.check ?? '';
  check.checked = !!o.checked;
  const ok = $('prompt-ok'), cancel = $('prompt-cancel');
  ok.textContent = o.okLabel ?? 'OK';
  box.hidden = false;
  input.focus(); input.select();
  return new Promise((resolve) => {
    const done = (v: PromptResult | null) => { box.hidden = true; ok.removeEventListener('click', onOk); cancel.removeEventListener('click', onCancel); input.removeEventListener('keydown', onKey); resolve(v); };
    const onOk = () => { const value = input.value.trim(); if (!value && !o.allowEmpty) { input.focus(); return; } done({ value, checked: check.checked }); };
    const onCancel = () => done(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };
    ok.addEventListener('click', onOk); cancel.addEventListener('click', onCancel); input.addEventListener('keydown', onKey);
  });
}

// Credential prompts from git / ssh, one at a time.
let askQueue: Promise<void> = Promise.resolve();
function onAskpass(req: AskpassRequest): void {
  askQueue = askQueue.then(async () => {
    const p = req.prompt.trim();
    const yesNo = /\(yes\/no/i.test(p);
    if (yesNo) {
      const ok = await confirmSheet('Git asks', p, 'Yes', 'No');
      git.answerAskpass(req.id, ok ? 'yes' : null);
      return;
    }
    const secret = /password|passphrase|token|secret/i.test(p);
    const r = await promptSheet({ title: secret ? 'Git needs a password' : 'Git needs a username', text: p.replace(/:\s*$/, ''), password: secret, okLabel: 'Continue', allowEmpty: true });
    git.answerAskpass(req.id, r ? r.value : null);
  });
}

// ---------- context menu ----------
interface MenuItem { label: string; onClick?: () => void; danger?: boolean; disabled?: boolean; sep?: boolean; }
function showMenu(x: number, y: number, items: MenuItem[]): void {
  const m = $('menu'); clear(m);
  for (const it of items) {
    if (it.sep) { m.appendChild(el('div', { class: 'sep' })); continue; }
    m.appendChild(el('div', { class: `item ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}`, onclick: () => { hideMenu(); it.onClick?.(); } }, it.label));
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
}
function hideMenu(): void { $('menu').hidden = true; }

// ---------- repositories ----------
function renderRepoList(): void {
  const list = $('repo-list');
  clear(list);
  $('empty').hidden = state.repos.length > 0;
  $('toolbar').hidden = state.repos.length === 0;
  $('columns').hidden = state.repos.length === 0;
  if (!state.repos.length) { list.appendChild(el('li', { class: 'empty' }, 'No repositories yet.')); return; }
  for (const r of state.repos) {
    list.appendChild(el('li', { class: state.repo?.path === r.path ? 'selected' : '', title: r.path, onclick: () => void selectRepo(r) },
      el('span', { class: 'name' }, r.name),
      el('span', { class: 'path' }, r.path),
      el('span', { class: 'remove', title: 'Remove from list', onclick: (e) => { e.stopPropagation(); void removeRepo(r); } }, '✕'),
    ));
  }
}
async function removeRepo(r: RepoEntry): Promise<void> {
  state.repos = await git.removeRepo(r.path);
  if (state.repo?.path === r.path) { state.repo = null; state.snap = null; state.selected = null; state.selectedFile = null; renderAll(); }
  renderRepoList();
}
async function selectRepo(r: RepoEntry): Promise<void> {
  state.repo = r; state.selected = null; state.selectedFile = null; state.commitDraft = ''; state.commitFilesCache.clear();
  renderRepoList();
  await refresh();
}

function renderStashes(): void {
  const section = $('stash-section'), list = $('stash-list');
  clear(list);
  const stashes = state.snap?.stashes ?? [];
  section.hidden = !stashes.length;
  $('stash-label').textContent = `Stashes · ${stashes.length}`;
  for (const s of stashes) {
    const key = `${STASH}${s.index}`;
    list.appendChild(el('li', { class: state.selected === key ? 'selected' : '', title: s.message, onclick: () => selectRow(key) },
      s.message.replace(/^(On|WIP on) [^:]+: /, ''), el('span', { class: 'when' }, formatDate(s.date, state.settings.dateStyle))));
  }
}

// ---------- refresh ----------
async function refresh(): Promise<void> {
  if (!state.repo) { renderAll(); return; }
  const repo = state.repo;
  const snap = await busy(`Reading ${repo.name}`, () => git.snapshot(repo.path));
  if (!snap || state.repo?.path !== repo.path) return;
  state.snap = snap; state.commitFilesCache.clear();
  const hasChanges = snap.status.staged.length + snap.status.unstaged.length > 0;
  if (state.selected === WORKING && !hasChanges) state.selected = null;
  if (state.selected?.startsWith(STASH) && !snap.stashes.some((s) => `${STASH}${s.index}` === state.selected)) state.selected = null;
  if (state.selected && state.selected !== WORKING && !state.selected.startsWith(STASH) && !snap.commits.some((c) => c.hash === state.selected)) state.selected = null;
  if (!state.selected) state.selected = hasChanges ? WORKING : snap.commits[0]?.hash ?? null;
  renderAll();
}
function renderAll(): void { renderToolbar(); renderStashes(); renderGraph(); void renderDetails(); }

// ---------- toolbar, op strip, branch popover ----------
function renderToolbar(): void {
  const has = !!state.repo && !!state.snap;
  for (const id of ['branch-pill', 'btn-stash', 'btn-fetch', 'btn-pull', 'btn-push']) $<HTMLButtonElement>(id).disabled = !has;
  const title = $('repo-title'), ab = $('ahead-behind'), name = $('branch-name');
  const strip = $('op-strip');
  if (!has || !state.snap || !state.repo) { title.textContent = ''; ab.textContent = ''; name.textContent = 'No branch'; strip.hidden = true; return; }
  const st = state.snap.status;
  title.textContent = state.repo.name; title.title = state.repo.path;
  name.textContent = st.detached ? `detached at ${st.head?.slice(0, 7) ?? '?'}` : st.branch ?? 'No branch';
  ab.textContent = st.ahead || st.behind ? `${st.ahead ? '↑' + st.ahead : ''} ${st.behind ? '↓' + st.behind : ''}`.trim() : 'up to date';
  $<HTMLButtonElement>('btn-stash').disabled = st.staged.length + st.unstaged.length === 0;

  const op = state.snap.op;
  strip.hidden = !op;
  if (op) {
    const conflicts = st.unstaged.filter((f) => f.kind === 'conflict').length;
    const what = op.kind === 'rebase' ? `Rebasing ${op.detail ?? 'branch'}` : op.kind === 'merge' ? 'Merge in progress' : op.kind === 'cherry-pick' ? `Cherry-picking ${op.detail ?? ''}` : `Reverting ${op.detail ?? ''}`;
    $('op-text').textContent = conflicts ? `${what} · ${conflicts} conflict${conflicts === 1 ? '' : 's'} to resolve` : `${what} · all conflicts resolved`;
    $<HTMLButtonElement>('op-continue').disabled = conflicts > 0;
  }
  renderBranchLists();
}

function renderBranchLists(): void {
  const box = $('branch-lists'); clear(box);
  if (!state.snap || !state.repo) return;
  const q = $<HTMLInputElement>('branch-query').value.trim();
  const match = (n: string) => !q || n.toLowerCase().includes(q.toLowerCase());
  const local = state.snap.branches.filter((b) => !b.remote && match(b.name));
  const remote = state.snap.branches.filter((b) => b.remote && match(b.name));
  const current = state.snap.status.branch;
  const item = (name: string, isCurrent: boolean, isRemote: boolean) => {
    const d = el('div', { class: `item ${isCurrent ? 'current' : ''} ${isRemote ? 'remote' : ''}`, onclick: () => void checkout(name, isRemote) },
      el('span', { class: 'name' }, name), isCurrent ? el('span', { class: 'mark' }, 'current') : null);
    d.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); branchMenu(e.clientX, e.clientY, name, isCurrent, isRemote, current); });
    return d;
  };
  if (local.length) box.append(el('div', { class: 'label' }, 'Local'), ...local.map((b) => item(b.name, b.current, false)));
  if (remote.length) box.append(el('div', { class: 'label' }, 'Remote'), ...remote.map((b) => item(b.name, false, true)));
  const exists = state.snap.branches.some((b) => b.name === q);
  if (q && !exists) {
    const from = current ?? 'HEAD';
    box.append(el('div', { class: 'create' }, el('div', { class: 'item', onclick: () => void createBranch(q, null) }, el('span', { class: 'name' }, `Create branch “${q}” from ${from}`))));
  }
}
function branchMenu(x: number, y: number, name: string, isCurrent: boolean, isRemote: boolean, current: string | null): void {
  const here = current ?? 'HEAD';
  const items: MenuItem[] = [];
  if (!isCurrent) items.push({ label: isRemote ? `Checkout ${name} (track)` : `Checkout ${name}`, onClick: () => void checkout(name, isRemote) });
  if (!isCurrent) {
    items.push({ label: `Merge ${name} into ${here}`, onClick: () => void mergeBranch(name) });
    items.push({ label: `Rebase ${here} onto ${name}`, onClick: () => void rebaseOnto(name) });
    items.push({ sep: true, label: '' });
    items.push({ label: isRemote ? `Delete ${name} on the remote` : `Delete ${name}`, danger: true, onClick: () => void deleteBranch(name, isRemote) });
  } else {
    items.push({ label: 'This is the current branch', disabled: true });
  }
  setBranchOpen(false);
  showMenu(x, y, items);
}
function setBranchOpen(open: boolean): void {
  state.branchOpen = open;
  $('branch-pop').hidden = !open;
  if (open) { const i = $<HTMLInputElement>('branch-query'); i.value = ''; renderBranchLists(); i.focus(); }
}
async function checkout(name: string, remote: boolean): Promise<void> {
  if (!state.repo) return;
  setBranchOpen(false);
  const repo = state.repo.path;
  const local = remote ? name.replace(/^[^/]+\//, '') : name;
  await busy(`Switching to ${local}`, () => git.checkout(repo, name, remote), `Switched to ${local}`);
  await refresh();
}
async function createBranch(name: string, startPoint: string | null): Promise<void> {
  if (!state.repo) return;
  setBranchOpen(false);
  const repo = state.repo.path, from = startPoint ? startPoint.slice(0, 7) : state.snap?.status.branch ?? 'HEAD';
  await busy(`Creating ${name}`, () => git.createBranch(repo, name, startPoint), `Created ${name} from ${from}`);
  await refresh();
}
async function deleteBranch(name: string, remote: boolean): Promise<void> {
  if (!state.repo) return;
  const ok = await confirmSheet('Delete branch?', el('span', {}, remote ? 'This deletes ' : 'This deletes the local branch ', el('span', { class: 'mono' }, name), remote ? ' on the remote. Commits only on it stay reachable until the remote prunes them.' : '. Commits only on it are no longer listed, but stay in the repository until git prunes them.'), 'Delete');
  if (!ok) return;
  const repo = state.repo.path;
  await busy(`Deleting ${name}`, () => git.deleteBranch(repo, name, remote), `Deleted ${name}`);
  await refresh();
}
async function mergeBranch(name: string): Promise<void> {
  if (!state.repo) return;
  const repo = state.repo.path;
  const out = await busy(`Merging ${name}`, () => git.merge(repo, name));
  if (out !== undefined) toast(firstLine(out, `Merged ${name}`), /CONFLICT/.test(out));
  state.selected = null;
  await refresh();
}
async function rebaseOnto(name: string): Promise<void> {
  if (!state.repo) return;
  const repo = state.repo.path;
  const out = await busy(`Rebasing onto ${name}`, () => git.rebase(repo, name));
  if (out !== undefined) toast(firstLine(out, `Rebased onto ${name}`), /CONFLICT/.test(out));
  state.selected = null;
  await refresh();
}
function remoteAction(label: string, fn: (repo: string) => Promise<string>): () => Promise<void> {
  return async () => {
    if (!state.repo) return;
    const repo = state.repo.path;
    const out = await busy(label, () => fn(repo));
    if (out !== undefined) toast(out.trim().split('\n').pop() || `${label} done`);
    await refresh();
  };
}
async function stashChanges(): Promise<void> {
  if (!state.repo || !state.snap) return;
  const hasUntracked = state.snap.status.unstaged.some((f) => f.kind === 'untracked');
  const r = await promptSheet({ title: 'Stash changes', text: 'The working copy goes back to the last commit. Apply the stash later from the sidebar.', placeholder: 'Message (optional)', okLabel: 'Stash', allowEmpty: true, check: hasUntracked ? 'Include untracked files' : undefined, checked: true });
  if (!r) return;
  const repo = state.repo.path;
  await busy('Stashing', () => git.stashPush(repo, r.value, hasUntracked && r.checked), 'Stashed');
  state.selected = null; state.selectedFile = null;
  await refresh();
}
async function opContinue(): Promise<void> {
  if (!state.repo) return;
  const repo = state.repo.path;
  const out = await busy('Continuing', () => git.opContinue(repo));
  if (out !== undefined) toast(firstLine(out, 'Continued'), /CONFLICT|error/i.test(out));
  state.selected = null;
  await refresh();
}
async function opAbort(): Promise<void> {
  if (!state.repo || !state.snap?.op) return;
  const kind = state.snap.op.kind;
  const ok = await confirmSheet(`Abort the ${kind}?`, 'The working copy goes back to the state before it started.', 'Abort', 'Keep going');
  if (!ok) return;
  const repo = state.repo.path;
  await busy('Aborting', () => git.opAbort(repo), `${kind[0].toUpperCase()}${kind.slice(1)} aborted`);
  state.selected = null;
  await refresh();
}

// ---------- history ----------
const MAX_REFS = 3;
function refLabels(c: Commit): HTMLElement[] {
  // origin/HEAD only mirrors another ref; the chip row is capped so the subject stays readable.
  const refs = c.refs.filter((r) => !r.name.endsWith('/HEAD'));
  const shown = refs.slice(0, MAX_REFS).map((r) => el('span', { class: `ref ${r.kind}`, title: r.kind }, r.name));
  const rest = refs.slice(MAX_REFS);
  if (rest.length) shown.push(el('span', { class: 'ref more', title: rest.map((r) => r.name).join('\n') }, `+${rest.length}`));
  return shown;
}
function renderGraph(): void {
  const box = $('graph-scroll'); clear(box);
  if (!state.snap) return;
  const { commits, status } = state.snap;
  const hasChanges = status.staged.length + status.unstaged.length > 0;
  const nodes: GraphNode[] = [];
  if (hasChanges) nodes.push({ hash: WORKING, parents: status.head ? [status.head] : [] });
  for (const c of commits) nodes.push({ hash: c.hash, parents: c.parents });
  const { rows, width } = layoutGraph(nodes);
  const lanes = Math.min(width, 12);
  box.style.setProperty('--graph-w', `${graphWidth(lanes)}px`);
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  for (const row of rows) {
    const working = row.hash === WORKING;
    const c = byHash.get(row.hash);
    const head = !!c && c.refs.some((r) => r.kind === 'head');
    const div = el('div', { class: `row ${working ? 'working' : ''} ${state.selected === row.hash ? 'selected' : ''}`, onclick: () => selectRow(row.hash) });
    div.dataset.hash = row.hash;
    div.appendChild(renderRowSvg(row, lanes, { working, head }));
    if (working) {
      const n = status.staged.length + status.unstaged.length;
      div.append(el('div', { class: 'subject' }, el('span', { class: 'text' }, `Uncommitted changes · ${n} file${n === 1 ? '' : 's'}`)), el('div', { class: 'meta' }));
    } else if (c) {
      div.append(
        el('div', { class: 'subject' }, ...refLabels(c), el('span', { class: 'text', title: c.subject }, c.subject)),
        el('div', { class: 'meta', title: `${c.authorName} · ${formatDateLong(c.date)}` }, formatDate(c.date, state.settings.dateStyle)),
      );
      div.addEventListener('contextmenu', (e) => { e.preventDefault(); selectRow(c.hash); commitMenu(e.clientX, e.clientY, c); });
    }
    box.appendChild(div);
  }
  if (!rows.length) box.appendChild(el('div', { class: 'row empty' }, 'No commits yet.'));
}
function commitMenu(x: number, y: number, c: Commit): void {
  const short = c.hash.slice(0, 7);
  const branch = state.snap?.status.branch ?? 'HEAD';
  const isHead = c.refs.some((r) => r.kind === 'head');
  const tags = c.refs.filter((r) => r.kind === 'tag').map((r) => r.name);
  const items: MenuItem[] = [
    { label: `Cherry-pick ${short} into ${branch}`, disabled: isHead, onClick: () => void cherryPick(c) },
    { label: 'Create branch here…', onClick: () => void branchAt(c) },
    { label: 'Create tag here…', onClick: () => void tagAt(c) },
    { label: `Checkout ${short} (detached)`, disabled: isHead, onClick: () => void checkoutCommit(c) },
    { sep: true, label: '' },
    { label: 'Copy hash', onClick: () => { void navigator.clipboard.writeText(c.hash); toast(`Copied ${short}`); } },
  ];
  for (const t of tags) {
    items.push({ sep: true, label: '' });
    items.push({ label: `Push tag ${t}`, onClick: () => void pushTag(t) });
    items.push({ label: `Delete tag ${t}`, danger: true, onClick: () => void deleteTag(t) });
  }
  showMenu(x, y, items);
}
async function cherryPick(c: Commit): Promise<void> {
  if (!state.repo) return;
  const repo = state.repo.path;
  const out = await busy(`Cherry-picking ${c.hash.slice(0, 7)}`, () => git.cherryPick(repo, c.hash));
  if (out !== undefined) toast(firstLine(out, `Picked ${c.hash.slice(0, 7)}`), /CONFLICT/.test(out));
  state.selected = null;
  await refresh();
}
async function branchAt(c: Commit): Promise<void> {
  const r = await promptSheet({ title: 'New branch', text: `Starts at ${c.hash.slice(0, 7)} · ${c.subject}`, placeholder: 'feature/my-change', okLabel: 'Create and checkout' });
  if (r) await createBranch(r.value, c.hash);
}
async function tagAt(c: Commit): Promise<void> {
  if (!state.repo) return;
  const r = await promptSheet({ title: 'New tag', text: `Tags ${c.hash.slice(0, 7)} · ${c.subject}. A tag with a message is an annotated tag.`, placeholder: 'v1.0.0', okLabel: 'Create tag', check: 'Add a message', checked: false });
  if (!r) return;
  let message: string | null = null;
  if (r.checked) {
    const m = await promptSheet({ title: `Message for ${r.value}`, placeholder: 'Release notes in one line', okLabel: 'Create tag' });
    if (!m) return;
    message = m.value;
  }
  const repo = state.repo.path;
  await busy(`Tagging ${r.value}`, () => git.createTag(repo, r.value, c.hash, message), `Tagged ${c.hash.slice(0, 7)} as ${r.value}`);
  await refresh();
}
async function deleteTag(name: string): Promise<void> {
  if (!state.repo) return;
  const ok = await confirmSheet('Delete tag?', el('span', {}, 'The local tag ', el('span', { class: 'mono' }, name), ' is removed. A copy already pushed to a remote stays there.'), 'Delete');
  if (!ok) return;
  const repo = state.repo.path;
  await busy(`Deleting ${name}`, () => git.deleteTag(repo, name), `Deleted tag ${name}`);
  await refresh();
}
async function pushTag(name: string): Promise<void> {
  if (!state.repo) return;
  const repo = state.repo.path;
  const out = await busy(`Pushing ${name}`, () => git.pushTag(repo, name));
  if (out !== undefined) toast(`Pushed tag ${name}`);
}
async function checkoutCommit(c: Commit): Promise<void> {
  if (!state.repo) return;
  const repo = state.repo.path;
  await busy(`Checking out ${c.hash.slice(0, 7)}`, () => git.checkoutCommit(repo, c.hash), `At ${c.hash.slice(0, 7)} (detached)`);
  await refresh();
}

function selectRow(hash: string): void {
  if (state.selected === hash) return;
  state.selected = hash; state.selectedFile = null;
  for (const r of Array.from($('graph-scroll').children)) r.classList.toggle('selected', (r as HTMLElement).dataset.hash === hash);
  renderStashes();
  void renderDetails();
}
function moveSelection(delta: number): void {
  const rows = Array.from($('graph-scroll').children) as HTMLElement[];
  const i = rows.findIndex((r) => r.dataset.hash === state.selected);
  const next = rows[Math.max(0, Math.min(rows.length - 1, i + delta))];
  if (next?.dataset.hash) { selectRow(next.dataset.hash); next.scrollIntoView({ block: 'nearest' }); }
}

// ---------- details ----------
const LETTERS: Record<FileChange['kind'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', untracked: '?', conflict: 'U', typechange: 'T', unknown: '·' };
function badge(kind: FileChange['kind']): HTMLElement { return el('span', { class: `badge ${kind}`, title: kind }, LETTERS[kind]); }
function pathSpan(path: string, oldPath?: string): HTMLElement {
  const i = path.lastIndexOf('/');
  return el('span', { class: 'path' },
    oldPath ? el('span', { class: 'old' }, `${oldPath} → `) : null,
    i >= 0 ? el('span', { class: 'dir' }, path.slice(0, i + 1)) : null,
    path.slice(i + 1));
}
function fileRow(f: FileChange, key: string, target: DiffTarget, actions: HTMLElement[] = []): HTMLElement {
  const label = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
  const li = el('li', { class: state.selectedFile?.key === key ? 'selected' : '', title: label, onclick: () => void selectFile(key, target, label) },
    badge(f.kind), pathSpan(f.path, f.oldPath), actions.length ? el('span', { class: 'actions' }, ...actions) : null);
  li.dataset.key = key;
  return li;
}
function sectionTitle(text: string, action?: HTMLElement | null): HTMLElement {
  return el('div', { class: 'section-title' }, el('span', { class: 'label' }, text), action ?? el('span'));
}

async function renderDetails(): Promise<void> {
  const box = $('details'); clear(box); box.classList.remove('working');
  if (!state.snap || !state.repo || !state.selected) { box.appendChild(el('div', { class: 'muted' }, 'Select a commit to see its details.')); renderFile(); return; }
  if (state.selected === WORKING) { box.classList.add('working'); renderWorkingDetails(box); renderFile(); return; }
  if (state.selected.startsWith(STASH)) {
    const s = state.snap.stashes.find((x) => `${STASH}${x.index}` === state.selected);
    if (s) await renderStashDetails(box, s);
    return;
  }
  const c = state.snap.commits.find((x) => x.hash === state.selected);
  if (!c) return;

  box.append(
    el('div', {}, el('div', { class: 'commit-subject' }, c.subject), c.body && c.body !== c.subject ? el('div', { class: 'commit-body' }, c.body.startsWith(c.subject) ? c.body.slice(c.subject.length).trim() : c.body) : null),
    el('div', { class: 'commit-meta' },
      el('span', { title: c.authorEmail }, c.authorName),
      el('span', {}, formatDateLong(c.date)),
      el('span', { class: 'mono', title: c.hash }, c.hash.slice(0, 7)),
      c.parents.length ? el('span', { class: 'parents' }, el('span', {}, c.parents.length > 1 ? 'parents' : 'parent'),
        ...c.parents.map((p) => el('a', { href: '#', onclick: (e) => { e.preventDefault(); selectRow(p); } }, p.slice(0, 7)))) : null,
    ),
  );
  await renderCommitFiles(box, c.hash, c.parents[0] ?? null, c.hash);
}

async function renderCommitFiles(box: HTMLElement, ref: string, parent: string | null, cacheKey: string): Promise<void> {
  const count = el('span', { class: 'label' }, '');
  const list = el('ul', { class: 'files' }, el('li', { class: 'empty' }, 'Loading…'));
  box.append(el('div', {}, sectionTitle('Changed files', count), list));
  const files = await loadFiles(cacheKey, ref, parent);
  if (state.selected !== cacheKey && !(state.selected?.startsWith(STASH) && cacheKey === state.selected)) return;
  clear(list);
  count.textContent = String(files.length);
  if (!files.length) list.appendChild(el('li', { class: 'empty' }, 'No file changes.'));
  const target = (f: FileChange): DiffTarget => ({ kind: 'commit', hash: ref, parent, path: f.path, oldPath: f.oldPath });
  for (const f of files) list.appendChild(fileRow(f, `${cacheKey}:${f.path}`, target(f)));
  if (!state.selectedFile && files.length) void selectFile(`${cacheKey}:${files[0].path}`, target(files[0]), files[0].path);
  else renderFile();
}

async function loadFiles(cacheKey: string, ref: string, parent: string | null): Promise<FileChange[]> {
  const cached = state.commitFilesCache.get(cacheKey);
  if (cached) return cached;
  if (!state.repo) return [];
  try {
    const files = await git.commitFiles(state.repo.path, ref, parent);
    state.commitFilesCache.set(cacheKey, files);
    return files;
  } catch (e) { toast(`Could not list files: ${errText(e)}`, true); return []; }
}

async function renderStashDetails(box: HTMLElement, s: StashEntry): Promise<void> {
  if (!state.repo) return;
  const repo = state.repo.path;
  const act = (label: string, fn: () => Promise<unknown>, cls = '') => el('button', { class: `link ${cls}`, onclick: () => void fn() }, label);
  box.append(
    el('div', {}, el('div', { class: 'commit-subject' }, s.message), el('div', { class: 'commit-body' }, `${s.ref} · ${formatDateLong(s.date)}`)),
    el('div', { class: 'commit-meta' },
      act('Apply', async () => { const out = await busy('Applying stash', () => git.stashApply(repo, s.index, false)); if (out !== undefined) toast(/CONFLICT/.test(out) ? firstLine(out, 'Applied with conflicts') : 'Stash applied', /CONFLICT/.test(out)); state.selected = null; await refresh(); }),
      act('Pop', async () => { const out = await busy('Popping stash', () => git.stashApply(repo, s.index, true)); if (out !== undefined) toast(/CONFLICT/.test(out) ? firstLine(out, 'Applied with conflicts; stash kept') : 'Stash applied and dropped', /CONFLICT/.test(out)); state.selected = null; await refresh(); }),
      act('Drop', async () => { const ok = await confirmSheet('Drop stash?', el('span', {}, el('span', { class: 'mono' }, s.message), ' is deleted. This can’t be undone.'), 'Drop'); if (!ok) return; await busy('Dropping stash', () => git.stashDrop(repo, s.index), 'Stash dropped'); state.selected = null; await refresh(); }, 'danger'),
    ),
  );
  await renderCommitFiles(box, s.ref, `${s.ref}^`, `${STASH}${s.index}`);
}

function workingTarget(f: FileChange, staged: boolean): DiffTarget {
  if (staged) return { kind: 'staged', path: f.path, oldPath: f.oldPath };
  if (f.kind === 'conflict') return { kind: 'conflict', path: f.path };
  if (f.kind === 'untracked') return { kind: 'untracked', path: f.path };
  return { kind: 'unstaged', path: f.path };
}

function renderWorkingDetails(box: HTMLElement): void {
  if (!state.snap || !state.repo) return;
  const repo = state.repo.path;
  const { staged, unstaged } = state.snap.status;
  const op = state.snap.op;
  const branch = state.snap.status.branch ?? 'HEAD';
  const act = (label: string, fn: () => Promise<unknown>, cls = '', done?: string) =>
    el('button', { class: `link ${cls}`, onclick: (e) => { e.stopPropagation(); void busy(label, fn, done).then(refresh); } }, label);

  const stagedList = el('ul', { class: 'files' });
  if (!staged.length) stagedList.appendChild(el('li', { class: 'empty' }, 'Nothing staged yet.'));
  for (const f of staged) {
    stagedList.appendChild(fileRow(f, `staged:${f.path}`, workingTarget(f, true),
      [act('Unstage', () => git.unstage(repo, [f.path, ...(f.oldPath ? [f.oldPath] : [])]))]));
  }
  const unstagedList = el('ul', { class: 'files' });
  if (!unstaged.length) unstagedList.appendChild(el('li', { class: 'empty' }, 'Working copy is clean.'));
  const oursLabel = op?.kind === 'rebase' ? `Keep ${op.detail ?? 'my branch'}` : `Keep ${branch}`;
  const theirsLabel = op?.kind === 'rebase' ? 'Take upstream' : op?.kind === 'merge' ? 'Take incoming' : op ? 'Take picked commit' : 'Take theirs';
  for (const f of unstaged) {
    const actions = f.kind === 'conflict'
      ? [
          act(oursLabel, () => git.resolve(repo, [f.path], 'ours'), 'resolve', `Kept ${oursLabel.replace(/^Keep /, '')} for ${f.path}`),
          act(theirsLabel, () => git.resolve(repo, [f.path], 'theirs'), 'resolve', `Took the other side for ${f.path}`),
          act('Mark resolved', () => git.markResolved(repo, [f.path]), 'resolve', `${f.path} marked resolved`),
        ]
      : [
          act('Stage', () => git.stage(repo, [f.path])),
          act('Discard', async () => {
            const ok = await confirmSheet('Discard changes?', el('span', {}, 'Changes to ', el('span', { class: 'mono' }, f.path), ' will be lost. This can’t be undone.'));
            if (ok) { await git.discard(repo, [f]); toast(`Discarded ${f.path}`); }
          }, 'danger'),
        ];
    unstagedList.appendChild(fileRow(f, `unstaged:${f.path}`, workingTarget(f, false), actions));
  }

  const msg = el('textarea', { placeholder: 'Describe the change', rows: '3' }) as HTMLTextAreaElement;
  const hint = el('span', { class: 'hint' });
  const commitBtn = el('button', { class: 'primary' }, staged.length ? `Commit ${staged.length} file${staged.length === 1 ? '' : 's'}` : 'Commit') as HTMLButtonElement;
  const conflicts = unstaged.filter((f) => f.kind === 'conflict').length;
  const update = () => {
    const ok = staged.length > 0 && msg.value.trim().length > 0 && !op;
    commitBtn.disabled = !ok;
    hint.textContent = op ? (conflicts ? 'Resolve the conflicts, then Continue above' : 'Use Continue above to finish') : !staged.length ? 'Stage files to commit them' : !msg.value.trim() ? 'Add a message to commit' : `Commits to ${branch}`;
  };
  msg.value = state.commitDraft;
  msg.addEventListener('input', () => { state.commitDraft = msg.value; update(); }); update();
  commitBtn.addEventListener('click', () => {
    const text = msg.value.trim(); if (!text || !staged.length) return;
    const n = staged.length;
    void busy('Committing', async () => { await git.commit(repo, text); state.commitDraft = ''; }, `Committed ${n} file${n === 1 ? '' : 's'} to ${branch}`).then(refresh);
  });

  box.append(
    el('div', {}, sectionTitle(`Staged · ${staged.length}`, staged.length ? act('Unstage all', () => git.unstage(repo, staged.map((f) => f.path))) : null), stagedList),
    el('div', {}, sectionTitle(`Changes · ${unstaged.length}`, unstaged.length && !conflicts ? act('Stage all', () => git.stage(repo, unstaged.map((f) => f.path))) : null), unstagedList),
    el('div', { class: 'commit-box' }, msg, el('div', { class: 'row2' }, hint, commitBtn)),
  );

  if (!state.selectedFile) {
    const first = staged[0] ? { f: staged[0], s: true } : unstaged[0] ? { f: unstaged[0], s: false } : null;
    if (first) void selectFile(`${first.s ? 'staged' : 'unstaged'}:${first.f.path}`, workingTarget(first.f, first.s), first.f.path);
  } else {
    // Re-point the selection after a partial stage moved lines between the two lists.
    const key = state.selectedFile.key;
    const inStaged = staged.find((f) => `staged:${f.path}` === key), inUnstaged = unstaged.find((f) => `unstaged:${f.path}` === key);
    if (inStaged) void selectFile(key, workingTarget(inStaged, true), inStaged.path);
    else if (inUnstaged) void selectFile(key, workingTarget(inUnstaged, false), inUnstaged.path);
    else {
      const p = key.replace(/^(staged|unstaged):/, '');
      const other = staged.find((f) => f.path === p) ? { f: staged.find((f) => f.path === p)!, s: true } : unstaged.find((f) => f.path === p) ? { f: unstaged.find((f) => f.path === p)!, s: false } : null;
      if (other) void selectFile(`${other.s ? 'staged' : 'unstaged'}:${other.f.path}`, workingTarget(other.f, other.s), other.f.path);
      else { state.selectedFile = null; renderFile(); }
    }
  }
}

// ---------- diff ----------
async function selectFile(key: string, target: DiffTarget, label: string): Promise<void> {
  state.selectedFile = { key, target, label };
  for (const li of Array.from(document.querySelectorAll<HTMLElement>('#details .files li'))) li.classList.toggle('selected', li.dataset.key === key);
  renderFile();
  if (!state.repo) return;
  const repo = state.repo.path, view = $('diff-view');
  clear(view); view.appendChild(el('div', { class: 'diff-empty' }, 'Loading…'));
  try {
    const text = await git.diff(repo, target);
    if (state.selectedFile?.key !== key) return;
    clear(view);
    view.appendChild(target.kind === 'conflict' ? renderConflict(text, target.path, state.settings.highlight) : renderDiff(text, {
      layout: state.settings.diffLayout,
      highlight: state.settings.highlight,
      path: target.path,
      actions: target.kind === 'staged' || target.kind === 'unstaged'
        ? { primary: target.kind === 'staged' ? 'unstage' : 'stage', discard: target.kind === 'unstaged', onPatch: (action, patch) => void applyPatch(action, patch, target.path) }
        : null,
    }));
  } catch (e) {
    if (state.selectedFile?.key !== key) return;
    clear(view); view.appendChild(el('div', { class: 'diff-empty' }, `Could not load diff: ${errText(e)}`));
  }
}
async function applyPatch(action: PatchAction, patch: string, path: string): Promise<void> {
  if (!state.repo) return;
  if (action === 'discard') {
    const ok = await confirmSheet('Discard these lines?', el('span', {}, 'The selected changes in ', el('span', { class: 'mono' }, path), ' are lost. This can’t be undone.'));
    if (!ok) return;
  }
  const repo = state.repo.path;
  const labels: Record<PatchAction, string> = { stage: 'Staging', unstage: 'Unstaging', discard: 'Discarding' };
  await busy(labels[action], () => git.applyPatch(repo, patch, action));
  await refresh();
}
function renderFile(): void {
  const title = $('file-title'), where = $('file-where'), view = $('diff-view');
  clear(title);
  for (const b of Array.from($('layout-seg').querySelectorAll<HTMLButtonElement>('button'))) b.classList.toggle('on', b.dataset.value === state.settings.diffLayout);
  if (!state.selectedFile) { title.textContent = 'No file selected'; where.textContent = ''; clear(view); view.appendChild(el('div', { class: 'diff-empty' }, 'Select a file to see its changes.')); return; }
  const t = state.selectedFile.target;
  title.appendChild(pathSpan(t.path, 'oldPath' in t ? t.oldPath : undefined));
  where.textContent = t.kind === 'commit' ? (t.hash.startsWith('stash@') ? t.hash : t.hash.slice(0, 7)) : t.kind === 'staged' ? 'staged' : t.kind === 'conflict' ? 'conflict' : 'working copy';
}
function reloadDiff(): void {
  if (state.selectedFile) void selectFile(state.selectedFile.key, state.selectedFile.target, state.selectedFile.label);
}

// ---------- settings ----------
function renderSettings(): void {
  const s = state.settings;
  for (const seg of Array.from(document.querySelectorAll<HTMLElement>('#settings .seg'))) {
    const k = seg.dataset.setting as keyof Settings;
    for (const b of Array.from(seg.querySelectorAll<HTMLButtonElement>('button'))) b.classList.toggle('on', String(s[k]) === b.dataset.value);
  }
  const sw = document.querySelector<HTMLElement>('#settings .swatches')!; clear(sw);
  for (const a of ACCENTS) {
    sw.appendChild(el('button', { class: a.color === s.accent ? 'on' : '', title: a.label, style: `background:${a.color};color:${a.color}`, onclick: () => setSetting('accent', a.color) }));
  }
}
function setSetting<K extends keyof Settings>(k: K, v: Settings[K]): void {
  state.settings = { ...state.settings, [k]: v };
  saveSettings(state.settings); applySettings(state.settings); renderSettings();
  if (k === 'dateStyle') { renderGraph(); renderStashes(); }
  if (k === 'diffLayout' || k === 'highlight') { renderFile(); reloadDiff(); }
}
function parseSettingValue(k: keyof Settings, v: string): Settings[keyof Settings] {
  if (k === 'diffSize') return Number(v);
  if (k === 'highlight') return v === 'true';
  return v as never;
}

// ---------- splitters ----------
function initSplitters(): void {
  const root = document.documentElement, columns = $('columns');
  const sv = document.querySelector<HTMLElement>('.splitter.v');
  sv?.addEventListener('pointerdown', (e) => {
    e.preventDefault(); sv.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => { const rect = columns.getBoundingClientRect(); root.style.setProperty('--w-right', `${Math.max(240, Math.min(rect.width - 420, rect.right - ev.clientX - 14))}px`); columns.style.gridTemplateColumns = `minmax(0,1fr) 12px var(--w-right)`; };
    const up = () => { sv.removeEventListener('pointermove', move); sv.removeEventListener('pointerup', up); };
    sv.addEventListener('pointermove', move); sv.addEventListener('pointerup', up);
  });
  const hs = document.querySelector<HTMLElement>('.splitter.h'), middle = $('col-middle');
  hs?.addEventListener('pointerdown', (e) => {
    e.preventDefault(); hs.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => { const rect = middle.getBoundingClientRect(); root.style.setProperty('--h-graph', `${Math.max(120, Math.min(rect.height - 220, ev.clientY - rect.top))}px`); };
    const up = () => { hs.removeEventListener('pointermove', move); hs.removeEventListener('pointerup', up); };
    hs.addEventListener('pointermove', move); hs.addEventListener('pointerup', up);
  });
}

// ---------- init ----------
async function init(): Promise<void> {
  applySettings(state.settings);
  renderSettings();
  initSplitters();
  git.onAskpass(onAskpass);
  const addRepo = async () => {
    const entry = await busy('Adding repository', () => git.addRepo());
    if (!entry) return;
    state.repos = await git.listRepos(); renderRepoList();
    toast(`Added ${entry.name}`);
    await selectRepo(entry);
  };
  $('btn-add-repo').addEventListener('click', () => void addRepo());
  $('btn-add-repo-empty').addEventListener('click', () => void addRepo());
  $('btn-stash').addEventListener('click', () => void stashChanges());
  $('btn-fetch').addEventListener('click', remoteAction('Fetching', (r) => git.fetch(r)));
  $('btn-pull').addEventListener('click', remoteAction('Pulling', (r) => git.pull(r)));
  $('btn-push').addEventListener('click', remoteAction('Pushing', (r) => git.push(r)));
  $('op-continue').addEventListener('click', () => void opContinue());
  $('op-abort').addEventListener('click', () => void opAbort());
  $('branch-pill').addEventListener('click', (e) => { e.stopPropagation(); setBranchOpen(!state.branchOpen); });
  $('branch-pop').addEventListener('click', (e) => e.stopPropagation());
  $('branch-query').addEventListener('input', renderBranchLists);
  $('branch-query').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const q = (e.target as HTMLInputElement).value.trim(); if (q && !state.snap?.branches.some((b) => b.name === q)) void createBranch(q, null); }
  });
  document.addEventListener('click', () => { if (state.branchOpen) setBranchOpen(false); hideMenu(); });
  document.addEventListener('contextmenu', () => hideMenu());
  $('menu').addEventListener('click', (e) => e.stopPropagation());
  $('btn-settings').addEventListener('click', () => ($('settings').hidden = false));
  $('settings-done').addEventListener('click', () => ($('settings').hidden = true));
  $('settings').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('settings').hidden = true; });
  for (const seg of Array.from(document.querySelectorAll<HTMLElement>('#settings .seg'))) {
    seg.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button'); if (!b) return;
      const k = seg.dataset.setting as keyof Settings;
      setSetting(k, parseSettingValue(k, b.dataset.value!) as never);
    });
  }
  $('layout-seg').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button'); if (!b) return;
    setSetting('diffLayout', b.dataset.value as Settings['diffLayout']);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setBranchOpen(false); hideMenu(); $('settings').hidden = true; }
  });
  $('graph-scroll').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
  });
  window.addEventListener('focus', () => { if (state.repo && state.busy === 0) void refresh(); });

  state.repos = await git.listRepos();
  renderRepoList(); renderAll();
  if (state.repos.length) await selectRepo(state.repos[0]);
}
void init();
