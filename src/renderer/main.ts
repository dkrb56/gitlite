import type { Commit, DiffTarget, FileChange, GitApi, RepoEntry, RepoSnapshot } from '../shared/types';
import { $, ask, clear, el, formatDate } from './dom';
import { renderDiff } from './diff';
import { LANE_W, layoutGraph, renderRowSvg, type GraphNode } from './graph';

declare global {
  interface Window {
    git: GitApi;
  }
}
const git = window.git;

const WORKING = '@working';

interface State {
  repos: RepoEntry[];
  repo: RepoEntry | null;
  snap: RepoSnapshot | null;
  selected: string | null; // commit hash or WORKING
  selectedFile: { key: string; target: DiffTarget; label: string } | null;
  commitFilesCache: Map<string, FileChange[]>;
  busy: number;
}

const state: State = {
  repos: [],
  repo: null,
  snap: null,
  selected: null,
  selectedFile: null,
  commitFilesCache: new Map(),
  busy: 0,
};

// ---------- status / busy ----------

function setStatus(text: string, isError = false): void {
  $('status-text').textContent = text;
  $('statusbar').classList.toggle('error', isError);
}

async function busy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  state.busy++;
  $('busy').hidden = false;
  setStatus(label);
  try {
    const result = await fn();
    setStatus(`${label}: done`);
    return result;
  } catch (e) {
    setStatus(`${label} failed: ${e instanceof Error ? e.message : String(e)}`, true);
    return undefined;
  } finally {
    state.busy--;
    if (state.busy === 0) $('busy').hidden = true;
  }
}

// ---------- repositories (column 1) ----------

function renderRepoList(): void {
  const list = $('repo-list');
  clear(list);
  if (!state.repos.length) {
    list.appendChild(el('li', { class: 'empty' }, 'No repositories yet. Add one below.'));
    return;
  }
  for (const r of state.repos) {
    const li = el(
      'li',
      { class: state.repo?.path === r.path ? 'selected' : '', title: r.path, onclick: () => void selectRepo(r) },
      el('span', { class: 'name' }, r.name),
      el(
        'span',
        {
          class: 'remove',
          title: 'Remove from list',
          onclick: (e) => {
            e.stopPropagation();
            void removeRepo(r);
          },
        },
        '✕',
      ),
    );
    list.appendChild(li);
  }
}

async function removeRepo(r: RepoEntry): Promise<void> {
  state.repos = await git.removeRepo(r.path);
  if (state.repo?.path === r.path) {
    state.repo = null;
    state.snap = null;
    state.selected = null;
    state.selectedFile = null;
    renderAll();
  }
  renderRepoList();
}

async function selectRepo(r: RepoEntry): Promise<void> {
  state.repo = r;
  state.selected = null;
  state.selectedFile = null;
  state.commitFilesCache.clear();
  renderRepoList();
  await refresh();
}

// ---------- refresh ----------

async function refresh(): Promise<void> {
  if (!state.repo) {
    renderAll();
    return;
  }
  const repo = state.repo;
  const snap = await busy(`Reading ${repo.name}`, () => git.snapshot(repo.path));
  if (!snap || state.repo?.path !== repo.path) return;
  state.snap = snap;
  state.commitFilesCache.clear();
  const hasChanges = snap.status.staged.length + snap.status.unstaged.length > 0;
  if (state.selected === WORKING && !hasChanges) state.selected = null;
  if (state.selected && state.selected !== WORKING && !snap.commits.some((c) => c.hash === state.selected)) {
    state.selected = null;
  }
  if (!state.selected) state.selected = hasChanges ? WORKING : snap.commits[0]?.hash ?? null;
  renderAll();
}

function renderAll(): void {
  renderToolbar();
  renderGraph();
  void renderDetails();
}

// ---------- toolbar ----------

