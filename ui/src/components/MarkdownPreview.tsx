import { Index, createEffect, createMemo, createSignal, untrack, onCleanup, onMount, type JSX } from "solid-js";
import type { Text } from "@codemirror/state";
import type { ImageSource } from "../bindings";
import MarkdownIt, { type Token, type Env } from "markdown-it";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { loadFenceLanguage } from "../editor/languages";
import { describeMarkdownFence, type MarkdownRunRequest } from "../lib/markdown-fences";
export type { MarkdownRunRequest } from "../lib/markdown-fences";
import { enhanceTables, installTableRules } from "../lib/markdown-tables";
import "../styles/markdown.css";

export interface MarkdownPreviewProps {
  text: string | Text;
  documentPath: string;
  workspaceRoot: string;
  active?: boolean;
  loadImage?: (path: string) => Promise<ImageSource>;
  onOpenFile?: (path: string) => void;
  onOpenExternal?: (url: string) => void;
  onRunCode?: (request: MarkdownRunRequest) => void | Promise<void>;
}

type Destination = { kind: "anchor" | "external" | "file"; value: string } | null;
interface RenderContext extends Env {
  documentPath: string;
  workspaceRoot: string;
  canRun?: boolean;
  /**
   * Agent output: agents name files by absolute path, often with a `:line` or `:line:column` suffix. With this set,
   * an absolute path inside the workspace root is a file link and the suffix is dropped. Documents keep the
   * relative-only policy.
   */
  agentPaths?: boolean;
}
export interface MarkdownBlock { tokens: Token[]; key: string; lines: number; headingIds: string[] }
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** Resolve lexical paths here; the workspace bridge still verifies canonical containment. */
export function markdownDestination(raw: string, context: RenderContext): Destination {
  if (!raw || /[\u0000-\u0020\u007f\\]/.test(raw)) return null;
  if (raw.startsWith("#")) {
    try { return { kind: "anchor", value: decodeURIComponent(raw.slice(1)) }; } catch { return null; }
  }
  if (/^https?:\/\//i.test(raw) || /^mailto:/i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.username || url.password || !["https:", "http:", "mailto:"].includes(url.protocol)) return null;
      return { kind: "external", value: url.href };
    } catch { return null; }
  }
  const root = context.workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  let path = raw;
  let absolute = false;
  if (context.agentPaths) {
    path = path.replace(/(?<=[^/:]):\d+(?::\d+)?$/, "");
    if (root && path.startsWith(`${root}/`)) {
      path = path.slice(root.length + 1);
      absolute = true;
    }
  }
  if (/^[a-z][\w+.-]*:/i.test(path) || path.startsWith("/")) return null;
  let relative: string;
  try { relative = decodeURIComponent(path.split(/[?#]/, 1)[0]); } catch { return null; }
  if (!relative || /[\u0000-\u001f\u007f\\:]/.test(relative) || relative.startsWith("/")) return null;
  const document = context.documentPath.replace(/\\/g, "/");
  if (!root || !document.startsWith(`${root}/`)) return null;
  const segments = absolute ? [""] : document.slice(root.length + 1).split("/");
  segments.pop();
  for (const segment of relative.split("/")) {
    if (segment === "..") { if (!segments.length) return null; segments.pop(); }
    else if (segment && segment !== ".") segments.push(segment);
  }
  return segments.length ? { kind: "file", value: `${root}/${segments.join("/")}` } : null;
}

const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
markdown.renderer.rules.link_open = (tokens, index, _options, env) => {
  const token = tokens[index];
  const destination = markdownDestination(String(token.attrGet("href") ?? ""), env as RenderContext);
  const title = token.attrGet("title");
  if (!destination) return '<a class="markdown-invalid-link" aria-disabled="true">';
  const label = title ? ` title="${escape(String(title))}"` : "";
  if (destination.kind === "external") return `<a href="${escape(destination.value)}" target="_blank" rel="noopener noreferrer" data-markdown-external="${escape(destination.value)}"${label}>`;
  if (destination.kind === "anchor") return `<a href="#${escape(encodeURIComponent(destination.value))}" data-markdown-anchor="${escape(destination.value)}"${label}>`;
  return `<a href="#" data-markdown-file="${escape(destination.value)}"${label}>`;
};
markdown.renderer.rules.image = (tokens, index, _options, env, renderer) => {
  const token = tokens[index];
  const alt = renderer.renderInlineAsText(token.children ?? [], markdown.options, env);
  const source = String(token.attrGet("src") ?? "");
  const destination = markdownDestination(source, env as RenderContext);
  const caption = escape(alt || "Image");
  if (destination?.kind === "external" && /^https?:/.test(destination.value)) {
    return `<span class="markdown-image-placeholder"><span>${caption}</span><button type="button" data-markdown-image="${escape(destination.value)}" data-image-alt="${escape(alt)}">Load remote image</button></span>`;
  }
  if (destination?.kind === "file") return `<span class="markdown-image-placeholder" role="img" aria-label="${caption}" data-markdown-local-image="${escape(destination.value)}" data-image-alt="${escape(alt)}"><span>${caption}</span><small>Local image unavailable: ${escape(source)}</small></span>`;
  return `<span class="markdown-image-placeholder" role="img" aria-label="${caption}"><span>${caption}</span><small>Image source blocked</small></span>`;
};
markdown.renderer.rules.fence = (tokens, index, _options, env) => {
  const token = tokens[index];
  const fence = describeMarkdownFence(token.info, token.content);
  const canRun = !!(env as RenderContext)?.canRun && !!fence.action;
  const action = fence.action === "send" ? "Send code to terminal for review" : "Run code in terminal";
  const reason = fence.disabledReason || "A native terminal is required";
  const tooltip = canRun ? `${action}\n${fence.command?.slice(0, 240) ?? ""}` : reason;
  const info = fence.declared || (token.info.trim() ? "text" : "");
  const languageTitle = fence.language === "text" && fence.declared && !["text", "txt", "plaintext", "plain", "none"].includes(fence.declared) ? `Unsupported language: ${fence.declared}. Displayed as plain text.` : fence.label;
  return `<div class="markdown-code-block"><div class="markdown-code-header"><span class="markdown-code-language" title="${escape(languageTitle)}">${escape(fence.label)}</span><span class="markdown-code-status" role="status" aria-live="polite"></span><button type="button" class="markdown-code-action" data-markdown-copy aria-label="Copy code" title="Copy code"><span class="icon markdown-copy-icon" aria-hidden="true"></span></button><button type="button" class="markdown-code-action" data-markdown-run aria-label="${action}" title="${escape(tooltip)}"${canRun ? "" : " disabled"}><span class="icon ${fence.action === "send" ? "markdown-terminal-icon" : "markdown-run-icon"}" aria-hidden="true"></span></button></div><pre class="markdown-code"><code data-language="${fence.language}" data-fence-info="${escape(info)}" data-source-line="${(token.map?.[0] ?? 0) + 2}">${escape(token.content)}</code></pre></div>\n`;
};
installTableRules(markdown);
markdown.renderer.rules.task_checkbox = (tokens, index) => `<input type="checkbox" disabled${tokens[index].meta?.checked ? " checked" : ""} aria-label="${tokens[index].meta?.checked ? "Completed task" : "Incomplete task"}"> `;

/** Parse once, then render independent top-level blocks only as they approach the viewport. */
export function parseMarkdown(text: string): MarkdownBlock[] {
  const tokens = markdown.parse(text, {});
  const headings = new Set<string>();
  let listDepth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === "list_item_open") listDepth++;
    if (token.type === "list_item_close") listDepth--;
    if (token.type === "heading_open") {
      const inline = tokens[index + 1];
      const label = (inline.children ?? []).map((child) => child.type === "text" || child.type === "code_inline" ? child.content : "").join("");
      const base = label.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s+/g, "-") || "heading";
      let id = base;
      let suffix = 0;
      while (headings.has(id)) id = `${base}-${++suffix}`;
      headings.add(id);
      token.attrSet("id", id);
    }
    if (listDepth && token.type === "inline" && tokens[index - 1]?.type === "paragraph_open") {
      const first = token.children?.[0];
      const match = first?.type === "text" ? /^\[([ xX])\]\s+/.exec(first.content) : null;
      if (match && first) {
        first.content = first.content.slice(match[0].length);
        const checkbox = new MarkdownIt.Token("task_checkbox", "input", 0);
        checkbox.meta = { checked: match[1].toLowerCase() === "x" };
        token.children!.unshift(checkbox);
      }
    }
  }
  const blocks: MarkdownBlock[] = [];
  let pending: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    pending.push(token);
    depth += token.nesting;
    if (depth === 0) {
      const first = pending.find((item) => item.map)?.map;
      const last = [...pending].reverse().find((item) => item.map)?.map;
      const lines = first && last ? Math.max(1, last[1] - first[0]) : 1;
      blocks.push({ tokens: pending, key: JSON.stringify(pending, (name, value) => name === "map" ? undefined : value), lines, headingIds: pending.filter((item) => item.type === "heading_open").map((item) => String(item.attrGet("id"))) });
      pending = [];
    }
  }
  return blocks;
}

