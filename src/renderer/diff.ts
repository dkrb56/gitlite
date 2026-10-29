// Unified diff model, patch building for partial staging, and the unified / split renderers.
import { el } from './dom';
import { escapeHtml, highlightLine, languageFor } from './highlight';

export type LineKind = 'add' | 'del' | 'ctx';
export interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
  noNewline?: boolean; // the "\ No newline at end of file" marker followed this line
}
export interface Hunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}
export interface DiffFile {
  headerLines: string[]; // diff --git, index, ---, +++, mode and rename lines
  hunks: Hunk[];
  binary: boolean;
  /** New or deleted files have one hunk that must go in whole; no line selection there. */
  wholeFileOnly: boolean;
}

// ---------- parse ----------

export function parseDiff(text: string): DiffFile {
  const file: DiffFile = { headerLines: [], hunks: [], binary: false, wholeFileOnly: false };
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  const raw = text.replace(/\r?\n$/, '').split('\n');
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].replace(/\r$/, '');
    if (line.startsWith('diff --git') && file.hunks.length) break; // only the first file of a multi-file diff
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      hunk = { header: line, oldStart: oldNo, newStart: newNo, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (line.startsWith('Binary files')) file.binary = true;
      if (/^(new|deleted) file mode/.test(line)) file.wholeFileOnly = true;
      if (line.trim()) file.headerLines.push(line);
      continue;
    }
    const c = line[0];
    if (c === '\\') {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
    } else if (c === '+') hunk.lines.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
    else if (c === '-') hunk.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
    else hunk.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return file;
}

// ---------- patch building ----------

/**
 * A patch with one hunk, optionally reduced to the selected line indexes.
 * Unselected removals become context (the line stays), unselected additions are dropped.
 */
export function buildPatch(file: DiffFile, hunkIndex: number, selected: Set<number> | null): string {
  const h = file.hunks[hunkIndex];
  const body: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  h.lines.forEach((l, i) => {
    const sel = !selected || selected.has(i);
    let emitted = false;
    if (l.kind === 'ctx') {
      body.push(' ' + l.text);
      oldCount++;
      newCount++;
      emitted = true;
    } else if (l.kind === 'add') {
      if (sel) {
        body.push('+' + l.text);
        newCount++;
        emitted = true;
      }
    } else if (sel) {
      body.push('-' + l.text);
      oldCount++;
      emitted = true;
    } else {
      body.push(' ' + l.text);
      oldCount++;
      newCount++;
      emitted = true;
    }
    if (emitted && l.noNewline) body.push('\\ No newline at end of file');
  });
  const header = file.headerLines.filter((x) => !x.startsWith('Binary files'));
  return [...header, `@@ -${h.oldStart},${oldCount} +${h.newStart},${newCount} @@`, ...body].join('\n') + '\n';
}

// ---------- rendering ----------

export type PatchAction = 'stage' | 'unstage' | 'discard';

export interface DiffRenderOptions {
  layout: 'unified' | 'split';
  highlight: boolean;
  path: string;
  /** Present for working-copy files: which patch actions make sense, and the callback. */
  actions?: {
    primary: 'stage' | 'unstage';
    discard: boolean;
    onPatch: (action: PatchAction, patch: string, hunkIndex: number) => void;
  } | null;
}

interface Selection {
  byHunk: Map<number, Set<number>>;
  anchor: { hunk: number; line: number } | null;
}

export function renderDiff(text: string, opts: DiffRenderOptions): HTMLElement {
  if (!text.trim()) return el('div', { class: 'diff-empty' }, 'No changes to show.');
  const file = parseDiff(text);
  if (file.binary) return el('div', { class: 'diff-empty' }, 'Binary file. No text diff to show.');
  if (!file.hunks.length) return el('div', { class: 'diff-empty' }, file.headerLines.join('\n') || 'No changes to show.');

  const lang = opts.highlight ? languageFor(opts.path) : null;
  const code = (t: string): HTMLElement => {
    const td = el('td', { class: 'code' });
    if (lang) td.innerHTML = highlightLine(t, lang) || ' ';
    else td.textContent = t || ' ';
    return td;
  };
  const sel: Selection = { byHunk: new Map(), anchor: null };
  const table = el('table', { class: `diff ${opts.layout}` });
  const tbody = el('tbody');
  const hunkHeaders: HTMLElement[] = [];

  const toggle = (hunk: number, line: number, range: boolean) => {
    if (!opts.actions || file.wholeFileOnly) return;
    const set = sel.byHunk.get(hunk) ?? new Set<number>();
    sel.byHunk.set(hunk, set);
    const lines = file.hunks[hunk].lines;
    if (range && sel.anchor && sel.anchor.hunk === hunk) {
      const [a, b] = [Math.min(sel.anchor.line, line), Math.max(sel.anchor.line, line)];
      for (let i = a; i <= b; i++) if (lines[i].kind !== 'ctx') set.add(i);
    } else {
      if (set.has(line)) set.delete(line);
      else set.add(line);
      sel.anchor = { hunk, line };
    }
    for (const cell of Array.from(tbody.querySelectorAll<HTMLElement>(`[data-hunk="${hunk}"]`))) {
      cell.classList.toggle('picked', set.has(Number(cell.dataset.line)));
    }
    renderHunkActions(hunk);
  };

  const renderHunkActions = (hunkIndex: number) => {
    const box = hunkHeaders[hunkIndex];
    const actions = box.querySelector('.hunk-actions');
    if (!actions || !opts.actions) return;
    actions.replaceChildren();
    const set = sel.byHunk.get(hunkIndex);
    const n = set?.size ?? 0;
    const what = n ? `${n} line${n === 1 ? '' : 's'}` : 'hunk';
    const act = opts.actions;
    const btn = (label: string, action: PatchAction, cls = '') =>
      el(
        'button',
        {
          class: `link ${cls}`,
          onclick: (e) => {
            e.stopPropagation();
            act.onPatch(action, buildPatch(file, hunkIndex, n ? set! : null), hunkIndex);
          },
        },
        label,
      );
    actions.append(btn(`${act.primary === 'stage' ? 'Stage' : 'Unstage'} ${what}`, act.primary));
    if (act.discard) actions.append(btn(`Discard ${what}`, 'discard', 'danger'));
  };

  file.hunks.forEach((h, hi) => {
    const tr = el('tr', { class: 'hunk' });
    const td = el('td', { colspan: '4' }); // both layouts have four columns
    const head = el('div', { class: 'hunk-head' }, el('span', { class: 'hunk-text' }, h.header), el('span', { class: 'hunk-actions' }));
    td.appendChild(head);
    tr.appendChild(td);
    tbody.appendChild(tr);
    hunkHeaders.push(head);
    renderHunkActions(hi);

    const selectable = !!opts.actions && !file.wholeFileOnly;
    const mark = (cell: HTMLElement, li: number) => {
      cell.dataset.hunk = String(hi);
      cell.dataset.line = String(li);
      if (selectable) {
        cell.classList.add('selectable');
        cell.addEventListener('click', (e) => toggle(hi, li, e.shiftKey));
      }
    };

    if (opts.layout === 'unified') {
      h.lines.forEach((l, li) => {
        const row = el('tr', { class: l.kind });
        const ln1 = el('td', { class: 'ln' }, l.oldNo === null ? '' : String(l.oldNo));
        const ln2 = el('td', { class: 'ln' }, l.newNo === null ? '' : String(l.newNo));
        const sign = el('td', { class: 'sign' }, l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : '');
        row.append(ln1, ln2, sign, code(l.text));
        if (l.kind !== 'ctx') mark(row, li);
        tbody.appendChild(row);
        if (l.noNewline) tbody.appendChild(el('tr', { class: 'meta' }, el('td', { class: 'ln' }), el('td', { class: 'ln' }), el('td', { class: 'sign' }), el('td', { class: 'code' }, '\\ No newline at end of file')));
      });
    } else {
      // Pair each run of removals with the run of additions that follows it.
      let i = 0;
      while (i < h.lines.length) {
        const l = h.lines[i];
        if (l.kind === 'ctx') {
          const row = el('tr', { class: 'ctx' });
          row.append(el('td', { class: 'ln' }, String(l.oldNo)), code(l.text), el('td', { class: 'ln' }, String(l.newNo)), code(l.text));
          tbody.appendChild(row);
          i++;
          continue;
        }
        const dels: number[] = [];
        const adds: number[] = [];
        while (i < h.lines.length && h.lines[i].kind === 'del') dels.push(i++);
        while (i < h.lines.length && h.lines[i].kind === 'add') adds.push(i++);
        const rows = Math.max(dels.length, adds.length);
        for (let r = 0; r < rows; r++) {
          const row = el('tr', { class: 'pair' });
          const d = dels[r] !== undefined ? h.lines[dels[r]] : null;
          const a = adds[r] !== undefined ? h.lines[adds[r]] : null;
          const dLn = el('td', { class: `ln ${d ? 'del' : 'empty'}` }, d ? String(d.oldNo) : '');
          const dCode = d ? code(d.text) : el('td', { class: 'code empty' });
          if (d) dCode.classList.add('del');
          const aLn = el('td', { class: `ln ${a ? 'add' : 'empty'}` }, a ? String(a.newNo) : '');
          const aCode = a ? code(a.text) : el('td', { class: 'code empty' });
          if (a) aCode.classList.add('add');
          if (d) {
            mark(dLn, dels[r]);
            mark(dCode, dels[r]);
          }
          if (a) {
            mark(aLn, adds[r]);
            mark(aCode, adds[r]);
          }
          row.append(dLn, dCode, aLn, aCode);
          tbody.appendChild(row);
        }
      }
    }
  });
  table.appendChild(tbody);
  return table;
}

/** A conflicted working file, with the <<<<<<< / ======= / >>>>>>> regions colored. */
export function renderConflict(text: string, path: string, highlight: boolean): HTMLElement {
  const lang = highlight ? languageFor(path) : null;
  const table = el('table', { class: 'diff conflict' });
  const tbody = el('tbody');
  let region: 'none' | 'ours' | 'theirs' = 'none';
  text.replace(/\r?\n$/, '').split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    let cls: 'none' | 'ours' | 'theirs' | 'marker' = region;
    if (line.startsWith('<<<<<<<')) {
      region = 'ours';
      cls = 'marker';
    } else if (line.startsWith('=======') && region === 'ours') {
      region = 'theirs';
      cls = 'marker';
    } else if (line.startsWith('>>>>>>>')) {
      region = 'none';
      cls = 'marker';
    }
    const row = el('tr', { class: cls });
    const td = el('td', { class: 'code' });
    if (cls === 'marker' || !lang) td.textContent = line || ' ';
    else td.innerHTML = highlightLine(line, lang) || ' ';
    row.append(el('td', { class: 'ln' }, String(i + 1)), el('td', { class: 'ln' }), el('td', { class: 'sign' }), td);
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  const note = el('div', { class: 'conflict-note' }, 'Edit the file in your editor, keep one side with the buttons on the file, then mark it resolved.');
  return el('div', {}, note, table);
}

export { escapeHtml };
