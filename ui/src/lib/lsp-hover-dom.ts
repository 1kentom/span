import { renderHoverMarkdown, type HoverRenderOptions } from "./markdown-hover";
import { iconAssetPath } from "./menuIcons";

/** Pure helpers for the hover popup: which characters count as a token, and the popup's DOM. */

// --------------------------------------------------------------- tokens

const identifierPart = /^[\p{L}\p{N}\p{M}_$]$/u;
const digit = /^\p{N}$/u;

interface Unit { text: string; start: number; end: number }

/** The code point that covers UTF-16 index `index`, so astral letters are not split. */
function unitAt(text: string, index: number): Unit | undefined {
  if (index < 0 || index >= text.length) return undefined;
  let start = index;
  const code = text.charCodeAt(index);
  if (code >= 0xdc00 && code <= 0xdfff && index > 0) {
    const high = text.charCodeAt(index - 1);
    if (high >= 0xd800 && high <= 0xdbff) start = index - 1;
  }
  const point = text.codePointAt(start)!;
  const value = String.fromCodePoint(point);
  return { text: value, start, end: start + value.length };
}

const isIdentifier = (unit: Unit | undefined) => !!unit && identifierPart.test(unit.text);

export interface IdentifierRange {
  /** Offsets inside the line text. `@` of an annotation is part of the range. */
  from: number;
  to: number;
  /** Where to ask the server: inside the name, never on the `@`. */
  at: number;
}

/**
 * The token under character `index` of a line. Letters of any script, digits, `_` and `$` make a name,
 * and a directly preceding `@` joins it (annotations). Dots end a name, so each segment of a qualified
 * name is its own token. Numbers are not tokens. Returns null on anything else.
 */
export function identifierAt(text: string, index: number): IdentifierRange | null {
  const under = unitAt(text, index);
  if (!under) return null;
  let here: Unit = under;
  if (under.text === "@") {
    const next = unitAt(text, under.end);
    if (!next || !isIdentifier(next) || digit.test(next.text)) return null;
    here = next;
  } else if (!isIdentifier(under)) return null;
  let from = here.start;
  let to = here.end;
  for (let previous = unitAt(text, from - 1); previous && isIdentifier(previous); previous = unitAt(text, from - 1)) from = previous.start;
  for (let next = unitAt(text, to); next && isIdentifier(next); next = unitAt(text, to)) to = next.end;
  const first = unitAt(text, from);
  if (first && digit.test(first.text)) return null;
  const at = Math.min(Math.max(here.start, from), to - 1);
  if (text[from - 1] === "@") from -= 1;
  return { from, to, at };
}

// ------------------------------------------------------------------ DOM

export interface HoverAction { id: string; label: string; hint?: string; run: () => void }
export interface HoverDiagnostic { severity: "error" | "warning" | "info" | "hint"; message: string; source?: string; code?: string }
export interface HoverHintView { text: string; actionLabel?: string; onAction?: () => void }

export interface HoverContentInput extends HoverRenderOptions {
  markdown: string;
  diagnostics: readonly HoverDiagnostic[];
  hint?: HoverHintView;
  actions: readonly HoverAction[];
  /** Called for Escape inside the popup. */
  onEscape: () => void;
}

export interface HoverContent { dom: HTMLElement; ready: Promise<void>; empty: boolean }

const severityIcon: Record<HoverDiagnostic["severity"], string> = { error: "CloseCircle", warning: "Danger", info: "InfoCircle", hint: "InfoCircle" };
const severityLabel: Record<HoverDiagnostic["severity"], string> = { error: "Error", warning: "Warning", info: "Information", hint: "Hint" };

function iconSpan(doc: Document, name: string, className: string): HTMLElement {
  const span = doc.createElement("span");
  span.className = className;
  span.setAttribute("aria-hidden", "true");
  const url = `url('${iconAssetPath(name)}')`;
  span.style.setProperty("mask-image", url);
  span.style.setProperty("-webkit-mask-image", url);
  return span;
}

export function buildHoverContent(input: HoverContentInput): HoverContent {
  const doc = input.doc ?? document;
  const dom = doc.createElement("div");
  dom.className = "cm-lsp-hover";
  dom.tabIndex = -1;
  dom.setAttribute("role", "dialog");
  dom.setAttribute("aria-label", "Hover information");
  dom.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); input.onEscape(); }
  });
  const body = doc.createElement("div");
  body.className = "cm-lsp-hover-body";
  const rendered = renderHoverMarkdown(input.markdown, input);
  if (!rendered.empty) body.append(rendered.root);
  if (input.diagnostics.length) {
    const list = doc.createElement("ul");
    list.className = "cm-lsp-diagnostics";
    list.setAttribute("aria-label", "Problems");
    for (const item of input.diagnostics) {
      const row = doc.createElement("li");
      row.className = `cm-lsp-diagnostic cm-lsp-diagnostic-${item.severity}`;
      const icon = iconSpan(doc, severityIcon[item.severity], "cm-lsp-severity");
      icon.setAttribute("role", "img");
      icon.setAttribute("aria-label", severityLabel[item.severity]);
      icon.removeAttribute("aria-hidden");
      const message = doc.createElement("span");
      message.className = "cm-lsp-diagnostic-message";
      message.textContent = item.message;
      row.append(icon, message);
      const origin = [item.source, item.code ? `(${item.code})` : ""].filter(Boolean).join(" ").trim();
      if (origin) { const source = doc.createElement("span"); source.className = "cm-lsp-diagnostic-source"; source.textContent = origin; row.append(source); }
      list.append(row);
    }
    if (body.childElementCount) { const rule = doc.createElement("hr"); rule.className = "cm-lsp-divider"; body.append(rule); }
    body.append(list);
  }
  dom.append(body);
  if (input.hint) {
    const line = doc.createElement("div");
    line.className = "cm-lsp-hover-hint";
    const text = doc.createElement("span");
    text.textContent = input.hint.text;
    line.append(text);
    if (input.hint.actionLabel && input.hint.onAction) {
      const onAction = input.hint.onAction;
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = input.hint.actionLabel;
      button.addEventListener("click", event => { event.preventDefault(); onAction(); });
      line.append(button);
    }
    dom.append(line);
  }
  // A footer for a symbol the server had nothing to say about would offer actions on nothing.
  if (input.actions.length && !rendered.empty) {
    const footer = doc.createElement("div");
    footer.className = "cm-lsp-hover-actions";
    footer.setAttribute("role", "toolbar");
    footer.setAttribute("aria-label", "Hover actions");
    for (const action of input.actions) {
      const button = doc.createElement("button");
      button.type = "button";
      button.dataset.action = action.id;
      const label = doc.createElement("span");
      label.textContent = action.label;
      button.append(label);
      if (action.hint) { const key = doc.createElement("kbd"); key.textContent = action.hint; button.append(key); }
      // Keep the editor selection while a button is pressed.
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", event => { event.preventDefault(); action.run(); });
      footer.append(button);
    }
    dom.append(footer);
  }
  const empty = rendered.empty && !input.diagnostics.length && !input.hint;
  return { dom, ready: rendered.highlighted, empty };
}

/** A one line tooltip for status notices and short answers. */
export function buildNotice(text: string, role: "status" | "note" = "status", doc: Document = document): HTMLElement {
  const dom = doc.createElement("div");
  dom.className = "cm-lsp-notice";
  dom.setAttribute("role", role === "status" ? "status" : "note");
  dom.textContent = text;
  return dom;
}