export function renderMarkdownBlock(block: MarkdownBlock, context: RenderContext): string {
  return markdown.renderer.render(block.tokens, markdown.options, context);
}

export async function highlightFence(element: HTMLElement) {
  const code = element.textContent ?? "";
  if (!code || code.length > 40_000) return;
  const name = element.dataset.language ?? "";
  const language = await loadFenceLanguage(name);
  if (!language || !element.isConnected || element.textContent !== code) return;
  const ranges: { from: number; to: number; classes: string }[] = [];
  highlightTree(language.parser.parse(code), classHighlighter, (from, to, classes) => ranges.push({ from, to, classes }));
  if (name === "shell") {
    // The bundled shell grammar has a fixed command dictionary. Package managers added later still need command styling.
    const packageCommands = /(^|[;&|])[ \t]*(?:\$[ \t]+)?(npm|pnpm|yarn|bun|npx)(?=[ \t]|$)/gm;
    for (const match of code.matchAll(packageCommands)) {
      const from = match.index! + match[0].lastIndexOf(match[2]);
      const to = from + match[2].length;
      if (!ranges.some((range) => range.from < to && range.to > from)) ranges.push({ from, to, classes: "tok-variableName tok-commandName" });
    }
    ranges.sort((left, right) => left.from - right.from);
  }
  const fragment = document.createDocumentFragment();
  let position = 0;
  for (const { from, to, classes } of ranges) {
    fragment.append(document.createTextNode(code.slice(position, from)));
    const span = document.createElement("span");
    span.className = classes;
    span.textContent = code.slice(from, to);
    fragment.append(span);
    position = to;
  }
  fragment.append(document.createTextNode(code.slice(position)));
  element.replaceChildren(fragment);
}

