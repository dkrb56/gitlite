// Persistent list of repositories, stored as JSON in the app's userData folder.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RepoEntry } from '../shared/types';

export class RepoStore {
  private file: string;

  constructor(userData: string) {
    this.file = path.join(userData, 'repos.json');
  }

  async list(): Promise<RepoEntry[]> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as RepoEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async save(entries: RepoEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(entries, null, 2), 'utf8');
  }

  async add(entry: RepoEntry): Promise<RepoEntry[]> {
    const entries = await this.list();
    if (!entries.some((e) => e.path === entry.path)) entries.push(entry);
    await this.save(entries);
    return entries;
  }

  async remove(repoPath: string): Promise<RepoEntry[]> {
    const entries = (await this.list()).filter((e) => e.path !== repoPath);
    await this.save(entries);
    return entries;
  }
}
