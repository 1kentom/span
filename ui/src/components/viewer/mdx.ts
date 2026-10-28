/**
 * Reduces MDX to plain Markdown for preview. Nothing is compiled or evaluated: ESM import and export
 * statements, JSX component tags and {expressions} are removed as text, and the remaining Markdown goes
 * through the existing MarkdownPreview (markdown-it with raw HTML disabled). Fenced code is left untouched.
 */

export interface MdxReduction { markdown: string; components: string[]; removedExpressions: number }

const fence = /^ {0,3}(`{3,}|~{3,})/;

/** Index just past the balanced construct starting at `start` (a `{` or a `<`), honouring quotes and braces. */
function scanBalanced(text: string, start: number): number {
  let depth = 0, quote = '';
  const open = text[start], close = open === '{' ? '}' : '>';
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (open === '{' && depth === 0) return i + 1; }
    else if (open === '<' && c === close && depth === 0) return i + 1;
  }
  return text.length;
}

/** Drops top-level import and export statements, including ones that span lines. */
function dropEsm(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^(?:import|export)\b/.test(lines[i])) { out.push(lines[i]); continue; }
    let balance = 0;
    for (;;) {
      for (const c of lines[i].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '')) { if ('{(['.includes(c)) balance++; else if ('})]'.includes(c)) balance--; }
      if (balance <= 0 || i === lines.length - 1) break;
      i++;
    }
  }
  return out;
}

function reduceProse(text: string, components: Set<string>): { text: string; expressions: number } {
  let out = '', expressions = 0;
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '`') { const end = text.indexOf('`', i + 1); const stop = end < 0 ? text.length : end + 1; out += text.slice(i, stop); i = stop; continue; }
    const tag = c === '<' ? /^<\/?([A-Z][\w.]*)|^<\/?>/.exec(text.slice(i, i + 80)) : null;
    if (tag) { if (tag[1]) components.add(tag[1].split('.')[0]); i = scanBalanced(text, i); continue; }
    if (c === '{') { expressions++; i = scanBalanced(text, i); continue; }
    out += c; i++;
  }
  return { text: out, expressions };
}

export function mdxToMarkdown(source: string): MdxReduction {
  const components = new Set<string>();
  let removedExpressions = 0;
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const parts: string[] = [];
  let prose: string[] = [];
  let open = '';
  const flush = () => {
    if (!prose.length) return;
    const reduced = reduceProse(dropEsm(prose).join('\n'), components);
    removedExpressions += reduced.expressions;
    parts.push(reduced.text.split('\n').map(line => line.trim() ? line : '').join('\n'));
    prose = [];
  };
  for (const line of lines) {
    const marker = fence.exec(line)?.[1];
    if (open) { parts.push(line); if (marker && marker[0] === open[0] && marker.length >= open.length) open = ''; continue; }
    if (marker) { flush(); open = marker; parts.push(line); continue; }
    prose.push(line);
  }
  flush();
  return { markdown: parts.join('\n').replace(/\n{3,}/g, '\n\n'), components: [...components].sort(), removedExpressions };
}
