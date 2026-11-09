/**
 * Mermaid diagrams in Markdown fences. The parser emits a placeholder with the source kept as plain text; this module
 * upgrades it to an SVG after the markup is in the document. Mermaid is imported lazily and configured for strict
 * security, so a diagram is treated as untrusted content. A diagram that fails keeps its source visible instead of
 * showing Mermaid's error graphic or dropping the block.
 */
import type { MermaidConfig, RenderResult } from "mermaid";

export interface MermaidApi {
  initialize(config: MermaidConfig): void;
  render(id: string, text: string): Promise<RenderResult>;
}
export type MermaidLoader = () => Promise<{ default: MermaidApi }>;

/** Mermaid refuses definitions beyond these limits; check first so a huge fence fails without loading the library. */
const MAX_SOURCE = 50_000;
const MAX_EDGES = 1_000;
const RENDER_ATTRIBUTE = "data-markdown-mermaid";

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** True when the fence declares the `mermaid` language, with an optional trailing title or options. */
export function isMermaidFence(info: string): boolean {
  return info.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

/**
 * Placeholder markup for a Mermaid fence. The diagram box is the only thing shown once rendering succeeds; the source
 * stays in a native disclosure so it remains reachable and acts as the fallback when Mermaid cannot draw it.
 */
export function mermaidFence(source: string): string {
  return `<div class="markdown-mermaid" ${RENDER_ATTRIBUTE} data-mermaid-state="pending"><div class="markdown-mermaid-diagram" data-mermaid-diagram aria-busy="true"><span class="markdown-mermaid-status" data-mermaid-status role="status">Rendering diagram</span></div><details class="markdown-mermaid-source"><summary><span class="icon markdown-mermaid-chevron" aria-hidden="true"></span>Diagram source</summary><pre class="markdown-mermaid-code"><code data-mermaid-code>${escapeHtml(source)}</code></pre></details></div>\n`;
}

const loadMermaid: MermaidLoader = () => import("mermaid") as Promise<{ default: MermaidApi }>;
const modules = new WeakMap<MermaidLoader, Promise<MermaidApi>>();

function loadModule(loader: MermaidLoader): Promise<MermaidApi> {
  let pending = modules.get(loader);
  if (!pending) {
    pending = loader().then((module) => module.default ?? (module as unknown as MermaidApi));
    modules.set(loader, pending);
  }
  return pending;
}

/**
 * Mermaid keeps global configuration and its renderer expects one diagram at a time, so calls run through a chain.
 * A failed task never blocks the next one.
 */
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = chain.then(task, task);
  chain = next.then(() => undefined, () => undefined);
  return next;
}

let renderId = 0;
let renderToken = 0;
/** Keep the loader that drew each block so theme changes reuse the same (possibly injected) renderer. */
const loaders = new WeakMap<HTMLElement, MermaidLoader>();

function themeName(): string {
  return document.documentElement.dataset.theme ?? "dark";
}

