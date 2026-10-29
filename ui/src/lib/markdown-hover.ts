import MarkdownIt, { type Token } from "markdown-it";
import { highlightTree } from "@lezer/highlight";
import { loadFenceLanguage, resolveLanguageId } from "../editor/languages";
import { tokenClassHighlighter } from "../editor/syntax-highlight";

/**
 * Safe markdown for language server hovers. Nothing here ever assigns server text to innerHTML:
 * markdown-it produces tokens, and every element is built with createElement. The small HTML subset
 * that Java and TypeScript docs use is rebuilt from an inert DOMParser tree through an allowlist that
 * keeps no attribute except a checked link target. Images, scripts and every other tag are dropped.
 */

export interface HoverLinkTarget { kind: "external" | "file"; url?: string; path?: string; line?: number; column?: number }

export interface HoverRenderOptions {
  doc?: Document;
  /** Language of the active file, used for fenced code without a language tag. */
  fallbackLanguage?: string;
  openExternal?: (url: string) => void;
  /** File links only. Command links and relative links are never followed. */
  navigate?: (target: { path: string; line?: number; column?: number }) => void;
}

export interface HoverRender {
  root: HTMLElement;
  /** Resolves when fenced code has been coloured. The text is readable before that. */
  highlighted: Promise<void>;
  /** True when nothing readable is left after cleaning. */
  empty: boolean;
}

const MAX_MARKDOWN = 20000;
const MAX_HIGHLIGHT = 8000;

// -------------------------------------------------------------- contents

interface MarkupContent { kind?: string; value: string }

const escapePlain = (text: string) => text.replace(/([\\`*_{}[\]()#+!<>|~])/g, "\\$1").replace(/\r?\n/g, "  \n");

/** Accepts MarkupContent, MarkedString, MarkedString[] and the bare markdown the backend sends. */
export function hoverContentsToMarkdown(contents: unknown): string {
  if (contents === null || contents === undefined) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(hoverContentsToMarkdown).filter(part => part.trim()).join("\n\n---\n\n");
  if (typeof contents !== "object") return "";
  const item = contents as Partial<MarkupContent & { language: string }>;
  if (typeof item.value !== "string") return "";
  if (typeof item.language === "string" && item.language) return `\`\`\`${item.language.replace(/[^\w+#.-]/g, "")}\n${item.value}\n\`\`\``;
  if (item.kind === "plaintext") return escapePlain(item.value);
  return item.value;
}

// ----------------------------------------------------------------- noise

const emphasis = "[\\s*_`:.,;\\-|()\\[\\]<>]";
const syntheticProject = /jdt\.ls-java-project/i;
const syntheticRest = new RegExp(`^${emphasis}*(?:source|project)?${emphasis}*$`, "i");

/** True for lines that only name the invisible project JDT LS creates for loose files. */
export function isSyntheticNoiseLine(line: string): boolean {
  if (!syntheticProject.test(line)) return false;
  return syntheticRest.test(line.replace(/jdt\.ls-java-project/gi, ""));
}

const isRule = (line: string) => /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line);
const isHeading = (line: string) => /^ {0,3}#{1,6}(?:\s|$)/.test(line);

/** Drops synthetic noise lines (outside code) and collapses sections that ended up empty. */
export function cleanHoverMarkdown(markdown: string): string {
  const source = markdown.length > MAX_MARKDOWN ? `${markdown.slice(0, MAX_MARKDOWN)}\n...` : markdown;
  let fence: string | undefined;
  const kept: string[] = [];
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && !raw.slice(raw.indexOf(marker) + marker.length).trim()) fence = undefined;
      kept.push(raw);
      continue;
    }
    if (!fence && isSyntheticNoiseLine(raw)) continue;
    kept.push(raw);
  }
  // JDT indents whole list sections by four or more spaces, which markdown reads as a code block. A run of
  // indented lines that opens with a list marker is a list: take off the indent they all share.
  fence = undefined;
  for (let i = 0; i < kept.length; i++) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(kept[i])?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; continue; }
    if (fence || !/^ {4,}(?:[*+-]|\d+[.)])\s/.test(kept[i]) || (i > 0 && kept[i - 1].trim() && /^ {4,}/.test(kept[i - 1]))) continue;
    let end = i;
    while (end < kept.length && (!kept[end].trim() || /^ {4,}/.test(kept[end]))) end++;
    const run = kept.slice(i, end);
    const shared = Math.min(...run.filter(line => line.trim()).map(line => /^ */.exec(line)![0].length));
    for (let k = i; k < end; k++) kept[k] = kept[k].slice(Math.min(shared, kept[k].length));
    i = end - 1;
  }
  // Collapse structure that has nothing left to separate or introduce.
  const result: string[] = [];
  fence = undefined;
  const lastContent = () => { for (let i = result.length - 1; i >= 0; i--) if (result[i].trim()) return result[i]; return undefined; };
  for (const line of kept) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; result.push(line); continue; }
    if (fence) { result.push(line); continue; }
    if (!line.trim()) { if (result.length && result[result.length - 1].trim()) result.push(""); continue; }
    if (isRule(line)) {
      const before = lastContent();
      if (before === undefined || isRule(before)) continue;
    }
    if (isHeading(lastContent() ?? "") && isRule(line)) continue;
    result.push(line);
  }
  // A heading with nothing under it, and a rule at the end, say nothing.
  const out = result.slice();
  const trim = () => { while (out.length && !out[out.length - 1].trim()) out.pop(); };
  trim();
  for (let again = true; again;) {
    again = false;
    const last = out[out.length - 1];
    if (last !== undefined && (isRule(last) || isHeading(last))) { out.pop(); trim(); again = true; }
  }
  const heads: string[] = [];
  for (let i = 0; i < out.length; i++) {
    if (isHeading(out[i])) {
      let j = i + 1;
      while (j < out.length && !out[j].trim()) j++;
      if (j < out.length && (isHeading(out[j]) || isRule(out[j]))) continue;
    }
    heads.push(out[i]);
  }
  while (heads.length && !heads[0].trim()) heads.shift();
  return heads.join("\n").replace(/\n{3,}/g, "\n\n");
}

