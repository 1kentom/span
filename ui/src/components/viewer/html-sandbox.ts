/**
 * Prepares an uploaded HTML file for an iframe with an empty sandbox attribute (no allow-scripts, no
 * allow-same-origin). The sandbox already stops scripts; this pass also removes everything that would fetch
 * from the network or run code if the sandbox were ever loosened, and adds a no-network CSP as a second line.
 * Referenced local files are never loaded: they are listed so the viewer can say they are not available.
 */

export interface SandboxResult {
  html: string;
  /** Local files the page references (stylesheets, images, scripts), in order, once each. */
  missing: string[];
  removed: { scripts: number; handlers: number; external: number; frames: number };
}

export const SANDBOX_CSP = "default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";

const urlAttributes = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'background', 'cite', 'longdesc', 'data', 'ping', 'manifest', 'codebase', 'lowsrc', 'dynsrc', 'icon', 'profile', 'usemap']);
const listAttributes = new Set(['srcset', 'imagesrcset']);
const dropElements = 'script,noscript,iframe,frame,frameset,object,embed,applet,portal,base,link,template[shadowrootmode],meta[http-equiv]';
const inertImage = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);/i;
const frameTags = new Set(['iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal']);

type Kind = 'local' | 'external' | 'script' | 'data' | 'anchor' | 'empty';
function classify(raw: string): Kind {
  // Browsers ignore control characters and whitespace inside schemes, so the check does too.
  const value = raw.replace(/[\u0000- \u007f]+/g, '');
  if (!value) return 'empty';
  if (value.startsWith('#')) return 'anchor';
  if (/^(?:java|vb)script:/i.test(value)) return 'script';
  if (/^data:/i.test(value)) return 'data';
  if (value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) return 'external';
  return 'local';
}

export function sanitizeHtmlForSandbox(source: string): SandboxResult {
  const missing: string[] = [];
  const removed = { scripts: 0, handlers: 0, external: 0, frames: 0 };
  const note = (kind: Kind, value: string) => {
    if (kind === 'local') { const path = value.trim().split(/[?#]/)[0]; if (path && !missing.includes(path)) missing.push(path); }
    else if (kind === 'external') removed.external++;
    else if (kind === 'script') removed.scripts++;
  };
  const cleanCss = (css: string): string => {
    // Decode CSS escapes first so u\72l( cannot hide a url() from the checks below.
    let text = css.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_all, hex: string) => { const code = parseInt(hex, 16); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''; })
      .replace(/\\([\s\S])/g, '$1');
    text = text.replace(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]*)\1\s*\)?[^;]*;?/gi, (_all, _q, target: string) => { note(classify(target), target); return ''; });
    text = text.replace(/url\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi, (all, _q, target: string) => {
      const kind = classify(target);
      if (kind === 'data' && inertImage.test(target.trim())) return all;
      if (kind === 'anchor') return all;
      note(kind, target);
      return 'none';
    });
    text = text.replace(/image-set\([^)]*\)|expression\([^)]*\)|-moz-binding\s*:[^;}]*/gi, 'none');
    return text;
  };

  const doc = new DOMParser().parseFromString(source, 'text/html');
  // One pass in document order, so missing files are listed in the order the page references them.
  for (const element of [...doc.querySelectorAll('*')]) {
    if (!element.isConnected) continue;
    const tag = element.localName;
    if (element.matches(dropElements)) {
      if (tag === 'script') { removed.scripts++; const src = element.getAttribute('src'); if (src && classify(src) === 'local') note('local', src); }
      else if (frameTags.has(tag)) removed.frames++;
      else if (tag === 'link') { const href = element.getAttribute('href'); if (href && /\bstylesheet\b/i.test(element.getAttribute('rel') ?? '')) note(classify(href), href); else if (href && classify(href) === 'external') removed.external++; }
      element.remove();
      continue;
    }
    if (tag === 'style') element.textContent = cleanCss(element.textContent ?? '');
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name.startsWith('on')) { element.removeAttribute(attribute.name); removed.handlers++; continue; }
      if (name === 'style') { element.setAttribute('style', cleanCss(value)); continue; }
      if (name === 'srcdoc' || name === 'target') { element.removeAttribute(attribute.name); continue; }
      if (listAttributes.has(name)) {
        for (const candidate of value.split(',')) { const url = candidate.trim().split(/\s+/)[0]; if (url) note(classify(url), url); }
        element.removeAttribute(attribute.name); continue;
      }
      if (!urlAttributes.has(name)) continue;
      const kind = classify(value);
      if (kind === 'anchor' || kind === 'empty') continue;
      if (kind === 'data' && inertImage.test(value.trim()) && (name === 'src' || name === 'poster')) continue;
      // Anchors to other local pages cannot navigate inside the sandbox; they are not "missing" resources.
      const isNavigation = name === 'href' && (tag === 'a' || tag === 'area');
      if (!(isNavigation && kind === 'local')) note(kind === 'data' ? 'script' : kind, value);
      element.removeAttribute(attribute.name);
    }
  }
  const head = doc.head ?? doc.documentElement.insertBefore(doc.createElement('head'), doc.body);
  const referrer = doc.createElement('meta'); referrer.setAttribute('name', 'referrer'); referrer.setAttribute('content', 'no-referrer');
  const policy = doc.createElement('meta'); policy.setAttribute('http-equiv', 'Content-Security-Policy'); policy.setAttribute('content', SANDBOX_CSP);
  head.prepend(policy, referrer);
  return { html: `<!doctype html>\n${doc.documentElement.outerHTML}`, missing, removed };
}