function cssToken(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

/** Mermaid's base theme, mapped onto the same tokens the Markdown surfaces use. */
function themeConfig(element: HTMLElement): MermaidConfig {
  const style = getComputedStyle(element);
  const background = cssToken(style, "--island", "#18191b");
  const surface = cssToken(style, "--field", "#111214");
  const border = cssToken(style, "--pillBd", "#37383a");
  const text = cssToken(style, "--text", "#e0e1e4");
  const dim = cssToken(style, "--dim", "#898e94");
  const strong = cssToken(style, "--strong", "#fff");
  const accent = cssToken(style, "--accent", "#726cf9");
  const font = cssToken(style, "--ui-font-family", "Inter, system-ui, sans-serif");
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    maxTextSize: MAX_SOURCE,
    maxEdges: MAX_EDGES,
    theme: "base",
    fontFamily: font,
    darkMode: themeName() !== "light",
    themeVariables: {
      background,
      primaryColor: surface,
      primaryTextColor: text,
      primaryBorderColor: border,
      secondaryColor: cssToken(style, "--pill", "#28292b"),
      secondaryTextColor: text,
      secondaryBorderColor: border,
      tertiaryColor: cssToken(style, "--hover", "#222325"),
      tertiaryTextColor: text,
      tertiaryBorderColor: border,
      lineColor: dim,
      textColor: text,
      mainBkg: surface,
      nodeBorder: border,
      clusterBkg: background,
      clusterBorder: cssToken(style, "--border", "#363739"),
      titleColor: strong,
      edgeLabelBackground: background,
      noteBkgColor: cssToken(style, "--pill", "#28292b"),
      noteTextColor: text,
      noteBorderColor: border,
      actorBkg: surface,
      actorBorder: border,
      actorTextColor: text,
      actorLineColor: dim,
      signalColor: text,
      signalTextColor: text,
      labelBoxBkgColor: surface,
      labelBoxBorderColor: border,
      labelTextColor: text,
      loopTextColor: text,
      activationBkgColor: cssToken(style, "--pill", "#28292b"),
      activationBorderColor: border,
      sequenceNumberColor: background,
      pieStrokeColor: border,
      pieOuterStrokeColor: border,
      pieTitleTextColor: strong,
      pieSectionTextColor: text,
      pieLegendTextColor: text,
      git0: accent,
      git1: cssToken(style, "--success", "#70bd8d"),
      git2: cssToken(style, "--warning", "#d4ae67"),
      git3: cssToken(style, "--error", "#d26979"),
      git4: cssToken(style, "--syntax-type", "#80b7ec"),
      git5: cssToken(style, "--syntax-string", "#cc8dcb"),
      git6: cssToken(style, "--syntax-number", "#d9ba7e"),
      git7: cssToken(style, "--syntax-comment", "#81878f"),
      gitBranchLabel0: background,
      gitBranchLabel1: background,
      gitBranchLabel2: background,
      gitBranchLabel3: background,
      gitBranchLabel4: background,
      gitBranchLabel5: background,
      gitBranchLabel6: background,
      gitBranchLabel7: background,
    },
  };
}

const patchStyle = (nodes: Iterable<Element>) => {
  for (const node of nodes) {
    if (!(node instanceof Element)) continue;
    const style = node.getAttribute("style");
    if (!style) continue;
    // Mermaid's measuring pass can leave empty labels at zero width. Keep every real constraint.
    if (!/max-width\s*:\s*0(?:px)?\s*(?:;|$)/i.test(style)) continue;
    if (/position\s*:\s*absolute/i.test(style)) {
      node.removeAttribute("style");
      continue;
    }
    const cleaned = style
      .replace(/(^|;)\s*max-width\s*:\s*0(?:px)?\s*;?/gi, "$1")
      .replace(/;;+/g, ";")
      .replace(/^\s*;\s*|\s*;\s*$/g, "");
    if (cleaned.trim()) node.setAttribute("style", cleaned);
    else node.removeAttribute("style");
  }
};

/**
 * Mermaid sizes diagrams with a hidden measuring element. Some diagrams still come back with zero width labels or a
 * reserved blank band; strip the leftovers that make the diagram look broken while keeping colours and fonts.
 */
function prepareSvg(svg: string, label: string): string {
  const template = document.createElement("template");
  template.innerHTML = svg;
  const root = template.content.querySelector("svg");
  if (!root) throw new Error("Mermaid returned no SVG");
  root.setAttribute("role", "img");
  root.setAttribute("aria-label", label);
  root.removeAttribute("height");
  root.style.maxWidth = "100%";
  const width = root.getAttribute("width");
  if (width && /^\d+(\.\d+)?$/.test(width)) root.style.width = `${width}px`;
  patchStyle(template.content.querySelectorAll("[style]"));
  return template.innerHTML;
}

export interface MermaidRenderOptions {
  /** Accessible label for the rendered diagram. */
  label?: string;
}