function renderToolbar(): void {
  const has = !!state.repo && !!state.snap;
  for (const id of ['btn-new-branch', 'btn-fetch', 'btn-pull', 'btn-push', 'btn-refresh']) {
    $<HTMLButtonElement>(id).disabled = !has;
  }
  const sel = $<HTMLSelectElement>('branch-select');
  sel.disabled = !has;
  clear(sel);
  const title = $('repo-title');
  if (!has || !state.snap || !state.repo) {
    title.textContent = 'No repository selected';
    title.classList.add('muted');
    return;
  }
  title.classList.remove('muted');
  const st = state.snap.status;
  const ab = st.ahead || st.behind ? `  ↑${st.ahead} ↓${st.behind}` : '';
  title.textContent = `${state.repo.name}${ab}`;
  title.title = state.repo.path;

  const local = state.snap.branches.filter((b) => !b.remote);
  const remote = state.snap.branches.filter((b) => b.remote);
  if (st.detached) sel.appendChild(el('option', { value: '', selected: true }, `(detached at ${st.head?.slice(0, 7) ?? '?'})`));
  const lg = el('optgroup', { label: 'Local' });
  for (const b of local) lg.appendChild(el('option', { value: `local:${b.name}`, selected: b.current }, b.name));
  sel.appendChild(lg);
  if (remote.length) {
    const rg = el('optgroup', { label: 'Remote' });
    for (const b of remote) rg.appendChild(el('option', { value: `remote:${b.name}` }, b.name));
    sel.appendChild(rg);
  }
  sel.dataset.current = sel.value;
}

async function onBranchChange(): Promise<void> {
  const sel = $<HTMLSelectElement>('branch-select');
  const value = sel.value;
  if (!state.repo || !value || value === sel.dataset.current) return;
  const [kind, ...rest] = value.split(':');
  const name = rest.join(':');
  const repo = state.repo.path;
  const ok = await busy(`Checkout ${name}`, async () => {
    await git.checkout(repo, name, kind === 'remote');
    return true;
  });
  if (!ok) sel.value = sel.dataset.current ?? '';
  await refresh();
}

async function onNewBranch(): Promise<void> {
  if (!state.repo) return;
  const name = await ask('New branch name (created from HEAD)', 'feature/my-change');
  if (!name) return;
  const repo = state.repo.path;
  await busy(`Create branch ${name}`, () => git.createBranch(repo, name, null));
  await refresh();
}

function remoteAction(label: string, fn: (repo: string) => Promise<string>): () => Promise<void> {
  return async () => {
    if (!state.repo) return;
    const repo = state.repo.path;
    const out = await busy(label, () => fn(repo));
    if (out !== undefined) setStatus(`${label}: ${out.trim().split('\n').pop() || 'done'}`);
    await refresh();
  };
}

// ---------- graph (column 2, top) ----------

function refLabels(c: Commit): HTMLElement[] {
  return c.refs.map((r) => el('span', { class: `ref ${r.kind}`, title: r.kind }, r.name));
}

function renderGraph(): void {
  const tbody = $('graph-table').querySelector('tbody') as HTMLTableSectionElement;
  clear(tbody);
  if (!state.snap) return;
  const { commits, status } = state.snap;
  const hasChanges = status.staged.length + status.unstaged.length > 0;

  const nodes: GraphNode[] = [];
  if (hasChanges) nodes.push({ hash: WORKING, parents: status.head ? [status.head] : [] });
  for (const c of commits) nodes.push({ hash: c.hash, parents: c.parents });
  const { rows, width } = layoutGraph(nodes);
  $('graph-table').style.setProperty('--graph-w', `${Math.min(width, 12) * LANE_W + 8}px`);

  const byHash = new Map(commits.map((c) => [c.hash, c]));
  rows.forEach((row) => {
    const working = row.hash === WORKING;
    const c = byHash.get(row.hash);
    const tr = el('tr', {
      class: `${working ? 'working' : ''} ${state.selected === row.hash ? 'selected' : ''}`,
      onclick: () => selectRow(row.hash),
    });
    tr.dataset.hash = row.hash;
    const graphCell = el('td', { class: 'graph' });
    graphCell.appendChild(renderRowSvg(row, Math.min(width, 12), working));
    tr.appendChild(graphCell);
    if (working) {
      const n = status.staged.length + status.unstaged.length;
      tr.append(
        el('td', { class: 'subject' }, `Uncommitted changes (${n} file${n === 1 ? '' : 's'})`),
        el('td', { class: 'author' }),
        el('td', { class: 'date' }),
        el('td', { class: 'hash' }),
      );
    } else if (c) {
      tr.append(
        el('td', { class: 'subject', title: c.subject }, ...refLabels(c), c.subject),
        el('td', { class: 'author', title: c.authorEmail }, c.authorName),
        el('td', { class: 'date' }, formatDate(c.date)),
        el('td', { class: 'hash' }, c.hash.slice(0, 7)),
      );
    }
    tbody.appendChild(tr);
  });
  if (!rows.length) {
    tbody.appendChild(el('tr', {}, el('td', { class: 'subject muted' }, 'No commits yet.')));
  }
}

