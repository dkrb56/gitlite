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

export interface RepoSnapshot {
  commits: Commit[];
  status: WorkingStatus;
  branches: Branch[];
}

export type DiffTarget =
  | { kind: 'commit'; hash: string; parent: string | null; path: string; oldPath?: string }
  | { kind: 'staged'; path: string; oldPath?: string }
  | { kind: 'unstaged'; path: string }
  | { kind: 'untracked'; path: string };

export interface GitApi {
  listRepos(): Promise<RepoEntry[]>;
  addRepo(): Promise<RepoEntry | null>;
  removeRepo(path: string): Promise<RepoEntry[]>;

  snapshot(repo: string): Promise<RepoSnapshot>;
  commitFiles(repo: string, hash: string, parent: string | null): Promise<FileChange[]>;
  diff(repo: string, target: DiffTarget): Promise<string>;

  stage(repo: string, paths: string[]): Promise<void>;
  unstage(repo: string, paths: string[]): Promise<void>;
  discard(repo: string, files: FileChange[]): Promise<void>;
  commit(repo: string, message: string): Promise<void>;

  checkout(repo: string, branch: string, remote: boolean): Promise<void>;
  createBranch(repo: string, name: string, startPoint: string | null): Promise<void>;
  fetch(repo: string): Promise<string>;
  pull(repo: string): Promise<string>;
  push(repo: string): Promise<string>;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };
