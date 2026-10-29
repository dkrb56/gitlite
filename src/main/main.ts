import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import * as git from './git';
import { RepoStore } from './repos';
import { WindowStateStore } from './windowState';
import { AskpassServer } from './askpass';
import type { DiffTarget, FileChange, IpcResult, PatchMode, RepoEntry, ResolveSide } from '../shared/types';

const store = new RepoStore(app.getPath('userData'));
const windowState = new WindowStateStore(app.getPath('userData'));
const askpass = new AskpassServer();
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const saved = windowState.load();
  const win = new BrowserWindow({
    x: saved.x,
    y: saved.y,
    width: saved.width,
    height: saved.height,
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
  if (saved.maximized) win.maximize();
  windowState.track(win);
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

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
handle('git:readFile', (repo: string, p: string) => git.readFile(repo, p));
handle('git:stage', (repo: string, paths: string[]) => git.stage(repo, paths));
handle('git:unstage', (repo: string, paths: string[]) => git.unstage(repo, paths));
handle('git:discard', (repo: string, files: FileChange[]) => git.discard(repo, files));
handle('git:applyPatch', (repo: string, patch: string, mode: PatchMode) => git.applyPatch(repo, patch, mode));
handle('git:commit', (repo: string, message: string) => git.commit(repo, message));
handle('git:checkout', (repo: string, branch: string, remote: boolean) => git.checkout(repo, branch, remote));
handle('git:checkoutCommit', (repo: string, hash: string) => git.checkoutCommit(repo, hash));
handle('git:createBranch', (repo: string, name: string, start: string | null) => git.createBranch(repo, name, start));
handle('git:deleteBranch', (repo: string, name: string, remote: boolean) => git.deleteBranch(repo, name, remote));
handle('git:merge', (repo: string, branch: string) => git.merge(repo, branch));
handle('git:rebase', (repo: string, onto: string) => git.rebase(repo, onto));
handle('git:cherryPick', (repo: string, hash: string) => git.cherryPick(repo, hash));
handle('git:createTag', (repo: string, name: string, hash: string, message: string | null) => git.createTag(repo, name, hash, message));
handle('git:deleteTag', (repo: string, name: string) => git.deleteTag(repo, name));
handle('git:pushTag', (repo: string, name: string) => git.pushTag(repo, name));
handle('git:stashPush', (repo: string, message: string, untracked: boolean) => git.stashPush(repo, message, untracked));
handle('git:stashApply', (repo: string, index: number, pop: boolean) => git.stashApply(repo, index, pop));
handle('git:stashDrop', (repo: string, index: number) => git.stashDrop(repo, index));
handle('git:opContinue', (repo: string) => git.opContinue(repo));
handle('git:opAbort', (repo: string) => git.opAbort(repo));
handle('git:resolve', (repo: string, paths: string[], side: ResolveSide) => git.resolve(repo, paths, side));
handle('git:markResolved', (repo: string, paths: string[]) => git.markResolved(repo, paths));
handle('git:fetch', (repo: string) => git.fetch(repo));
handle('git:pull', (repo: string) => git.pull(repo));
handle('git:push', (repo: string) => git.push(repo));

ipcMain.on('askpass:reply', (_event, id: string, value: string | null) => askpass.answer(id, value));

// Git and ssh ask for credentials through askpass.sh, which calls back into this process.
async function startAskpass(): Promise<void> {
  await askpass.start();
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'askpass') : path.join(app.getAppPath(), 'src', 'askpass');
  git.setExtraEnv(askpass.env(path.join(dir, 'askpass.sh'), process.execPath, path.join(dir, 'askpass.js')));
  askpass.onPrompt = (req) => {
    if (!mainWindow) {
      askpass.answer(req.id, null);
      return;
    }
    mainWindow.webContents.send('askpass:prompt', req);
    if (!mainWindow.isFocused()) mainWindow.focus();
  };
}

app.whenReady().then(async () => {
  await startAskpass();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
