import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import type { Commit, DiffTarget, FileChange, GitApi, RepoEntry, RepoSnapshot } from '../shared/types';
import { $, clear, el } from './dom';
import { renderDiff } from './diff';
import { graphWidth, layoutGraph, renderRowSvg, type GraphNode } from './graph';
import { ACCENTS, applySettings, formatDate, formatDateLong, loadSettings, saveSettings, type Settings } from './theme';

declare global { interface Window { git: GitApi; } }
const git = window.git;
const WORKING = '@working';

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
    toast(`${label} failed: ${e instanceof Error ? e.message : String(e)}`, true);
    return undefined;
  } finally {
    state.busy--;
    if (state.busy === 0) b.hidden = true;
  }
}

// ---------- confirm sheet ----------
function confirmSheet(title: string, text: Node | string): Promise<boolean> {
  const box = $('confirm');
  $('confirm-title').textContent = title;
  const t = $('confirm-text'); clear(t); t.append(text);
  box.hidden = false;
  return new Promise((resolve) => {
    const done = (v: boolean) => { box.hidden = true; ok.removeEventListener('click', onOk); cancel.removeEventListener('click', onCancel); document.removeEventListener('keydown', onKey); resolve(v); };
    const ok = $('confirm-ok'), cancel = $('confirm-cancel');
    const onOk = () => done(true), onCancel = () => done(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    ok.addEventListener('click', onOk); cancel.addEventListener('click', onCancel); document.addEventListener('keydown', onKey);
  });
}

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

// ---------- refresh ----------
async function refresh(): Promise<void> {
  if (!state.repo) { renderAll(); return; }
  const repo = state.repo;
  const snap = await busy(`Reading ${repo.name}`, () => git.snapshot(repo.path));
  if (!snap || state.repo?.path !== repo.path) return;
  state.snap = snap; state.commitFilesCache.clear();
  const hasChanges = snap.status.staged.length + snap.status.unstaged.length > 0;
  if (state.selected === WORKING && !hasChanges) state.selected = null;
  if (state.selected && state.selected !== WORKING && !snap.commits.some((c) => c.hash === state.selected)) state.selected = null;
  if (!state.selected) state.selected = hasChanges ? WORKING : snap.commits[0]?.hash ?? null;
  renderAll();
}
function renderAll(): void { renderToolbar(); renderGraph(); void renderDetails(); }

// ---------- toolbar + branch popover ----------
function renderToolbar(): void {
  const has = !!state.repo && !!state.snap;
  for (const id of ['branch-pill', 'btn-fetch', 'btn-pull', 'btn-push']) $<HTMLButtonElement>(id).disabled = !has;
  const title = $('repo-title'), ab = $('ahead-behind'), name = $('branch-name');
  if (!has || !state.snap || !state.repo) { title.textContent = ''; ab.textContent = ''; name.textContent = 'No branch'; return; }
  const st = state.snap.status;
  title.textContent = state.repo.name; title.title = state.repo.path;
  name.textContent = st.detached ? `detached at ${st.head?.slice(0, 7) ?? '?'}` : st.branch ?? 'No branch';
  ab.textContent = st.ahead || st.behind ? `${st.ahead ? '↑' + st.ahead : ''} ${st.behind ? '↓' + st.behind : ''}`.trim() : 'up to date';
  renderBranchLists();
}

function renderBranchLists(): void {
  const box = $('branch-lists'); clear(box);
  if (!state.snap || !state.repo) return;
  const q = $<HTMLInputElement>('branch-query').value.trim();
  const match = (n: string) => !q || n.toLowerCase().includes(q.toLowerCase());
  const local = state.snap.branches.filter((b) => !b.remote && match(b.name));
  const remote = state.snap.branches.filter((b) => b.remote && match(b.name));
  const item = (name: string, current: boolean, isRemote: boolean) =>
    el('div', { class: `item ${current ? 'current' : ''} ${isRemote ? 'remote' : ''}`, onclick: () => void checkout(name, isRemote) },
      el('span', { class: 'name' }, name), current ? el('span', { class: 'mark' }, 'current') : null);
  if (local.length) box.append(el('div', { class: 'label' }, 'Local'), ...local.map((b) => item(b.name, b.current, false)));
  if (remote.length) box.append(el('div', { class: 'label' }, 'Remote'), ...remote.map((b) => item(b.name, false, true)));
  const exists = state.snap.branches.some((b) => b.name === q);
  if (q && !exists) {
    const from = state.snap.status.branch ?? 'HEAD';
    box.append(el('div', { class: 'create' }, el('div', { class: 'item', onclick: () => void createBranch(q) }, el('span', { class: 'name' }, `Create branch “${q}” from ${from}`))));
  }
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
async function createBranch(name: string): Promise<void> {
  if (!state.repo) return;
  setBranchOpen(false);
  const repo = state.repo.path, from = state.snap?.status.branch ?? 'HEAD';
  await busy(`Creating ${name}`, () => git.createBranch(repo, name, null), `Created ${name} from ${from}`);
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
    }
    box.appendChild(div);
  }
  if (!rows.length) box.appendChild(el('div', { class: 'row empty' }, 'No commits yet.'));
}
function selectRow(hash: string): void {
  if (state.selected === hash) return;
  state.selected = hash; state.selectedFile = null;
  for (const r of Array.from($('graph-scroll').children)) r.classList.toggle('selected', (r as HTMLElement).dataset.hash === hash);
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
  const c = state.snap.commits.find((x) => x.hash === state.selected);
  if (!c) return;

  box.append(
    el('div', {}, el('div', { class: 'commit-subject' }, c.subject), c.body ? el('div', { class: 'commit-body' }, c.body) : null),
    el('div', { class: 'commit-meta' },
      el('span', { title: c.authorEmail }, c.authorName),
      el('span', {}, formatDateLong(c.date)),
      el('span', { class: 'mono', title: c.hash }, c.hash.slice(0, 7)),
      c.parents.length ? el('span', { class: 'parents' }, el('span', {}, c.parents.length > 1 ? 'parents' : 'parent'),
        ...c.parents.map((p) => el('a', { href: '#', onclick: (e) => { e.preventDefault(); selectRow(p); } }, p.slice(0, 7)))) : null,
    ),
  );
  const count = el('span', { class: 'label' }, '');
  const list = el('ul', { class: 'files' }, el('li', { class: 'empty' }, 'Loading…'));
  box.append(el('div', {}, sectionTitle('Changed files', count), list));

  const files = await loadCommitFiles(c);
  if (state.selected !== c.hash) return;
  clear(list);
  count.textContent = String(files.length);
  if (!files.length) list.appendChild(el('li', { class: 'empty' }, 'No file changes.'));
  const parent = c.parents[0] ?? null;
  for (const f of files) list.appendChild(fileRow(f, `${c.hash}:${f.path}`, { kind: 'commit', hash: c.hash, parent, path: f.path, oldPath: f.oldPath }));
  if (!state.selectedFile && files.length) {
    const f = files[0];
    void selectFile(`${c.hash}:${f.path}`, { kind: 'commit', hash: c.hash, parent, path: f.path, oldPath: f.oldPath }, f.path);
  } else renderFile();
}