function selectRow(hash: string): void {
  if (state.selected === hash) return;
  state.selected = hash;
  state.selectedFile = null;
  const tbody = $('graph-table').querySelector('tbody') as HTMLTableSectionElement;
  for (const tr of Array.from(tbody.rows)) tr.classList.toggle('selected', tr.dataset.hash === hash);
  void renderDetails();
}

function moveSelection(delta: number): void {
  const tbody = $('graph-table').querySelector('tbody') as HTMLTableSectionElement;
  const rows = Array.from(tbody.rows);
  const i = rows.findIndex((r) => r.dataset.hash === state.selected);
  const next = rows[Math.max(0, Math.min(rows.length - 1, i + delta))];
  if (next?.dataset.hash) {
    selectRow(next.dataset.hash);
    next.scrollIntoView({ block: 'nearest' });
  }
}

// ---------- details (column 2, bottom) ----------

function badge(kind: FileChange['kind']): HTMLElement {
  const letters: Record<FileChange['kind'], string> = {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
    copied: 'C',
    untracked: '?',
    conflict: 'U',
    typechange: 'T',
    unknown: '·',
  };
  return el('span', { class: `badge ${kind}`, title: kind }, letters[kind]);
}

function fileRow(f: FileChange, key: string, target: DiffTarget, actions: HTMLElement[] = []): HTMLElement {
  const label = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
  const li = el(
    'li',
    {
      class: state.selectedFile?.key === key ? 'selected' : '',
      title: label,
      onclick: () => void selectFile(key, target, label),
    },
    badge(f.kind),
    el('span', { class: 'path' }, f.oldPath ? el('span', { class: 'old' }, `${f.oldPath} → `) : null, f.path),
    actions.length ? el('span', { class: 'actions' }, ...actions) : null,
  );
  return li;
}

async function renderDetails(): Promise<void> {
  const box = $('details');
  const title = $('details-title');
  clear(box);
  if (!state.snap || !state.repo || !state.selected) {
    title.textContent = 'Commit';
    box.appendChild(el('div', { class: 'muted' }, 'Select a commit to see its details.'));
    renderFile();
    return;
  }
  if (state.selected === WORKING) {
    title.textContent = 'Working copy';
    renderWorkingDetails(box);
    renderFile();
    return;
  }
  const c = state.snap.commits.find((x) => x.hash === state.selected);
  if (!c) return;
  title.textContent = `Commit ${c.hash.slice(0, 7)}`;

  const head = el('div', { class: 'detail-head' });
  const kv = (k: string, v: Node | string, mono = false) =>
    head.append(el('span', { class: 'k' }, k), el('span', { class: `v ${mono ? 'mono' : ''}` }, v));
  kv('Hash', c.hash, true);
  kv('Author', `${c.authorName} <${c.authorEmail}>`);
  kv('Date', formatDate(c.date));
  kv(
    'Parents',
    el(
      'span',
      {},
      ...c.parents.map((p) =>
        el('a', { href: '#', class: 'mono', onclick: (e) => (e.preventDefault(), selectRow(p)) }, `${p.slice(0, 7)} `),
      ),
    ),
    true,
  );
  if (c.refs.length) kv('Refs', el('span', {}, ...refLabels(c)));
  box.append(head, el('div', { class: 'message' }, c.body || c.subject));

  const section = el('div', { class: 'section-title' }, 'Changed files');
  const list = el('ul', { class: 'files' }, el('li', { class: 'empty' }, 'Loading…'));
  box.append(section, list);

  const files = await loadCommitFiles(c);
  if (state.selected !== c.hash) return;
  clear(list);
  if (!files.length) list.appendChild(el('li', { class: 'empty' }, 'No file changes.'));
  const parent = c.parents[0] ?? null;
  for (const f of files) {
    const key = `${c.hash}:${f.path}`;
    list.appendChild(fileRow(f, key, { kind: 'commit', hash: c.hash, parent, path: f.path, oldPath: f.oldPath }));
  }
  section.append(el('span', { class: 'spacer' }), el('span', {}, `${files.length}`));
  if (!state.selectedFile && files.length) {
    const f = files[0];
    void selectFile(`${c.hash}:${f.path}`, { kind: 'commit', hash: c.hash, parent, path: f.path, oldPath: f.oldPath }, f.path);
  } else {
    renderFile();
  }
}

