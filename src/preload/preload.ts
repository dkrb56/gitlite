import { contextBridge, ipcRenderer } from 'electron';
import type { GitApi, IpcResult } from '../shared/types';

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
  if (res.ok) return res.data;
  throw new Error(res.error);
}

const api: GitApi = {
  listRepos: () => call('repos:list'),
  addRepo: () => call('repos:add'),
  removeRepo: (p) => call('repos:remove', p),

  snapshot: (repo) => call('git:snapshot', repo),
  commitFiles: (repo, hash, parent) => call('git:commitFiles', repo, hash, parent),
  diff: (repo, target) => call('git:diff', repo, target),

  stage: (repo, paths) => call('git:stage', repo, paths),
  unstage: (repo, paths) => call('git:unstage', repo, paths),
  discard: (repo, files) => call('git:discard', repo, files),
  commit: (repo, message) => call('git:commit', repo, message),

  checkout: (repo, branch, remote) => call('git:checkout', repo, branch, remote),
  createBranch: (repo, name, start) => call('git:createBranch', repo, name, start),
  fetch: (repo) => call('git:fetch', repo),
  pull: (repo) => call('git:pull', repo),
  push: (repo) => call('git:push', repo),
};

contextBridge.exposeInMainWorld('git', api);