async function loadCommitFiles(c: Commit): Promise<FileChange[]> {
  const cached = state.commitFilesCache.get(c.hash);
  if (cached) return cached;
  if (!state.repo) return [];
  try {
    const files = await git.commitFiles(state.repo.path, c.hash, c.parents[0] ?? null);
    state.commitFilesCache.set(c.hash, files);
    return files;
  } catch (e) { toast(`Could not list files: ${e instanceof Error ? e.message : String(e)}`, true); return []; }
}

function renderWorkingDetails(box: HTMLElement): void {
  if (!state.snap || !state.repo) return;
  const repo = state.repo.path;
  const { staged, unstaged } = state.snap.status;
  const branch = state.snap.status.branch ?? 'HEAD';
  const act = (label: string, fn: () => Promise<unknown>, cls = '', done?: string) =>
    el('button', { class: `link ${cls}`, onclick: (e) => { e.stopPropagation(); void busy(label, fn, done).then(refresh); } }, label);

  const stagedList = el('ul', { class: 'files' });
  if (!staged.length) stagedList.appendChild(el('li', { class: 'empty' }, 'Nothing staged yet.'));
  for (const f of staged) {
    stagedList.appendChild(fileRow(f, `staged:${f.path}`, { kind: 'staged', path: f.path, oldPath: f.oldPath },
      [act('Unstage', () => git.unstage(repo, [f.path, ...(f.oldPath ? [f.oldPath] : [])]))]));
  }
  const unstagedList = el('ul', { class: 'files' });
  if (!unstaged.length) unstagedList.appendChild(el('li', { class: 'empty' }, 'Working copy is clean.'));
  for (const f of unstaged) {
    const target: DiffTarget = f.kind === 'untracked' ? { kind: 'untracked', path: f.path } : { kind: 'unstaged', path: f.path };
    unstagedList.appendChild(fileRow(f, `unstaged:${f.path}`, target, [
      act('Stage', () => git.stage(repo, [f.path])),
      act('Discard', async () => {
        const ok = await confirmSheet('Discard changes?', el('span', {}, 'Changes to ', el('span', { class: 'mono' }, f.path), ' will be lost. This can’t be undone.'));
        if (ok) { await git.discard(repo, [f]); toast(`Discarded ${f.path}`); }
      }, 'danger'),
    ]));
  }

  const msg = el('textarea', { placeholder: 'Describe the change', rows: '3' }) as HTMLTextAreaElement;
  const hint = el('span', { class: 'hint' });
  const commitBtn = el('button', { class: 'primary' }, staged.length ? `Commit ${staged.length} file${staged.length === 1 ? '' : 's'}` : 'Commit') as HTMLButtonElement;
  const update = () => {
    const ok = staged.length > 0 && msg.value.trim().length > 0;
    commitBtn.disabled = !ok;
    hint.textContent = !staged.length ? 'Stage files to commit them' : !msg.value.trim() ? 'Add a message to commit' : `Commits to ${branch}`;
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
    el('div', {}, sectionTitle(`Changes · ${unstaged.length}`, unstaged.length ? act('Stage all', () => git.stage(repo, unstaged.map((f) => f.path))) : null), unstagedList),
    el('div', { class: 'commit-box' }, msg, el('div', { class: 'row2' }, hint, commitBtn)),
  );

  if (!state.selectedFile) {
    const first = staged[0] ? { f: staged[0], s: true } : unstaged[0] ? { f: unstaged[0], s: false } : null;
    if (first) {
      const f = first.f;
      const target: DiffTarget = first.s ? { kind: 'staged', path: f.path, oldPath: f.oldPath } : f.kind === 'untracked' ? { kind: 'untracked', path: f.path } : { kind: 'unstaged', path: f.path };
      void selectFile(`${first.s ? 'staged' : 'unstaged'}:${f.path}`, target, f.path);
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
    clear(view); view.appendChild(renderDiff(text));
  } catch (e) {
    if (state.selectedFile?.key !== key) return;
    clear(view); view.appendChild(el('div', { class: 'diff-empty' }, `Could not load diff: ${e instanceof Error ? e.message : String(e)}`));
  }
}
function renderFile(): void {
  const title = $('file-title'), where = $('file-where'), view = $('diff-view');
  clear(title);
  if (!state.selectedFile) { title.textContent = 'No file selected'; where.textContent = ''; clear(view); view.appendChild(el('div', { class: 'diff-empty' }, 'Select a file to see its changes.')); return; }
  const t = state.selectedFile.target;
  title.appendChild(pathSpan(t.path, 'oldPath' in t ? t.oldPath : undefined));
  where.textContent = t.kind === 'commit' ? t.hash.slice(0, 7) : t.kind === 'staged' ? 'staged' : 'working copy';
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
  if (k === 'dateStyle') renderGraph();
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
  const addRepo = async () => {
    const entry = await busy('Adding repository', () => git.addRepo());
    if (!entry) return;
    state.repos = await git.listRepos(); renderRepoList();
    toast(`Added ${entry.name}`);
    await selectRepo(entry);
  };
  $('btn-add-repo').addEventListener('click', () => void addRepo());
  $('btn-add-repo-empty').addEventListener('click', () => void addRepo());
  $('btn-fetch').addEventListener('click', remoteAction('Fetching', (r) => git.fetch(r)));
  $('btn-pull').addEventListener('click', remoteAction('Pulling', (r) => git.pull(r)));
  $('btn-push').addEventListener('click', remoteAction('Pushing', (r) => git.push(r)));
  $('branch-pill').addEventListener('click', (e) => { e.stopPropagation(); setBranchOpen(!state.branchOpen); });
  $('branch-pop').addEventListener('click', (e) => e.stopPropagation());
  $('branch-query').addEventListener('input', renderBranchLists);
  $('branch-query').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const q = (e.target as HTMLInputElement).value.trim(); if (q && !state.snap?.branches.some((b) => b.name === q)) void createBranch(q); }
  });
  document.addEventListener('click', () => { if (state.branchOpen) setBranchOpen(false); });
  $('btn-settings').addEventListener('click', () => ($('settings').hidden = false));
  $('settings-done').addEventListener('click', () => ($('settings').hidden = true));
  $('settings').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('settings').hidden = true; });
  for (const seg of Array.from(document.querySelectorAll<HTMLElement>('#settings .seg'))) {
    seg.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button'); if (!b) return;
      const k = seg.dataset.setting as keyof Settings, v = b.dataset.value!;
      setSetting(k, (k === 'diffSize' ? Number(v) : v) as never);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setBranchOpen(false); $('settings').hidden = true; }
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