async function loadCommitFiles(c: Commit): Promise<FileChange[]> {
  const cached = state.commitFilesCache.get(c.hash);
  if (cached) return cached;
  if (!state.repo) return [];
  try {
    const files = await git.commitFiles(state.repo.path, c.hash, c.parents[0] ?? null);
    state.commitFilesCache.set(c.hash, files);
    return files;
  } catch (e) {
    setStatus(`Could not list files: ${e instanceof Error ? e.message : String(e)}`, true);
    return [];
  }
}

function renderWorkingDetails(box: HTMLElement): void {
  if (!state.snap || !state.repo) return;
  const repo = state.repo.path;
  const { staged, unstaged } = state.snap.status;

  const act = (label: string, fn: () => Promise<unknown>, cls = ''): HTMLElement =>
    el(
      'button',
      {
        class: `small ${cls}`,
        onclick: (e) => {
          e.stopPropagation();
          void busy(label, fn).then(refresh);
        },
      },
      label,
    );

  // Staged
  const stagedTitle = el(
    'div',
    { class: 'section-title' },
    `Staged (${staged.length})`,
    el('span', { class: 'spacer' }),
    staged.length ? act('Unstage all', () => git.unstage(repo, staged.map((f) => f.path))) : null,
  );
  const stagedList = el('ul', { class: 'files' });
  if (!staged.length) stagedList.appendChild(el('li', { class: 'empty' }, 'Nothing staged.'));
  for (const f of staged) {
    stagedList.appendChild(
      fileRow(f, `staged:${f.path}`, { kind: 'staged', path: f.path, oldPath: f.oldPath }, [
        act('Unstage', () => git.unstage(repo, [f.path, ...(f.oldPath ? [f.oldPath] : [])])),
      ]),
    );
  }

  // Unstaged
  const unstagedTitle = el(
    'div',
    { class: 'section-title' },
    `Unstaged (${unstaged.length})`,
    el('span', { class: 'spacer' }),
    unstaged.length ? act('Stage all', () => git.stage(repo, unstaged.map((f) => f.path))) : null,
  );
  const unstagedList = el('ul', { class: 'files' });
  if (!unstaged.length) unstagedList.appendChild(el('li', { class: 'empty' }, 'Working copy is clean.'));
  for (const f of unstaged) {
    const target: DiffTarget = f.kind === 'untracked' ? { kind: 'untracked', path: f.path } : { kind: 'unstaged', path: f.path };
    unstagedList.appendChild(
      fileRow(f, `unstaged:${f.path}`, target, [
        act('Stage', () => git.stage(repo, [f.path])),
        act(
          'Discard',
          async () => {
            if (!confirm(`Discard changes to ${f.path}? This cannot be undone.`)) return;
            await git.discard(repo, [f]);
          },
          'danger',
        ),
      ]),
    );
  }

  // Commit box
  const msg = el('textarea', { placeholder: 'Commit message' }) as HTMLTextAreaElement;
  const commitBtn = el(
    'button',
    {
      class: 'primary',
      onclick: () => {
        const text = msg.value.trim();
        if (!text) {
          setStatus('Enter a commit message first.', true);
          return;
        }
        if (!staged.length) {
          setStatus('Stage some files first.', true);
          return;
        }
        void busy('Commit', () => git.commit(repo, text)).then(refresh);
      },
    },
    `Commit ${staged.length ? `(${staged.length} file${staged.length === 1 ? '' : 's'})` : ''}`,
  );
  const commitBox = el('div', { class: 'commit-box' }, msg, el('div', { class: 'row' }, el('span', { class: 'spacer' }), commitBtn));

  box.append(stagedTitle, stagedList, unstagedTitle, unstagedList, commitBox);

  if (!state.selectedFile) {
    const first = staged[0] ? { f: staged[0], s: true } : unstaged[0] ? { f: unstaged[0], s: false } : null;
    if (first) {
      const f = first.f;
      const target: DiffTarget = first.s
        ? { kind: 'staged', path: f.path, oldPath: f.oldPath }
        : f.kind === 'untracked'
          ? { kind: 'untracked', path: f.path }
          : { kind: 'unstaged', path: f.path };
      void selectFile(`${first.s ? 'staged' : 'unstaged'}:${f.path}`, target, f.path);
    }
  }
}

// ---------- file diff (column 3) ----------