// ----------------------------------------------------------------- links

/** Only http and https open externally, and only file links navigate. Everything else is refused. */
export function classifyLink(href: string): HoverLinkTarget | undefined {
  let parsed: URL;
  try { parsed = new URL(href.trim()); } catch { return undefined; }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") return { kind: "external", url: parsed.href };
  if (parsed.protocol === "file:") {
    let path: string;
    try { path = decodeURIComponent(parsed.pathname); } catch { return undefined; }
    if (!path || path.includes("\0")) return undefined;
    const position = /^#L?(\d+)(?:[,:C](\d+))?/i.exec(parsed.hash);
    return { kind: "file", path, line: position ? Number(position[1]) : undefined, column: position?.[2] ? Number(position[2]) : undefined };
  }
  return undefined;
}

// ------------------------------------------------------------------ html

const allowedTags = new Map<string, string>([
  ["p", "p"], ["br", "br"], ["code", "code"], ["tt", "code"], ["pre", "pre"], ["a", "a"], ["b", "strong"], ["strong", "strong"],
  ["i", "em"], ["em", "em"], ["ul", "ul"], ["ol", "ol"], ["li", "li"], ["blockquote", "blockquote"],
]);
const droppedWithContent = new Set(["script", "style", "iframe", "object", "embed", "svg", "math", "template", "noscript", "head", "title", "textarea", "select", "button"]);

class Builder {
  constructor(readonly doc: Document, readonly options: HoverRenderOptions, readonly pending: Promise<void>[]) {}

  link(element: HTMLAnchorElement, href: string | null | undefined): boolean {
    const target = href ? classifyLink(href) : undefined;
    if (!target) return false;
    element.setAttribute("href", target.kind === "external" ? target.url! : "#");
    element.dataset.hoverLink = target.kind;
    if (target.kind === "external") { element.dataset.url = target.url; element.rel = "noopener noreferrer"; element.title = target.url!; }
    else { element.dataset.path = target.path; if (target.line) element.dataset.line = String(target.line); if (target.column) element.dataset.column = String(target.column); element.title = target.path!; }
    return true;
  }

