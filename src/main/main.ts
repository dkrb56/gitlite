import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import * as git from './git';
import { RepoStore } from './repos';
import type { DiffTarget, FileChange, IpcResult, RepoEntry } from '../shared/types';

const store = new RepoStore(app.getPath('userData'));

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 500,
    backgroundColor: '#1e1f24',
    title: 'GitLite',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
}

// Wrap every handler so errors travel as data instead of opaque IPC rejections.
function handle<T>(channel: string, fn: (...args: any[]) => Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResult<T>> => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

handle('repos:list', () => store.list());
handle('repos:add', async (): Promise<RepoEntry | null> => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  const top = await git.toplevel(res.filePaths[0]);
  const normalized = path.normalize(top);
  const entry: RepoEntry = { path: normalized, name: path.basename(normalized) };
  await store.add(entry);
  return entry;
});
handle('repos:remove', (p: string) => store.remove(p));

handle('git:snapshot', (repo: string) => git.snapshot(repo));
handle('git:commitFiles', (repo: string, hash: string, parent: string | null) => git.commitFiles(repo, hash, parent));
handle('git:diff', (repo: string, target: DiffTarget) => git.diff(repo, target));
handle('git:stage', (repo: string, paths: string[]) => git.stage(repo, paths));
handle('git:unstage', (repo: string, paths: string[]) => git.unstage(repo, paths));
handle('git:discard', (repo: string, files: FileChange[]) => git.discard(repo, files));
handle('git:commit', (repo: string, message: string) => git.commit(repo, message));
handle('git:checkout', (repo: string, branch: string, remote: boolean) => git.checkout(repo, branch, remote));
handle('git:createBranch', (repo: string, name: string, start: string | null) => git.createBranch(repo, name, start));
handle('git:fetch', (repo: string) => git.fetch(repo));
handle('git:pull', (repo: string) => git.pull(repo));
handle('git:push', (repo: string) => git.push(repo));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
