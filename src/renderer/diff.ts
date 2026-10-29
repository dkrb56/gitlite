// Parse a unified diff and render it as a table with old/new line numbers.
import { el } from './dom';

type LineKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx';

interface DiffLine {
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export function parseDiff(text: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of text.replace(/\r?\n$/, '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '' && lines.length && !inHunk) continue;
    if (line.startsWith('diff --git')) {
      inHunk = false;
      lines.push({ kind: 'meta', oldNo: null, newNo: null, text: line });
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      inHunk = true;
      lines.push({ kind: 'hunk', oldNo: null, newNo: null, text: line });
      continue;
    }
    if (!inHunk) {
      lines.push({ kind: 'meta', oldNo: null, newNo: null, text: line });
      continue;
    }
    const c = line[0];
    if (c === '+') {
      lines.push({ kind: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) });
    } else if (c === '-') {
      lines.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) });
    } else if (c === '\\') {
      lines.push({ kind: 'meta', oldNo: null, newNo: null, text: line });
    } else {
      lines.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    }
  }
  return lines;
}

export function renderDiff(text: string): HTMLElement {
  if (!text.trim()) return el('div', { class: 'diff-empty' }, 'No changes to show.');
  const table = el('table', { class: 'diff' });
  const tbody = el('tbody');
  for (const l of parseDiff(text)) {
    const tr = el('tr', { class: l.kind });
    if (l.kind === 'hunk' || l.kind === 'meta') {
      tr.append(el('td', { class: 'ln' }), el('td', { class: 'ln' }), el('td', { class: 'code' }, l.text));
    } else {
      tr.append(
        el('td', { class: 'ln' }, l.oldNo === null ? '' : String(l.oldNo)),
        el('td', { class: 'ln' }, l.newNo === null ? '' : String(l.newNo)),
        el('td', { class: 'code' }, l.text || ' '),
      );
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}
