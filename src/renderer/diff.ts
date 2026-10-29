// Parse a unified diff and render it as a table: old no · new no · sign · code.
import { el } from './dom';

type LineKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx';
interface DiffLine { kind: LineKind; oldNo: number | null; newNo: number | null; text: string; }

export function parseDiff(text: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let inHunk = false, oldNo = 0, newNo = 0;
  for (const raw of text.replace(/\r?\n$/, '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '' && lines.length && !inHunk) continue;
    if (line.startsWith('diff --git')) { inHunk = false; lines.push({ kind: 'meta', oldNo: null, newNo: null, text: line }); continue; }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = m ? Number(m[1]) : 0; newNo = m ? Number(m[2]) : 0; inHunk = true;
      lines.push({ kind: 'hunk', oldNo: null, newNo: null, text: line }); continue;
    }
    if (!inHunk) { lines.push({ kind: 'meta', oldNo: null, newNo: null, text: line }); continue; }
    const c = line[0];
    if (c === '+') lines.push({ kind: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) });
    else if (c === '-') lines.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) });
    else if (c === '\\') lines.push({ kind: 'meta', oldNo: null, newNo: null, text: line });
    else lines.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
  }
  // Hide file-level header noise (diff --git, index, ---/+++); hunks carry enough context.
  return lines.filter((l) => l.kind !== 'meta' || l.text.startsWith('\\'));
}

export function renderDiff(text: string): HTMLElement {
  if (!text.trim()) return el('div', { class: 'diff-empty' }, 'No changes to show.');
  const table = el('table', { class: 'diff' });
  const tbody = el('tbody');
  for (const l of parseDiff(text)) {
    const tr = el('tr', { class: l.kind });
    const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : '';
    tr.append(
      el('td', { class: 'ln' }, l.oldNo === null ? '' : String(l.oldNo)),
      el('td', { class: 'ln' }, l.newNo === null ? '' : String(l.newNo)),
      el('td', { class: 'sign' }, sign),
      el('td', { class: 'code' }, l.text || ' '),
    );
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}