async function loadLocalImage(placeholder: HTMLElement, load: NonNullable<MarkdownPreviewProps["loadImage"]>) {
  const path = placeholder.dataset.markdownLocalImage;
  if (!path) return;
  delete placeholder.dataset.markdownLocalImage;
  const message = placeholder.querySelector("small");
  if (message) message.textContent = "Loading local image";
  try {
    const image = await load(path);
    const rasterMime = /^image\/(?:png|jpeg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon|avif)$/;
    if (!rasterMime.test(image.mime) || !image.dataUrl.startsWith(`data:${image.mime};base64,`)) throw new Error("Unsupported image format");
    if (!placeholder.isConnected) return;
    const img = document.createElement("img");
    img.alt = placeholder.dataset.imageAlt ?? "";
    img.src = image.dataUrl;
    img.addEventListener("error", () => { img.replaceWith(document.createTextNode("Local image could not be displayed")); }, { once: true });
    placeholder.removeAttribute("role");
    placeholder.removeAttribute("aria-label");
    placeholder.replaceChildren(img);
  } catch {
    if (message) message.textContent = "Local image unavailable or unsupported";
  }
}

function PreviewBlock(props: { block: MarkdownBlock; context: RenderContext; index: number; requested: number; observe: (element: Element, reveal: () => void) => () => void; loadImage?: MarkdownPreviewProps["loadImage"] }) {
  let host!: HTMLDivElement;
  const [visible, setVisible] = createSignal(props.index < 24);
  const html = createMemo(() => visible() ? renderMarkdownBlock(props.block, props.context) : "");
  onMount(() => {
    if (!visible()) onCleanup(props.observe(host, () => setVisible(true)));
  });
  createEffect(() => { if (props.requested === props.index) setVisible(true); });
  createEffect(() => {
    html();
    queueMicrotask(() => {
      enhanceTables(host);
      for (const code of host.querySelectorAll<HTMLElement>("code[data-language]")) void highlightFence(code).catch(() => { /* Plain code remains readable if a language chunk cannot load. */ });
      if (props.loadImage) for (const image of host.querySelectorAll<HTMLElement>("[data-markdown-local-image]")) void loadLocalImage(image, props.loadImage);
    });
  });
  return <div ref={host} class="markdown-block" style={!visible() ? { "min-height": `${Math.min(1200, Math.max(24, props.block.lines * 22))}px` } : undefined} innerHTML={html()} />;
}