async function selectFile(key: string, target: DiffTarget, label: string): Promise<void> {
  state.selectedFile = { key, target, label };
  for (const li of Array.from(document.querySelectorAll('#details .files li'))) {
    li.classList.toggle('selected', (li as HTMLElement).title === label && li.closest('ul') !== null && isRowForKey(li as HTMLElement, key));
  }
  renderFile();
  if (!state.repo) return;
  const repo = state.repo.path;
  const view = $('diff-view');
  clear(view);
  view.appendChild(el('div', { class: 'diff-empty' }, 'Loading…'));
  try {
    const text = await git.diff(repo, target);
    if (state.selectedFile?.key !== key) return;
    clear(view);
    view.appendChild(renderDiff(text));
  } catch (e) {
    if (state.selectedFile?.key !== key) return;
    clear(view);
    view.appendChild(el('div', { class: 'diff-empty' }, `Could not load diff: ${e instanceof Error ? e.message : String(e)}`));
  }
}

// Row identity: the list a row sits in tells staged from unstaged.
function isRowForKey(li: HTMLElement, key: string): boolean {
  const list = li.closest('ul');
  if (!list) return false;
  const lists = Array.from(document.querySelectorAll('#details .files'));
  const idx = lists.indexOf(list);
  if (state.selected !== WORKING) return true;
  return (idx === 0 && key.startsWith('staged:')) || (idx === 1 && key.startsWith('unstaged:'));
}

function renderFile(): void {
  const title = $('file-title');
  const view = $('diff-view');
  if (!state.selectedFile) {
    title.textContent = 'File';
    clear(view);
    view.appendChild(el('div', { class: 'diff-empty' }, 'Select a file to see its changes.'));
    return;
  }
  const t = state.selectedFile.target;
  const where = t.kind === 'commit' ? t.hash.slice(0, 7) : t.kind;
  title.textContent = `${state.selectedFile.label}  ·  ${where}`;
}

// ---------- splitters ----------

function initSplitters(): void {
  const root = document.documentElement;
  const columns = $('columns');
  for (const sp of Array.from(document.querySelectorAll<HTMLElement>('.splitter.v'))) {
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      const side = sp.dataset.side;
      const move = (ev: PointerEvent) => {
        const rect = columns.getBoundingClientRect();
        if (side === 'left') {
          root.style.setProperty('--w-left', `${Math.max(140, Math.min(500, ev.clientX - rect.left))}px`);
        } else {
          root.style.setProperty('--w-right', `${Math.max(200, Math.min(rect.width - 500, rect.right - ev.clientX))}px`);
        }
      };
      const up = () => {
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
    });
  }
  const hs = document.querySelector<HTMLElement>('.splitter.h');
  const middle = $('col-middle');
  hs?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    hs.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const rect = middle.getBoundingClientRect();
      root.style.setProperty('--h-graph', `${Math.max(100, Math.min(rect.height - 150, ev.clientY - rect.top))}px`);
    };
    const up = () => {
      hs.removeEventListener('pointermove', move);
      hs.removeEventListener('pointerup', up);
    };
    hs.addEventListener('pointermove', move);
    hs.addEventListener('pointerup', up);
  });
}

// ---------- init ----------

async function init(): Promise<void> {
  initSplitters();
  $('btn-add-repo').addEventListener('click', async () => {
    const entry = await busy('Add repository', () => git.addRepo());
    if (!entry) return;
    state.repos = await git.listRepos();
    renderRepoList();
    await selectRepo(entry);
  });
  $('btn-refresh').addEventListener('click', () => void refresh());
  $('btn-fetch').addEventListener('click', remoteAction('Fetch', (r) => git.fetch(r)));
  $('btn-pull').addEventListener('click', remoteAction('Pull', (r) => git.pull(r)));
  $('btn-push').addEventListener('click', remoteAction('Push', (r) => git.push(r)));
  $('btn-new-branch').addEventListener('click', () => void onNewBranch());
  $('branch-select').addEventListener('change', () => void onBranchChange());
  $('graph-scroll').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), moveSelection(1));
    if (e.key === 'ArrowUp') (e.preventDefault(), moveSelection(-1));
  });
  window.addEventListener('focus', () => {
    if (state.repo && state.busy === 0) void refresh();
  });

  state.repos = await git.listRepos();
  renderRepoList();
  renderAll();
  if (state.repos.length) await selectRepo(state.repos[0]);
}

void init();
