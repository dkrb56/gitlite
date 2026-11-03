// Checks the newest GitHub release of GitLite and points at the matching download.
import { app } from 'electron';
import type { UpdateInfo } from '../shared/types';

export const REPO = 'dkrb56/gitlite';
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
const API = `https://api.github.com/repos/${REPO}/releases/latest`;

interface Release {
  tag_name: string;
  html_url: string;
  assets?: { name: string; browser_download_url: string }[];
}

/** "v1.2.3" or "1.2.3" -> [1, 2, 3]; anything unparsable -> null. */
export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** The portable exe sets PORTABLE_EXECUTABLE_FILE for the process it unpacks and starts. */
export function variant(): UpdateInfo['variant'] {
  return process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'installed';
}

export async function checkUpdates(): Promise<UpdateInfo> {
  const current = app.getVersion();
  const res = await fetch(API, { headers: { accept: 'application/vnd.github+json', 'user-agent': `GitLite/${current}` } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}`);
  const rel = (await res.json()) as Release;
  const latest = rel.tag_name.replace(/^v/, '');
  const want = variant() === 'portable' ? /-portable\.exe$/i : /-setup\.exe$/i;
  const asset = rel.assets?.find((a) => want.test(a.name));
  return { current, latest, newer: isNewer(latest, current), url: asset?.browser_download_url ?? rel.html_url ?? RELEASES_URL, variant: variant() };
}
