/**
 * Allowlist rebuild of converted document HTML, in the spirit of sanitizeSvg in asset-preview.ts.
 * The input is parsed into an inert document by DOMParser (nothing runs, nothing loads), then a new
 * DOM is built element by element in the live document from a fixed tag and attribute allowlist.
 * The result is never assigned through innerHTML.
 *
 * Policy: scripts, styles, frames, objects, forms controls, SVG and MathML are removed with their content.
 * Unknown elements are unwrapped (their text is kept). No style or event attribute survives. Links keep
 * only in-document anchors; any other link becomes inert text with the address as a tooltip when it is
 * http, https or mailto. Images are accepted only through tokens issued by the converter for images
 * embedded in the document, and only when the token resolves to a raster data URL.
 */
export const DOC_ID_PREFIX = 'docx-';
export const MAX_DOC_DEPTH = 64;

const allowed = new Set(['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'a', 'img', 'blockquote', 'pre', 'code', 'hr']);
const dropped = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript', 'template', 'title', 'meta', 'base', 'link', 'svg', 'math', 'head', 'input', 'select', 'textarea', 'option', 'audio', 'video', 'source', 'track', 'canvas', 'param', 'portal', 'dialog']);
const rasterDataUrl = /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/]+=*$/;
const imageToken = /^docx-image:\d+$/;

export interface SanitizeOptions { images: ReadonlyMap<string, string>; maxDepth?: number }
export interface SanitizeResult { fragment: DocumentFragment; truncated: boolean; removed: number }

const safeId = (value: string) => `${DOC_ID_PREFIX}${value.replace(/[^\w-]/g, '_').slice(0, 120)}`;
const span = (value: string | null) => { const n = Number(value); return Number.isInteger(n) && n > 0 && n <= 1000 ? String(n) : undefined; };

export function sanitizeDocHtml(html: string, options: SanitizeOptions): SanitizeResult {
  const input = new DOMParser().parseFromString(html, 'text/html');
  const fragment = document.createDocumentFragment();
  const maxDepth = options.maxDepth ?? MAX_DOC_DEPTH;
  let truncated = false, removed = 0;

  const copyChildren = (from: Node, to: Node, depth: number): void => {
    if (depth > maxDepth) { truncated = true; return; }
    for (const child of Array.from(from.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) { to.appendChild(document.createTextNode(child.textContent ?? '')); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as Element;
      const tag = element.localName;
      if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || dropped.has(tag)) { removed++; continue; }
      if (!allowed.has(tag)) { removed++; copyChildren(element, to, depth + 1); continue; }
      if (tag === 'img') {
        const src = element.getAttribute('src') ?? '';
        const data = imageToken.test(src) ? options.images.get(src) : undefined;
        if (!data || !rasterDataUrl.test(data)) { removed++; continue; }
        const img = document.createElement('img');
        img.setAttribute('src', data);
        img.setAttribute('alt', (element.getAttribute('alt') ?? '').slice(0, 500));
        to.appendChild(img);
        continue;
      }
      if (tag === 'a') {
        const href = element.getAttribute('href') ?? '';
        let out: HTMLElement;
        if (/^#[\w-]{1,120}$/.test(href)) { out = document.createElement('a'); out.setAttribute('href', `#${safeId(href.slice(1))}`); }
        else {
          out = document.createElement('span');
          out.className = 'ox-doc-link';
          if (/^(?:https?:\/\/|mailto:)/i.test(href) && href.length <= 2048) out.title = href;
          else if (href) removed++;
        }
        const id = element.getAttribute('id');
        if (id) out.id = safeId(id);
        to.appendChild(out);
        copyChildren(element, out, depth + 1);
        continue;
      }
      const out = document.createElement(tag);
      const id = element.getAttribute('id');
      if (id) out.id = safeId(id);
      if (tag === 'td' || tag === 'th') {
        const colspan = span(element.getAttribute('colspan')), rowspan = span(element.getAttribute('rowspan'));
        if (colspan) out.setAttribute('colspan', colspan);
        if (rowspan) out.setAttribute('rowspan', rowspan);
      }
      if (tag === 'ol') { const start = span(element.getAttribute('start')); if (start) out.setAttribute('start', start); }
      to.appendChild(out);
      copyChildren(element, out, depth + 1);
    }
  };
  copyChildren(input.body, fragment, 0);
  return { fragment, truncated, removed };
}