export function MarkdownPreview(props: MarkdownPreviewProps): JSX.Element {
  let scroller!: HTMLDivElement;
  const [blocks, setBlocks] = createSignal<MarkdownBlock[]>([]);
  const [requested, setRequested] = createSignal(-1);
  let observer: IntersectionObserver | undefined;
  const revealers = new WeakMap<Element, () => void>();
  function observe(element: Element, reveal: () => void) {
    if (typeof IntersectionObserver === "undefined") { reveal(); return () => {}; }
    observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) {
        revealers.get(entry.target)?.();
        revealers.delete(entry.target);
        observer!.unobserve(entry.target);
      }
    }, { root: scroller, rootMargin: "800px" });
    revealers.set(element, reveal);
    observer.observe(element);
    return () => { revealers.delete(element); observer?.unobserve(element); };
  }
  onCleanup(() => observer?.disconnect());
  const context = createMemo(() => ({ documentPath: props.documentPath, workspaceRoot: props.workspaceRoot, canRun: !!props.onRunCode }));
  let previous: string | Text | undefined;
  let initialized = false;
  createEffect(() => {
    const source = props.text;
    if (props.active === false || source === previous) return;
    const update = () => {
      previous = source;
      const previousBlocks = new Map<string, { matches: MarkdownBlock[]; next: number }>();
      for (const block of untrack(blocks)) {
        const group = previousBlocks.get(block.key);
        if (group) group.matches.push(block); else previousBlocks.set(block.key, { matches: [block], next: 0 });
      }
      setBlocks(parseMarkdown(typeof source === "string" ? source : source.toString()).map((block) => {
        const group = previousBlocks.get(block.key);
        return group?.matches[group.next++] ?? block;
      }));
    };
    if (!initialized) { update(); initialized = true; return; }
    const timeout = window.setTimeout(update, 180);
    onCleanup(() => window.clearTimeout(timeout));
  });
  function navigateAnchor(id: string) {
    const index = blocks().findIndex((block) => block.headingIds.includes(id));
    if (index < 0) return;
    setRequested(index);
    queueMicrotask(() => scroller.querySelectorAll<HTMLElement>("[id]").forEach((heading) => {
      if (heading.id === id) heading.scrollIntoView({ block: "start" });
    }));
  }
  function click(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("a,button[data-markdown-image],button[data-markdown-copy],button[data-markdown-run]") : null;
    if (!target) return;
    if (target.hasAttribute("data-markdown-copy") || target.hasAttribute("data-markdown-run")) {
      event.preventDefault();
      const block = target.closest(".markdown-code-block");
      const code = block?.querySelector<HTMLElement>("code");
      const status = block?.querySelector<HTMLElement>(".markdown-code-status");
      if (!code || target.hasAttribute("disabled")) return;
      const text = code.textContent ?? "";
      const report = (message: string) => { if (status) status.textContent = message; };
      if (target.hasAttribute("data-markdown-copy")) {
        if (!navigator.clipboard?.writeText) { report("Clipboard unavailable"); return; }
        try { void navigator.clipboard.writeText(text).then(() => report("Copied"), () => report("Could not copy")); } catch { report("Could not copy"); }
      } else if (props.onRunCode) {
        const runCode = props.onRunCode;
        const fence = describeMarkdownFence(code.dataset.fenceInfo ?? "", text);
        if (!fence.command || !fence.action) return;
        const request: MarkdownRunRequest = { code: fence.command, language: fence.declared || fence.language, documentPath: props.documentPath, workspaceRoot: props.workspaceRoot, sourceLine: Number(code.dataset.sourceLine) || 1, action: fence.action, detected: fence.detected, omittedOutput: fence.omittedOutput };
        target.setAttribute("disabled", "");
        report("Sending to terminal…");
        void Promise.resolve().then(() => runCode(request)).then(() => report(fence.action === "send" ? "Staged in terminal" : "Sent to terminal"), () => report("Could not send to terminal")).finally(() => { if (target.isConnected) target.removeAttribute("disabled"); });
      }
      return;
    }
    const image = target.dataset.markdownImage;
    if (image) {
      event.preventDefault();
      const img = document.createElement("img");
      img.alt = target.dataset.imageAlt ?? "";
      img.referrerPolicy = "no-referrer";
      img.loading = "lazy";
      img.addEventListener("error", () => { const message = document.createElement("small"); message.textContent = "Image could not be loaded"; img.replaceWith(message); }, { once: true });
      img.src = image;
      target.parentElement?.replaceChildren(img);
      return;
    }
    if (target.hasAttribute("data-markdown-anchor")) { event.preventDefault(); navigateAnchor(target.dataset.markdownAnchor!); }
    else if (target.dataset.markdownFile) { event.preventDefault(); props.onOpenFile?.(target.dataset.markdownFile); }
    else if (target.dataset.markdownExternal && props.onOpenExternal) { event.preventDefault(); props.onOpenExternal(target.dataset.markdownExternal); }
    else if (target.getAttribute("aria-disabled") === "true") event.preventDefault();
  }
  return <div ref={scroller} class="markdown-preview" role="region" aria-label="Markdown preview" tabIndex={0} onClick={click}>
    <article class="markdown-body"><Index each={blocks()}>{(block, index) => <PreviewBlock block={block()} index={index} requested={requested()} context={context()} observe={observe} loadImage={props.loadImage} />}</Index></article>
  </div>;
}