  /** Copies an inert parsed tree into fresh elements. Unknown tags vanish but their text stays. */
  sanitize(node: Node, parent: Node): void {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) { parent.appendChild(this.doc.createTextNode(child.nodeValue ?? "")); continue; }
      if (child.nodeType !== 1) continue;
      const source = child as Element;
      const name = source.localName.toLowerCase();
      if (droppedWithContent.has(name) || name === "img") continue;
      const tag = allowedTags.get(name);
      if (!tag) { this.sanitize(source, parent); continue; }
      if (tag === "br") { parent.appendChild(this.doc.createElement("br")); continue; }
      if (tag === "pre") { this.codeBlock(source.textContent?.replace(/^\n/, "").replace(/\n$/, "") ?? "", "", parent); continue; }
      const element = this.doc.createElement(tag);
      if (tag === "a" && !this.link(element as HTMLAnchorElement, source.getAttribute("href"))) { this.sanitize(source, parent); continue; }
      this.sanitize(source, element);
      parent.appendChild(element);
    }
  }

  html(content: string, parent: Node): void {
    const parsed = new DOMParser().parseFromString(`<!doctype html><body>${content}`, "text/html");
    this.sanitize(parsed.body, parent);
  }

  codeBlock(code: string, info: string, parent: Node): void {
    const wrap = this.doc.createElement("div");
    wrap.className = "cm-lsp-code";
    const pre = this.doc.createElement("pre");
    const element = this.doc.createElement("code");
    const declared = info.trim().split(/\s+/, 1)[0]?.replace(/[{},]+$/g, "").toLowerCase().replace(/^language-/, "") ?? "";
    const hint = declared || this.options.fallbackLanguage || "";
    const language = resolveLanguageId(hint);
    if (declared) element.dataset.lang = declared;
    element.textContent = code;
    pre.appendChild(element);
    wrap.appendChild(pre);
    parent.appendChild(wrap);
    if (language !== "text" && code.length <= MAX_HIGHLIGHT) this.pending.push(highlightInto(element, code, hint, this.doc));
  }

  inline(children: Token[] | null | undefined, parent: Node): void {
    const stack: Node[] = [parent];
    // Parallel to `stack`: the html tag name that opened each level, so a closing tag only closes its own.
    const names: (string | undefined)[] = [undefined];
    const top = () => stack[stack.length - 1];
    let skipping: string | undefined;
    const open = (element: Node, name?: string) => { top().appendChild(element); stack.push(element); names.push(name); };
    const close = () => { if (stack.length > 1) { stack.pop(); names.pop(); } };
    for (const token of children ?? []) {
      if (skipping) {
        if (token.type === "html_inline") { const tag = parseTag(token.content); if (tag && tag.close && tag.name === skipping) skipping = undefined; }
        continue;
      }
      switch (token.type) {
        case "text": top().appendChild(this.doc.createTextNode(token.content)); break;
        case "code_inline": { const code = this.doc.createElement("code"); code.textContent = token.content; top().appendChild(code); break; }
        case "softbreak": top().appendChild(this.doc.createTextNode(" ")); break;
        case "hardbreak": top().appendChild(this.doc.createElement("br")); break;
        case "strong_open": open(this.doc.createElement("strong")); break;
        case "em_open": open(this.doc.createElement("em")); break;
        case "s_open": open(this.doc.createElement("s")); break;
        case "strong_close": case "em_close": case "s_close": close(); break;
        case "link_open": {
          const anchor = this.doc.createElement("a");
          // A link that fails the check keeps its label as plain text: the label goes straight into the parent.
          if (this.link(anchor, String(token.attrGet("href") ?? ""))) open(anchor);
          else { stack.push(top()); names.push(undefined); }
          break;
        }
        case "link_close": close(); break;
        case "html_inline": {
          const tag = parseTag(token.content);
          if (!tag) break;
          if (droppedWithContent.has(tag.name)) { if (!tag.close && !tag.selfClosing) skipping = tag.name; break; }
          const mapped = allowedTags.get(tag.name);
          if (!mapped) break;
          if (tag.close) {
            // Close only what this run of html opened, never an outer markdown element.
            for (let i = stack.length - 1; i > 0; i--) if (names[i] === tag.name) { stack.length = i; names.length = i; break; }
            break;
          }
          if (mapped === "br") { top().appendChild(this.doc.createElement("br")); break; }
          const element = this.doc.createElement(mapped);
          if (mapped === "a" && !this.link(element as HTMLAnchorElement, tag.href)) break;
          if (tag.selfClosing) break;
          open(element, tag.name);
          break;
        }
        default: break; // images and anything unknown are dropped
      }
    }
  }
}

interface ParsedTag { name: string; close: boolean; selfClosing: boolean; href?: string }

function parseTag(source: string): ParsedTag | undefined {
  const match = /^<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>$/.exec(source.trim());
  if (!match) return undefined;
  const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(match[3]);
  return { name: match[2].toLowerCase(), close: Boolean(match[1]), selfClosing: /\/\s*$/.test(match[3]), href: href ? (href[1] ?? href[2] ?? href[3]) : undefined };
}

// ------------------------------------------------------------ highlighting

