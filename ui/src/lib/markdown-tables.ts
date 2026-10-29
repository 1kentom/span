import type { MarkdownIt, Token } from "markdown-it";

/**
 * Markdown tables, shared by the editor preview and the agent feed.
 *
 * Words never break inside a cell. Short cells (codes, numbers, one or two words) stay on one line, prose cells get a
 * readable width range, and only cells holding a URL or another long unbroken token may wrap anywhere. A table wider
 * than its pane scrolls inside its own wrapper instead of squeezing columns.
 */

export type CellKind = "nowrap" | "numeric" | "prose" | "break";

/** Plain text of a cell as the reader sees it, plus whether it holds a link target or a long unbroken token. */
function cellText(inline: Token | undefined): { text: string; link: boolean } {
  if (!inline) return { text: "", link: false };
  let text = "";
  let link = false;
  for (const child of inline.children ?? []) {
    if (child.type === "text" || child.type === "code_inline") text += child.content;
    else if (child.type === "softbreak" || child.type === "hardbreak") text += " ";
    else if (child.type === "link_open" && child.markup === "linkify") link = true;
  }
  return { text: text.trim(), link };
}

const SHORT = 14;
const NUMERIC = /^[-+(]?[$€£¥]?\d[\d.,:\s]*%?[)]?$/;
const URL_LIKE = /(?:https?:\/\/|www\.|mailto:|\S@\S+\.\S)/i;
const LONG_TOKEN = /\S{28,}/;

/** How a cell wraps. Exported for tests. */
export function classifyCell(text: string, link = false): CellKind {
  const value = text.trim();
  if (link || URL_LIKE.test(value) || LONG_TOKEN.test(value)) return "break";
  if (NUMERIC.test(value)) return "numeric";
  if (value.length <= SHORT) return "nowrap";
  return "prose";
}

const ALIGN = /text-align:\s*(left|center|right)/;

function openCell(tokens: Token[], index: number): string {
  const token = tokens[index];
  const tag = token.tag === "th" ? "th" : "td";
  const { text, link } = cellText(tokens[index + 1]);
  let kind = classifyCell(text, link);
  // Header labels stay on one line unless they are a sentence.
  if (tag === "th" && kind === "prose" && text.length <= 32) kind = "nowrap";
  token.meta = { ...(token.meta ?? {}), cellKind: kind };
  const align = ALIGN.exec(String(token.attrGet("style") ?? ""))?.[1];
  const classes = [`markdown-cell-${kind}`];
  if (align) classes.push(`markdown-align-${align}`);
  const body = kind === "prose" || kind === "break" ? '<div class="markdown-cell">' : "";
  return `<${tag} class="${classes.join(" ")}">${body}`;
}

function closeCell(tokens: Token[], index: number): string {
  const token = tokens[index];
  // Cells are always open, inline, close.
  const kind = tokens[index - 2]?.meta?.cellKind as CellKind | undefined;
  const body = kind === "prose" || kind === "break" ? "</div>" : "";
  return `${body}</${token.tag === "th" ? "th" : "td"}>\n`;
}

export function installTableRules(markdown: MarkdownIt) {
  const rules = markdown.renderer.rules;
  rules.table_open = () => '<div class="markdown-table"><div class="markdown-table-scroll"><table>\n';
  rules.table_close = () => "</table></div></div>\n";
  rules.th_open = openCell;
  rules.td_open = openCell;
  rules.th_close = closeCell;
  rules.td_close = closeCell;
}

let resize: ResizeObserver | undefined;

/** The scroller is a keyboard stop and a named region only while it actually overflows. */
export function syncTableOverflow(scroller: HTMLElement) {
  const overflowing = scroller.scrollWidth > scroller.clientWidth + 1;
  if (overflowing) {
    scroller.tabIndex = 0;
    scroller.setAttribute("role", "region");
    scroller.setAttribute("aria-label", "Table");
    scroller.dataset.overflow = "";
  } else {
    scroller.removeAttribute("tabindex");
    scroller.removeAttribute("role");
    scroller.removeAttribute("aria-label");
    delete scroller.dataset.overflow;
  }
}

/** Watch every table scroller under `host`. Safe to call after each render. */
export function enhanceTables(host: ParentNode) {
  const scrollers = host.querySelectorAll<HTMLElement>(".markdown-table-scroll");
  if (!scrollers.length) return;
  if (typeof ResizeObserver !== "undefined") {
    resize ??= new ResizeObserver((entries) => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        if (!element.isConnected) resize!.unobserve(element);
        else syncTableOverflow(element.closest<HTMLElement>(".markdown-table-scroll") ?? element);
      }
    });
    for (const scroller of scrollers) {
      resize.observe(scroller);
      const table = scroller.firstElementChild;
      if (table) resize.observe(table);
    }
  }
  for (const scroller of scrollers) syncTableOverflow(scroller);
}

/** Horizontal scroll offsets of the tables under `host`, so a re-render (streaming) does not snap them back. */
export function tableScrollState(host: ParentNode): number[] {
  return [...host.querySelectorAll<HTMLElement>(".markdown-table-scroll")].map((scroller) => scroller.scrollLeft);
}

export function restoreTableScroll(host: ParentNode, offsets: number[]) {
  if (!offsets.some(Boolean)) return;
  host.querySelectorAll<HTMLElement>(".markdown-table-scroll").forEach((scroller, index) => {
    if (offsets[index]) scroller.scrollLeft = offsets[index];
  });
}
