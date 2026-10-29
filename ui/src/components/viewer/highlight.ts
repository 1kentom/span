/**
 * Small line tokenizers for the read-only source panes (Markdown, MDX, HTML, SVG). Classes map to the
 * syntax colour tokens in viewer.css. Larger files skip this and render as plain text.
 */
export type TokenClass = 'tag' | 'attr' | 'string' | 'comment' | 'heading' | 'keyword' | 'code' | 'punct';
export interface Token { t: string; c?: TokenClass }
export type SourceLanguage = 'markdown' | 'mdx' | 'xml' | 'plain';

/** Above these the source pane renders plain text, one text node, so huge files stay cheap. */
export const HIGHLIGHT_MAX_LINES = 5000;
export const HIGHLIGHT_MAX_CHARS = 512 * 1024;

const xmlPattern = /(<!--.*?(?:-->|$))|(<\/?[\w:!-]+)|([\w:-]+)(?==)|("[^"]*"?|'[^']*'?)|(\/?>)|(\s+)|([^\s<>"'=]+|=)/g;
export function tokenizeXml(line: string): Token[] {
  const out: Token[] = [];
  for (const match of line.matchAll(xmlPattern)) {
    const [t, comment, tag, attr, str, end] = match;
    out.push({ t, c: comment ? 'comment' : tag || end ? 'tag' : attr ? 'attr' : str ? 'string' : undefined });
  }
  return out;
}

function tokenizeInlineMarkdown(line: string): Token[] {
  const out: Token[] = [];
  for (const part of line.split(/(`[^`]*`)/)) if (part) out.push(part.startsWith('`') && part.endsWith('`') && part.length > 1 ? { t: part, c: 'code' } : { t: part });
  return out;
}

const esm = /^(import|export)\b/;
export function tokenizeLines(language: SourceLanguage, lines: string[]): Token[][] {
  if (language === 'plain') return lines.map(line => [{ t: line }]);
  if (language === 'xml') return lines.map(tokenizeXml);
  let fence = '';
  return lines.map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) { if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = ''; return [{ t: line, c: marker ? 'comment' : 'string' }]; }
    if (marker) { fence = marker; return [{ t: line, c: 'comment' }]; }
    if (/^ {0,3}#{1,6}\s/.test(line)) return [{ t: line, c: 'heading' }];
    if (/^ {0,3}>/.test(line)) return [{ t: line, c: 'comment' }];
    if (language === 'mdx' && esm.test(line)) {
      const word = esm.exec(line)![1];
      return [{ t: word, c: 'keyword' }, ...line.slice(word.length).split(/("[^"]*"|'[^']*')/).filter(Boolean).map(part => /^["']/.test(part) ? { t: part, c: 'string' as const } : { t: part })];
    }
    if (language === 'mdx' && /^\s*<\/?[A-Z]/.test(line)) return tokenizeXml(line);
    const list = /^(\s*(?:[-*+]|\d+[.)])\s)/.exec(line);
    return list ? [{ t: list[1], c: 'keyword' }, ...tokenizeInlineMarkdown(line.slice(list[1].length))] : tokenizeInlineMarkdown(line);
  });
}
