// Syntax colors for diff lines. highlight.js core with a hand-picked language set, chosen by file extension.
// Lines are highlighted one at a time, so a comment or string that spans lines may lose its color after
// the first line. That keeps the diff cheap and the markup per line simple.
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGS: Record<string, unknown> = {
  bash, c, cpp, csharp, css, dockerfile, go, ini, java, javascript, json, kotlin, lua, makefile, markdown, php,
  powershell, python, ruby, rust, scss, sql, swift, typescript, xml, yaml,
};
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def as never);

const BY_EXT: Record<string, string> = {
  sh: 'bash', bash: 'bash', zsh: 'bash',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ino: 'cpp',
  cs: 'csharp',
  css: 'css', scss: 'scss', sass: 'scss', less: 'scss',
  go: 'go',
  ini: 'ini', cfg: 'ini', conf: 'ini', toml: 'ini', properties: 'ini', editorconfig: 'ini',
  java: 'java',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'json', jsonl: 'json', json5: 'json',
  kt: 'kotlin', kts: 'kotlin',
  lua: 'lua',
  mk: 'makefile',
  md: 'markdown', markdown: 'markdown',
  php: 'php',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  py: 'python', pyi: 'python',
  rb: 'ruby', rake: 'ruby',
  rs: 'rust',
  sql: 'sql',
  swift: 'swift',
  xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml', xaml: 'xml', csproj: 'xml', plist: 'xml', vue: 'xml', svelte: 'xml',
  yml: 'yaml', yaml: 'yaml',
};
const BY_NAME: Record<string, string> = { dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile', rakefile: 'ruby', gemfile: 'ruby' };

export function languageFor(filePath: string): string | null {
  const base = filePath.split('/').pop()?.toLowerCase() ?? '';
  if (BY_NAME[base]) return BY_NAME[base];
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  return BY_EXT[ext] ?? null;
}

/** Returns HTML (escaped by highlight.js). Falls back to escaped plain text when the line will not parse. */
export function highlightLine(text: string, language: string): string {
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
