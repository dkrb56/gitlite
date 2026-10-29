// Remembers the window size, position and maximized state between runs.
import { BrowserWindow, screen } from 'electron';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const DEFAULTS: WindowState = { width: 1400, height: 900, maximized: false };

export class WindowStateStore {
  private file: string;

  constructor(userData: string) {
    this.file = path.join(userData, 'window.json');
  }

  /** Synchronous on purpose: it runs once, right before the window is created. */
  load(): WindowState {
    let saved: Partial<WindowState> = {};
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<WindowState>;
    } catch {
      return { ...DEFAULTS };
    }
    const state: WindowState = {
      ...DEFAULTS,
      ...saved,
      width: Math.max(900, Number(saved.width) || DEFAULTS.width),
      height: Math.max(500, Number(saved.height) || DEFAULTS.height),
    };
    // Drop the position when no display shows that area any more (unplugged monitor).
    if (typeof state.x === 'number' && typeof state.y === 'number') {
      const visible = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return state.x! + state.width > a.x && state.x! < a.x + a.width && state.y! + 40 > a.y && state.y! < a.y + a.height;
      });
      if (!visible) {
        delete state.x;
        delete state.y;
      }
    }
    return state;
  }

  /** Saves on every resize or move (debounced) and once more when the window closes. */
  track(win: BrowserWindow): void {
    let timer: NodeJS.Timeout | undefined;
    const save = () => {
      if (win.isDestroyed()) return;
      const maximized = win.isMaximized();
      // Keep the normal bounds while maximized, so un-maximizing later restores them.
      const bounds = maximized ? win.getNormalBounds() : win.getBounds();
      const state: WindowState = { ...bounds, maximized };
      void fs
        .mkdir(path.dirname(this.file), { recursive: true })
        .then(() => fs.writeFile(this.file, JSON.stringify(state, null, 2), 'utf8'))
        .catch(() => undefined);
    };
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(save, 300);
    };
    win.on('resize', later);
    win.on('move', later);
    win.on('maximize', later);
    win.on('unmaximize', later);
    win.on('close', () => {
      clearTimeout(timer);
      save();
    });
  }
}
