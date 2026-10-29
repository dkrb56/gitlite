import { contextBridge, ipcRenderer } from 'electron';
import type { AskpassRequest, GitApi, IpcResult } from '../shared/types';

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
  readFile: (repo, p) => call('git:readFile', repo, p),

  stage: (repo, paths) => call('git:stage', repo, paths),
  unstage: (repo, paths) => call('git:unstage', repo, paths),
  discard: (repo, files) => call('git:discard', repo, files),
  applyPatch: (repo, patch, mode) => call('git:applyPatch', repo, patch, mode),
  commit: (repo, message) => call('git:commit', repo, message),

  checkout: (repo, branch, remote) => call('git:checkout', repo, branch, remote),
  checkoutCommit: (repo, hash) => call('git:checkoutCommit', repo, hash),
  createBranch: (repo, name, start) => call('git:createBranch', repo, name, start),
  deleteBranch: (repo, name, remote) => call('git:deleteBranch', repo, name, remote),
  merge: (repo, branch) => call('git:merge', repo, branch),
  rebase: (repo, onto) => call('git:rebase', repo, onto),
  cherryPick: (repo, hash) => call('git:cherryPick', repo, hash),
  createTag: (repo, name, hash, message) => call('git:createTag', repo, name, hash, message),
  deleteTag: (repo, name) => call('git:deleteTag', repo, name),
  pushTag: (repo, name) => call('git:pushTag', repo, name),

  stashPush: (repo, message, untracked) => call('git:stashPush', repo, message, untracked),
  stashApply: (repo, index, pop) => call('git:stashApply', repo, index, pop),
  stashDrop: (repo, index) => call('git:stashDrop', repo, index),

  opContinue: (repo) => call('git:opContinue', repo),
  opAbort: (repo) => call('git:opAbort', repo),
  resolve: (repo, paths, side) => call('git:resolve', repo, paths, side),
  markResolved: (repo, paths) => call('git:markResolved', repo, paths),

  fetch: (repo) => call('git:fetch', repo),
  pull: (repo) => call('git:pull', repo),
  push: (repo) => call('git:push', repo),

  onAskpass: (cb) => {
    ipcRenderer.on('askpass:prompt', (_event, req: AskpassRequest) => cb(req));
  },
  answerAskpass: (id, value) => ipcRenderer.send('askpass:reply', id, value),
};

contextBridge.exposeInMainWorld('git', api);
