// Appearance settings: theme, accent, date style, diff text size. Persisted in localStorage.

export type Theme = 'light' | 'dark';
export type DateStyle = 'relative' | 'absolute';

export type DiffLayout = 'unified' | 'split';

export interface Settings {
  theme: Theme;
  accent: string;
  dateStyle: DateStyle;
  diffSize: number; // px
  diffLayout: DiffLayout;
  highlight: boolean; // syntax colors in diffs
}

export const ACCENTS: { color: string; ink: string; inkDark: string; label: string }[] = [
  { color: '#5b86c2', ink: '#3f6498', inkDark: '#9fbde6', label: 'Blue' },
  { color: '#4d9a7a', ink: '#2f7258', inkDark: '#8fd0b5', label: 'Green' },
  { color: '#c07a4a', ink: '#8f5429', inkDark: '#ecb48e', label: 'Terracotta' },
  { color: '#9a6fb8', ink: '#6f4a8c', inkDark: '#c9aee0', label: 'Plum' },
];

export const DEFAULTS: Settings = { theme: 'dark', accent: '#5b86c2', dateStyle: 'relative', diffSize: 12.5, diffLayout: 'unified', highlight: true };

const KEY = 'gitlite.settings';

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function applySettings(s: Settings): void {
  const root = document.documentElement.style;
  document.body.classList.toggle('dark', s.theme === 'dark');
  const a = ACCENTS.find((x) => x.color === s.accent) ?? ACCENTS[0];
  root.setProperty('--accent', a.color);
  root.setProperty('--accent-ink', s.theme === 'dark' ? a.inkDark : a.ink);
  root.setProperty('--on-accent', s.theme === 'dark' ? '#1d1a16' : '#fff');
  root.setProperty('--diff-size', `${s.diffSize}px`);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** Short form for history rows. */
export function formatDate(iso: string, style: DateStyle, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (style === 'absolute') return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const h = (now.getTime() - d.getTime()) / 36e5;
  if (h < 1) return 'just now';
  if (h < 24) return `${Math.round(h)}h ago`;
  if (h < 48) return 'yesterday';
  if (h < 168) return `${Math.round(h / 24)}d ago`;
  if (d.getFullYear() === now.getFullYear()) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Long form for commit details. */
export function formatDateLong(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
