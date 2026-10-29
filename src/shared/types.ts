// Types shared between main, preload and renderer.

export interface RepoEntry {
  path: string;
  name: string;
}

export interface Commit {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  date: string; // ISO 8601
  refs: RefLabel[];
  subject: string;
  body: string;
}

export interface RefLabel {
  kind: 'head' | 'branch' | 'remote' | 'tag';
  name: string;
}

export interface Branch {
  name: string;
  current: boolean;
  upstream: string | null;
  remote: boolean;
}

export type FileChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflict'
  | 'typechange'
  | 'unknown';

export interface FileChange {
  path: string;
  oldPath?: string;
  kind: FileChangeKind;
}

export interface WorkingStatus {
  branch: string | null; // null when detached
  head: string | null; // null on an unborn branch
  detached: boolean;
  staged: FileChange[];
  unstaged: FileChange[];
  ahead: number;
  behind: number;
}

export interface StashEntry {
  index: number;
  ref: string; // stash@{n}
  message: string;
  date: string;
}

export type OpKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface OpState {
  kind: OpKind;
  /** Branch being rebased, or the hash being merged / picked, when known. */
  detail: string | null;
}

export interface RepoSnapshot {
  commits: Commit[];
  status: WorkingStatus;
  branches: Branch[];
  stashes: StashEntry[];
  op: OpState | null;
}

export type DiffTarget =
  | { kind: 'commit'; hash: string; parent: string | null; path: string; oldPath?: string }
  | { kind: 'staged'; path: string; oldPath?: string }
  | { kind: 'unstaged'; path: string }
  | { kind: 'untracked'; path: string }
  | { kind: 'conflict'; path: string };

export type PatchMode = 'stage' | 'unstage' | 'discard';
export type ResolveSide = 'ours' | 'theirs';

export interface AskpassRequest {
  id: string;
  prompt: string;
}

export interface GitApi {
  listRepos(): Promise<RepoEntry[]>;
  addRepo(): Promise<RepoEntry | null>;
  removeRepo(path: string): Promise<RepoEntry[]>;

  snapshot(repo: string): Promise<RepoSnapshot>;
  commitFiles(repo: string, hash: string, parent: string | null): Promise<FileChange[]>;
  diff(repo: string, target: DiffTarget): Promise<string>;
  readFile(repo: string, path: string): Promise<string>;

  stage(repo: string, paths: string[]): Promise<void>;
  unstage(repo: string, paths: string[]): Promise<void>;
  discard(repo: string, files: FileChange[]): Promise<void>;
  applyPatch(repo: string, patch: string, mode: PatchMode): Promise<void>;
  commit(repo: string, message: string): Promise<void>;

  checkout(repo: string, branch: string, remote: boolean): Promise<void>;
  checkoutCommit(repo: string, hash: string): Promise<void>;
  createBranch(repo: string, name: string, startPoint: string | null): Promise<void>;
  deleteBranch(repo: string, name: string, remote: boolean): Promise<void>;
  merge(repo: string, branch: string): Promise<string>;
  rebase(repo: string, onto: string): Promise<string>;
  cherryPick(repo: string, hash: string): Promise<string>;
  createTag(repo: string, name: string, hash: string, message: string | null): Promise<void>;
  deleteTag(repo: string, name: string): Promise<void>;
  pushTag(repo: string, name: string): Promise<string>;

  stashPush(repo: string, message: string, includeUntracked: boolean): Promise<void>;
  stashApply(repo: string, index: number, pop: boolean): Promise<string>;
  stashDrop(repo: string, index: number): Promise<void>;

  opContinue(repo: string): Promise<string>;
  opAbort(repo: string): Promise<void>;
  resolve(repo: string, paths: string[], side: ResolveSide): Promise<void>;
  markResolved(repo: string, paths: string[]): Promise<void>;

  fetch(repo: string): Promise<string>;
  pull(repo: string): Promise<string>;
  push(repo: string): Promise<string>;

  onAskpass(cb: (req: AskpassRequest) => void): void;
  answerAskpass(id: string, value: string | null): void;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };
