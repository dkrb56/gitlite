// Tiny DOM helpers.

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') node.addEventListener(k.replace(/^on/, '').toLowerCase(), v);
    else if (typeof v === 'boolean') {
      if (v) node.setAttribute(k, '');
    } else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c);
  }
  return node;
}

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Modal text prompt (window.prompt is not available in Electron).
export function ask(title: string, placeholder = ''): Promise<string | null> {
  const modal = $('modal');
  const input = $<HTMLInputElement>('modal-input');
  $('modal-title').textContent = title;
  input.value = '';
  input.placeholder = placeholder;
  modal.hidden = false;
  input.focus();
  return new Promise((resolve) => {
    const done = (value: string | null) => {
      modal.hidden = true;
      $('modal-ok').removeEventListener('click', ok);
      $('modal-cancel').removeEventListener('click', cancel);
      input.removeEventListener('keydown', key);
      resolve(value);
    };
    const ok = () => done(input.value.trim() || null);
    const cancel = () => done(null);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Enter') ok();
      if (e.key === 'Escape') cancel();
    };
    $('modal-ok').addEventListener('click', ok);
    $('modal-cancel').addEventListener('click', cancel);
    input.addEventListener('keydown', key);
  });
}
