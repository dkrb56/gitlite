// Local HTTP bridge between askpass.js (spawned by git) and the renderer's credential sheet.
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AskpassRequest } from '../shared/types';

const REPLY_TIMEOUT = 10 * 60 * 1000;

export class AskpassServer {
  private server: http.Server | null = null;
  private token = randomBytes(24).toString('hex');
  private port = 0;
  private pending = new Map<string, (value: string | null) => void>();

  /** Called for every prompt; must forward it to the window. */
  onPrompt: ((req: AskpassRequest) => void) | null = null;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  /** Environment that makes git and ssh ask through this bridge. */
  env(scriptPath: string, nodePath: string, mainPath: string): Record<string, string> {
    const fwd = (p: string) => p.replace(/\\/g, '/');
    return {
      GIT_ASKPASS: fwd(scriptPath),
      SSH_ASKPASS: fwd(scriptPath),
      SSH_ASKPASS_REQUIRE: 'force',
      GITLITE_ASKPASS_NODE: fwd(nodePath),
      GITLITE_ASKPASS_MAIN: fwd(mainPath),
      GITLITE_ASKPASS_PORT: String(this.port),
      GITLITE_ASKPASS_TOKEN: this.token,
    };
  }

  answer(id: string, value: string | null): void {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve(value);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/askpass' || req.headers['x-gitlite-token'] !== this.token) {
      res.writeHead(403).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let prompt = '';
    try {
      prompt = String((JSON.parse(raw) as { prompt?: string }).prompt ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const id = randomUUID();
    const value = await new Promise<string | null>((resolve) => {
      this.pending.set(id, resolve);
      const timer = setTimeout(() => this.answer(id, null), REPLY_TIMEOUT);
      this.pending.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      if (this.onPrompt) this.onPrompt({ id, prompt });
      else this.answer(id, null);
    });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ value }));
  }
}