async function highlightInto(target: HTMLElement, code: string, hint: string, doc: Document): Promise<void> {
  try {
    const language = await loadFenceLanguage(hint);
    if (!language || !target.isConnected && !target.parentNode) return;
    const tree = language.parser.parse(code);
    const fragment = doc.createDocumentFragment();
    let at = 0;
    const plain = (to: number) => { if (to > at) fragment.appendChild(doc.createTextNode(code.slice(at, to))); at = Math.max(at, to); };
    highlightTree(tree, tokenClassHighlighter, (from, to, classes) => {
      if (from < at) return;
      plain(from);
      const span = doc.createElement("span");
      span.className = classes;
      span.textContent = code.slice(from, to);
      fragment.appendChild(span);
      at = to;
    });
    plain(code.length);
    target.replaceChildren(fragment);
  } catch {
    // The plain text stays; colour is a courtesy.
  }
}

// ------------------------------------------------------------------ render

const parser = new MarkdownIt({ html: true, linkify: false, breaks: false, typographer: false });
// Targets are checked by `classifyLink` when the anchor is built, so a refused link keeps its label instead of showing raw source.
parser.validateLink = () => true;

const blockTags = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "blockquote", "table", "thead", "tbody", "tr", "th", "td"]);

/** Renders hover markdown into a detached element. The result is safe to insert as is. */
export function renderHoverMarkdown(markdown: string, options: HoverRenderOptions = {}): HoverRender {
  const doc = options.doc ?? document;
  const cleaned = cleanHoverMarkdown(markdown);
  const root = doc.createElement("div");
  root.className = "cm-lsp-markdown";
  const pending: Promise<void>[] = [];
  const builder = new Builder(doc, options, pending);
  if (cleaned.trim()) {
    const tokens = parser.parse(cleaned, {});
    const stack: Node[] = [root];
    const pushed: boolean[] = [];
    const top = () => stack[stack.length - 1];
    for (const token of tokens) {
      const tag = token.tag;
      if (token.nesting === 1 && token.type.endsWith("_open")) {
        if (token.type === "paragraph_open" && token.hidden) { pushed.push(false); continue; }
        if (!blockTags.has(tag)) { pushed.push(false); continue; }
        const element = doc.createElement(tag);
        if (tag === "ol") { const start = Number(token.attrGet("start")); if (Number.isInteger(start) && start > 1 && start < 100000) element.setAttribute("start", String(start)); }
        const align = (tag === "th" || tag === "td") ? /text-align:\s*(left|right|center)/.exec(String(token.attrGet("style") ?? "")) : null;
        if (align) element.className = `align-${align[1]}`;
        top().appendChild(element);
        stack.push(element);
        pushed.push(true);
        continue;
      }
      if (token.nesting === -1 && token.type.endsWith("_close")) {
        if (pushed.pop()) stack.pop();
        continue;
      }
      switch (token.type) {
        case "inline": builder.inline(token.children, top()); break;
        case "fence": builder.codeBlock(token.content.replace(/\n$/, ""), token.info, top()); break;
        case "code_block": builder.codeBlock(token.content.replace(/\n$/, ""), "", top()); break;
        case "hr": top().appendChild(doc.createElement("hr")); break;
        case "html_block": builder.html(token.content, top()); break;
        default: break;
      }
    }
    const first = root.querySelector(":scope > .cm-lsp-code");
    if (first && root.firstElementChild === first) first.classList.add("cm-lsp-signature");
  }
  const attach = (event: Event) => handleLinkEvent(event, options);
  root.addEventListener("click", attach);
  root.addEventListener("auxclick", attach);
  const empty = !root.textContent?.trim() && !root.querySelector("hr, img");
  return { root, empty, highlighted: Promise.all(pending).then(() => undefined) };
}

function handleLinkEvent(event: Event, options: HoverRenderOptions) {
  const anchor = (event.target as Element | null)?.closest?.("a");
  if (!anchor) return;
  event.preventDefault();
  if (event.type !== "click") return;
  const kind = (anchor as HTMLElement).dataset.hoverLink;
  if (kind === "external" && (anchor as HTMLElement).dataset.url) {
    const target = classifyLink((anchor as HTMLElement).dataset.url!);
    if (target?.kind === "external") options.openExternal?.(target.url!);
  } else if (kind === "file" && (anchor as HTMLElement).dataset.path) {
    const data = (anchor as HTMLElement).dataset;
    options.navigate?.({ path: data.path!, line: data.line ? Number(data.line) : undefined, column: data.column ? Number(data.column) : undefined });
  }
}