/** Render one definition to SVG with the strict, theme-matched configuration. Exported for direct tests. */
export async function renderMermaidSvg(source: string, element: HTMLElement, loader: MermaidLoader = loadMermaid, options: MermaidRenderOptions = {}): Promise<string> {
  if (!source.trim()) throw new Error("Empty diagram");
  if (source.length > MAX_SOURCE) throw new Error("Diagram source is too large");
  const api = await loadModule(loader);
  return serialize(async () => {
    api.initialize(themeConfig(element));
    const result = await api.render(`span-mermaid-${++renderId}`, source);
    return prepareSvg(result.svg, options.label ?? "Mermaid diagram");
  });
}

function fail(element: HTMLElement, diagram: HTMLElement, status: string): void {
  element.dataset.mermaidState = "error";
  element.classList.remove("is-rendered");
  diagram.removeAttribute("aria-busy");
  diagram.replaceChildren();
  const message = document.createElement("span");
  message.className = "markdown-mermaid-status is-error";
  message.setAttribute("data-mermaid-status", "");
  message.setAttribute("role", "status");
  message.textContent = status;
  diagram.append(message);
  const details = element.querySelector<HTMLDetailsElement>("details.markdown-mermaid-source");
  if (details) details.open = true;
}

async function enhanceElement(element: HTMLElement, loader: MermaidLoader): Promise<void> {
  const code = element.querySelector<HTMLElement>("[data-mermaid-code]");
  const diagram = element.querySelector<HTMLElement>("[data-mermaid-diagram]");
  if (!code || !diagram) return;
  loaders.set(element, loader);
  const source = code.textContent ?? "";
  const theme = themeName();
  if (element.dataset.mermaidState === "ready" && element.dataset.mermaidTheme === theme) return;
  if (element.dataset.mermaidState === "rendering" && element.dataset.mermaidTheme === theme) return;
  const token = String(++renderToken);
  element.dataset.mermaidState = "rendering";
  element.dataset.mermaidTheme = theme;
  element.dataset.mermaidToken = token;
  element.classList.remove("is-rendered");
  diagram.setAttribute("aria-busy", "true");
  const status = diagram.querySelector<HTMLElement>("[data-mermaid-status]");
  if (status) {
    status.classList.remove("is-error");
    status.textContent = "Rendering diagram";
  }
  if (source.trim().length > MAX_SOURCE) {
    fail(element, diagram, "Diagram source is too large to render.");
    return;
  }
  try {
    const svg = await renderMermaidSvg(source, element, loader);
    if (!element.isConnected || element.dataset.mermaidToken !== token) return;
    diagram.innerHTML = svg;
    diagram.removeAttribute("aria-busy");
    element.dataset.mermaidState = "ready";
    element.classList.add("is-rendered");
  } catch {
    if (!element.isConnected || element.dataset.mermaidToken !== token) return;
    fail(element, diagram, "Diagram could not be rendered. The source is shown below.");
  }
}

/* A single observer keeps mounted diagrams in step with the app theme without one observer per block. */
let themeObserver: MutationObserver | undefined;
function observeTheme(): void {
  if (themeObserver || typeof MutationObserver === "undefined") return;
  themeObserver = new MutationObserver(() => {
    for (const element of document.querySelectorAll<HTMLElement>(`[${RENDER_ATTRIBUTE}]`)) void enhanceElement(element, loaders.get(element) ?? loadMermaid);
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

/**
 * Upgrade every Mermaid placeholder below `host`. Safe to call after each render: unchanged diagrams are skipped,
 * renders are serialized, and a stale result is discarded when the block was replaced.
 */
export async function enhanceMermaid(host: ParentNode, loader: MermaidLoader = loadMermaid): Promise<void> {
  const elements = [...host.querySelectorAll<HTMLElement>(`[${RENDER_ATTRIBUTE}]`)];
  if (!elements.length) return;
  observeTheme();
  await Promise.all(elements.map((element) => enhanceElement(element, loader)));
}
