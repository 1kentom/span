import { ChangeSet, EditorState, Facet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, showTooltip, type DecorationSet, type Tooltip, type ViewUpdate } from "@codemirror/view";
import { completionStatus, pickedCompletion, snippet, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { forceLinting, linter, type Diagnostic } from "@codemirror/lint";
import type {
  CapabilitiesDto, CompletionItemDto_Serialize, DiagnosticDto_Deserialize, DiagnosticsPublished_Deserialize, LanguageServerId,
  LocationDto, LspErrorDto, LspResponse, SourceSnippetDto, TextEditDto,
} from "../bindings";
import { offsetToPosition, rangeToOffsets, serverLabels, type LspSession } from "./lsp-client";
import { resolveLanguageId } from "../editor/languages";
import { hoverContentsToMarkdown } from "./markdown-hover";
import { buildHoverContent, buildNotice, identifierAt, type HoverAction, type HoverDiagnostic, type HoverHintView } from "./lsp-hover-dom";
import { registerNavigationHandler, runNavigationAction } from "./navigation-actions";
import "../styles/hover.css";

/** Everything the editor needs from the app. Every getter is read at use time, never cached. */
export interface LspBinding {
  server: LanguageServerId;
  createSession: () => LspSession;
  /** Revision of the backend buffer the language server has seen. */
  getRevision: () => number;
  /** False while edits made in the view have not yet reached the backend buffer. */
  isSynchronized: () => boolean;
  isActive: () => boolean;
  getWorkspaceGeneration: () => number;
  /** Server epoch, when known. A change during a request discards its reply. */
  getEpoch: () => number | undefined;
  /** Capabilities of the server for this buffer, or undefined unless it is ready. */
  getCapabilities: () => CapabilitiesDto | undefined;
  subscribeDiagnostics: (listener: (event: DiagnosticsPublished_Deserialize) => void) => () => void;
  /** Fires when the server restarts or stops, and diagnostics must be dropped. */
  subscribeReset: (listener: () => void) => () => void;
  openLocation: (location: LocationDto) => void;
  notify: (message: string) => void;
  /** Quiet channel for typed failures, so the status item can reflect them. */
  reportError?: (error: LspErrorDto) => void;
  /** Called when a request succeeded, so a hint left by an earlier failure can be dropped. */
  reportOk?: () => void;
  /** Latest diagnostics published for this file. A new view replays them, because the publish already happened. */
  getLatestDiagnostics?: () => DiagnosticsPublished_Deserialize | undefined;
  /** Why an empty hover may be incomplete: the server is still starting, or is indexing the project. Read, never cached. */
  getServerNotice?: () => ServerNotice | undefined;
  /** Extension point for the language intelligence hub: a hint (for example "dependencies are not loaded") shown under a hover. */
  hoverHint?: (pos: number, hadResult?: boolean) => string | HoverHint | undefined;
  /** Current key label for an action, taken from the configurable bindings. */
  getShortcut?: (id: "goToDefinition" | "peekDefinition" | "quickInfo") => string | undefined;
  /** Opens an http or https link from hover content. */
  openExternal?: (url: string) => void;
  /** Opens a definition in the other editor group (Cmd+Alt+click on macOS, Ctrl+Alt+click elsewhere). */
  openLocationToSide?: (location: LocationDto) => void;
  /** Reads the source around a definition for the Cmd/Ctrl-hover preview. Without it only the underline shows. */
  readSource?: (location: LocationDto, contextLines: number) => Promise<SourceSnippetDto>;
  /** Opens a file link from hover content. */
  navigateFile?: (target: { path: string; line?: number; column?: number }) => void;
}

export type ServerNotice = "starting" | "indexing";
export type HoverHint = HoverHintView;
export const SERVER_NOTICE_TEXT: Record<ServerNotice, string> = {
  starting: "Language server is still starting",
  indexing: "Indexing project, results may be incomplete",
};
export const NO_DEFINITION_TEXT = "No definition found";
export const HOVER_DELAY_MS = 300;

interface Runtime {
  path: string;
  binding: LspBinding;
  session: LspSession;
  /** Separate flights for the link underline, so resting the pointer never cancels a click that is resolving. */
  linkSession: LspSession;
  view?: EditorView;
  destroyed: boolean;
}

const runtimeFacet = Facet.define<Runtime, Runtime | undefined>({ combine: values => values[0] });

interface Snapshot { doc: Text; epoch: number | undefined; generation: number }

const capture = (runtime: Runtime, view: EditorView): Snapshot => ({ doc: view.state.doc, epoch: runtime.binding.getEpoch(), generation: runtime.binding.getWorkspaceGeneration() });

/** A reply may only be used if nothing it depends on moved while it was in flight. */
export function replyIsCurrent(binding: Pick<LspBinding, "isActive" | "getRevision" | "getEpoch" | "getWorkspaceGeneration">, snapshot: { doc: unknown; epoch: number | undefined; generation: number }, currentDoc: unknown, response: Pick<LspResponse<unknown>, "revision" | "epoch">): boolean {
  if (!binding.isActive()) return false;
  if (currentDoc !== snapshot.doc) return false;
  if (binding.getWorkspaceGeneration() !== snapshot.generation) return false;
  if (binding.getRevision() !== response.revision) return false;
  if (snapshot.epoch !== undefined && (binding.getEpoch() !== snapshot.epoch || response.epoch < snapshot.epoch)) return false;
  return true;
}

const current = (runtime: Runtime, view: EditorView, snapshot: Snapshot, response: LspResponse<unknown>) =>
  !runtime.destroyed && runtime.view === view && replyIsCurrent(runtime.binding, snapshot, view.state.doc, response);

/** Edits typed in the view reach the backend a moment later. Wait briefly so requests describe the same text. */
export async function awaitSynchronized(binding: Pick<LspBinding, "isSynchronized">, cancelled: () => boolean, limitMs = 500): Promise<boolean> {
  const started = Date.now();
  while (!binding.isSynchronized()) {
    if (cancelled() || Date.now() - started > limitMs) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return !cancelled();
}

// ---------------------------------------------------------------- snippets

export interface ConvertedSnippet {
  /** The text with every placeholder replaced by its default. */
  text: string;
  /** A CodeMirror snippet template, or null when the text cannot be expressed safely. */
  template: string | null;
  /** Offset of `$0` inside `text`, when the snippet has one. */
  finalCursor: number | undefined;
  hasStops: boolean;
}

/** Converts LSP snippet syntax. Variables and transforms degrade to their default text. */
export function convertSnippet(source: string): ConvertedSnippet {
  let text = "";
  let template = "";
  let templateSafe = true;
  let finalCursor: number | undefined;
  let hasStops = false;
  let index = 0;
  const appendLiteral = (value: string) => {
    text += value;
    const joined = template.slice(-1) + value;
    if (joined.includes("${") || joined.includes("#{")) templateSafe = false;
    template += value;
  };
  function parseUntilBrace(stopAtBrace: boolean): string {
    let out = "";
    while (index < source.length) {
      const ch = source[index];
      if (ch === "\\" && index + 1 < source.length && "$}\\,|".includes(source[index + 1])) { out += source[index + 1]; index += 2; continue; }
      if (stopAtBrace && ch === "}") return out;
      if (ch === "$") {
        const nested = parseDollar(true);
        out += nested;
        continue;
      }
      out += ch; index++;
    }
    return out;
  }
  // Returns the plain text a dollar form contributes. At top level it also emits template pieces.
  function parseDollar(nested: boolean): string {
    const rest = source.slice(index);
    let match = /^\$(\d+)/.exec(rest);
    if (match) { index += match[0].length; return emitStop(Number(match[1]), "", nested); }
    match = /^\$\{(\d+)\}/.exec(rest);
    if (match) { index += match[0].length; return emitStop(Number(match[1]), "", nested); }
    match = /^\$\{(\d+):/.exec(rest);
    if (match) {
      index += match[0].length;
      const placeholder = parseUntilBrace(true);
      if (source[index] === "}") index++;
      return emitStop(Number(match[1]), placeholder, nested);
    }
    match = /^\$\{(\d+)\|/.exec(rest);
    if (match) {
      index += match[0].length;
      const close = source.indexOf("|}", index);
      const body = close < 0 ? source.slice(index) : source.slice(index, close);
      index = close < 0 ? source.length : close + 2;
      const first = body.split(/(?<!\\),/)[0].replace(/\\([,|\\$}])/g, "$1");
      return emitStop(Number(match[1]), first, nested);
    }
    match = /^\$([A-Za-z_]\w*)/.exec(rest);
    if (match) { index += match[0].length; return emitText("", nested); }
    match = /^\$\{([A-Za-z_]\w*)(:|\/)?/.exec(rest);
    if (match) {
      index += match[0].length;
      let fallback = "";
      if (match[2] === ":") { fallback = parseUntilBrace(true); if (source[index] === "}") index++; }
      else { const close = source.indexOf("}", index); index = close < 0 ? source.length : close + 1; }
      return emitText(fallback, nested);
    }
    index++;
    return emitText("$", nested);
  }
  function emitText(value: string, nested: boolean): string {
    if (!nested) appendLiteral(value);
    return value;
  }
  function emitStop(n: number, placeholder: string, nested: boolean): string {
    if (nested) { hasStops = hasStops || n > 0; return placeholder; }
    if (n === 0) {
      finalCursor = text.length;
      text += placeholder;
      template += "${0}";
      return placeholder;
    }
    hasStops = true;
    if (/[{}]/.test(placeholder)) templateSafe = false;
    text += placeholder;
    template += placeholder ? `\${${n}:${placeholder}}` : `\${${n}}`;
    return placeholder;
  }
  while (index < source.length) {
    const ch = source[index];
    if (ch === "\\" && index + 1 < source.length && "$}\\".includes(source[index + 1])) { appendLiteral(source[index + 1]); index += 2; continue; }
    if (ch === "$") { parseDollar(false); continue; }
    appendLiteral(ch); index++;
  }
  return { text, template: templateSafe && hasStops ? template : null, finalCursor, hasStops };
}

// -------------------------------------------------------------- completion

const kindTypes: Record<number, string> = {
  1: "text", 2: "method", 3: "function", 4: "class", 5: "property", 6: "variable", 7: "class", 8: "interface", 9: "namespace",
  10: "property", 12: "constant", 13: "enum", 14: "keyword", 20: "enum", 21: "constant", 22: "type", 25: "type",
};
const triggerCharacters = ".:<\"'/@#";

export function completionOptions(items: readonly CompletionItemDto_Serialize[], doc: Text, getCurrentDoc: () => Text | undefined): Completion[] {
  const ordered = items.slice(0, 500).map((item, order) => ({ item, order })).sort((a, b) => (a.item.sortText ?? a.item.label).localeCompare(b.item.sortText ?? b.item.label) || a.order - b.order);
  return ordered.map(({ item }, rank): Completion => ({
    label: item.label,
    detail: item.detail ?? undefined,
    type: item.kind ? kindTypes[item.kind] ?? "text" : undefined,
    boost: Math.max(-99, 99 - rank),
    apply: (view, completion, from, to) => applyCompletion(view, completion, from, to, item, doc, getCurrentDoc()),
  }));
}

/** Applies one item. The server's text edit range is trusted only while the document is the one it was computed on. */
export function applyCompletion(view: EditorView, completion: Completion, from: number, to: number, item: CompletionItemDto_Serialize, requestDoc: Text, currentDoc: Text | undefined): void {
  let start = from;
  let end = to;
  let source = item.insertText || item.label;
  if (item.textEdit) {
    source = item.textEdit.newText;
    if (currentDoc === requestDoc && view.state.doc === requestDoc) {
      const range = rangeToOffsets(view.state.doc, item.textEdit.range);
      start = range.from;
      end = range.to;
    }
  }
  start = Math.max(0, Math.min(start, view.state.doc.length));
  end = Math.max(start, Math.min(end, view.state.doc.length));
  if (item.insertTextFormat === "snippet") {
    const converted = convertSnippet(source);
    if (converted.template) { snippet(converted.template)(view, completion, start, end); return; }
    insertPlain(view, completion, start, end, converted.text, converted.finalCursor);
    return;
  }
  insertPlain(view, completion, start, end, source, undefined);
}

function insertPlain(view: EditorView, completion: Completion, from: number, to: number, insert: string, cursor: number | undefined) {
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + (cursor ?? insert.length) },
    scrollIntoView: true,
    userEvent: "input.complete",
    annotations: pickedCompletion.of(completion),
  });
}

function createCompletionSource(runtime: Runtime) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const binding = runtime.binding;
    const view = runtime.view;
    if (!view || runtime.destroyed || !binding.isActive() || !binding.getCapabilities()?.completion) return null;
    const word = context.matchBefore(/[\w$]*/);
    const previous = context.pos > 0 ? context.state.sliceDoc(context.pos - 1, context.pos) : "";
    const trigger = triggerCharacters.includes(previous) ? previous : null;
    if (!context.explicit && !trigger && (!word || word.from === word.to)) return null;
    const aborted = () => context.aborted || runtime.destroyed;
    if (!await awaitSynchronized(binding, aborted)) return null;
    if (view.state.doc !== context.state.doc) return null;
    const snapshot = capture(runtime, view);
    const outcome = await runtime.session.completion(runtime.path, offsetToPosition(snapshot.doc, context.pos), trigger);
    if (outcome.kind === "silent") return null;
    if (outcome.kind === "error") { binding.reportError?.(outcome.error); return null; }
    binding.reportOk?.();
    if (context.aborted || !current(runtime, view, snapshot, outcome.response)) return null;
    const list = outcome.response.data;
    if (!list.items.length) return null;
    return {
      from: word ? word.from : context.pos,
      options: completionOptions(list.items, snapshot.doc, () => runtime.view?.state.doc),
      validFor: list.isIncomplete ? undefined : /^[\w$]*$/,
    };
  };
}

// ------------------------------------------------------------- diagnostics

export interface LspMark { from: number; to: number; severity: Diagnostic["severity"]; message: string; source?: string; code?: string; unnecessary?: boolean; deprecated?: boolean }

const severities: Record<string, Diagnostic["severity"]> = { error: "error", warning: "warning", information: "info", hint: "info" };

/** Maps server diagnostics (UTF-16 line and character) to clamped, non-empty document ranges. */
export function mapDiagnostics(doc: Text, diagnostics: readonly DiagnosticDto_Deserialize[]): LspMark[] {
  return diagnostics.slice(0, 2000).map(item => {
    let { from, to } = rangeToOffsets(doc, item.range);
    if (from === to) {
      if (to < doc.length && doc.sliceString(to, to + 1) !== "\n") to += 1;
      else if (from > 0) from -= 1;
    }
    return { from, to, severity: severities[item.severity ?? "error"] ?? "error", message: item.message, source: item.source ?? undefined, code: item.code ?? undefined, unnecessary: item.unnecessary || undefined, deprecated: item.deprecated || undefined };
  });
}

const setMarks = StateEffect.define<LspMark[]>();
const marksField = StateField.define<LspMark[]>({
  create: () => [],
  update(marks, transaction) {
    for (const effect of transaction.effects) if (effect.is(setMarks)) return effect.value;
    if (!transaction.docChanged || !marks.length) return marks;
    const length = transaction.newDoc.length;
    return marks.map(mark => {
      const from = Math.min(length, transaction.changes.mapPos(mark.from, 1));
      const to = Math.min(length, Math.max(from, transaction.changes.mapPos(mark.to, -1)));
      return { ...mark, from, to };
    }).filter(mark => mark.to > mark.from);
  },
});

export type DiagnosticsDecision = "apply" | "wait" | "drop";

/** Decides what to do with a published set against the buffer the editor shows. */
export function decideDiagnostics(event: Pick<DiagnosticsPublished_Deserialize, "revision">, bufferRevision: number, synchronized: boolean): DiagnosticsDecision {
  const revision = event.revision;
  if (typeof revision === "number") {
    if (revision < bufferRevision) return "drop";
    if (revision > bufferRevision) return "wait";
  }
  return synchronized ? "apply" : "wait";
}

function createDiagnostics(runtime: Runtime): Extension {
  const source = linter(view => view.state.field(marksField).map((mark): Diagnostic => ({
    from: mark.from, to: mark.to, severity: mark.severity, message: mark.message,
    // Unused code is dimmed and deprecated code struck through, like IntelliJ, instead of underlined.
    markClass: mark.unnecessary ? "cm-lsp-unused" : mark.deprecated ? "cm-lsp-deprecated" : undefined,
    source: [mark.source ?? serverLabels[runtime.binding.server], mark.code].filter(Boolean).join(" "),
  })), { delay: 250, tooltipFilter: () => [] });
  const plugin = ViewPlugin.fromClass(class {
    pending: DiagnosticsPublished_Deserialize | undefined;
    timer: ReturnType<typeof setTimeout> | undefined;
    attempts = 0;
    stops: (() => void)[];
    constructor(readonly view: EditorView) {
      runtime.view = view;
      this.stops = [
        runtime.binding.subscribeDiagnostics(event => this.receive(event)),
        runtime.binding.subscribeReset(() => this.reset()),
      ];
      // The server may have published before this view existed (reopened tab, split). Replay through the same revision checks.
      const latest = runtime.binding.getLatestDiagnostics?.();
      // Deferred: a view cannot be dispatched to while it is still being constructed.
      if (latest) this.timer = setTimeout(() => this.receive(latest), 0);
    }
    receive(event: DiagnosticsPublished_Deserialize) {
      if (event.path !== runtime.path || runtime.destroyed) return;
      this.pending = event; this.attempts = 0;
      this.flush();
    }
    flush() {
      if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
      const event = this.pending;
      if (!event || runtime.destroyed) return;
      const decision = decideDiagnostics(event, runtime.binding.getRevision(), runtime.binding.isSynchronized());
      if (decision === "drop") { this.pending = undefined; return; }
      if (decision === "wait") {
        if (++this.attempts <= 40) this.timer = setTimeout(() => this.flush(), 100); else this.pending = undefined;
        return;
      }
      this.pending = undefined;
      this.show(mapDiagnostics(this.view.state.doc, event.diagnostics));
    }
    show(marks: LspMark[]) {
      this.view.dispatch({ effects: setMarks.of(marks) });
      forceLinting(this.view);
    }
    reset() {
      this.pending = undefined;
      if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
      if (this.view.state.field(marksField, false)?.length) this.show([]);
    }
    destroy() {
      runtime.destroyed = true;
      if (this.timer) clearTimeout(this.timer);
      this.stops.forEach(stop => stop());
      runtime.session.dispose();
    }
  });
  return [marksField, source, plugin];
}

/** Test seam: the diagnostics currently shown by the language server layer. */
export const lspMarks = (state: EditorState): readonly LspMark[] => state.field(marksField, false) ?? [];

// ------------------------------------------------------------ hover popup

export interface TokenAt { from: number; to: number; /** Where to ask the server. */ at: number; kind: "identifier" | "diagnostic"; key: string }

/** The token that covers document offset `offset`, or null. A diagnostic range counts even where no name is, so problems on punctuation stay reachable. */
export function tokenAtOffset(state: EditorState, offset: number): TokenAt | null {
  if (offset < 0 || offset > state.doc.length) return null;
  const line = state.doc.lineAt(offset);
  const found = identifierAt(line.text, offset - line.from);
  if (found) return { from: line.from + found.from, to: line.from + found.to, at: line.from + found.at, kind: "identifier", key: `${line.from + found.from}:${line.from + found.to}` };
  const mark = state.field(marksField, false)?.find(item => offset >= item.from && offset < item.to);
  return mark ? { from: mark.from, to: mark.to, at: Math.min(offset, mark.to - 1), kind: "diagnostic", key: `d${mark.from}:${mark.to}` } : null;
}

/** Hover derives its position from where the pointer is. `posAtCoords` rounds to the nearest gap between characters, so the side of that gap decides which character is meant. */
export function tokenAtCoords(view: EditorView, x: number, y: number): TokenAt | null {
  const pos = view.posAtCoords({ x, y });
  if (pos === null) return null;
  const edge = view.coordsAtPos(pos, 1);
  const candidates = edge ? [x >= edge.left ? pos : pos - 1] : [pos, pos - 1];
  for (const offset of candidates) {
    const token = tokenAtOffset(view.state, offset);
    if (token) return token;
  }
  return null;
}

interface TipSpec { tooltip: Tooltip; kind: "hover" | "preview" | "notice" | "toast"; key: string }
const setTip = StateEffect.define<TipSpec | null>();
const tipField = StateField.define<TipSpec | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setTip)) return effect.value;
    return transaction.docChanged ? null : value;
  },
  provide: field => showTooltip.from(field, spec => spec?.tooltip ?? null),
});

const linkMark = Decoration.mark({ class: "cm-lsp-link" });
const setLink = StateEffect.define<{ from: number; to: number } | null>();
const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setLink)) return effect.value ? Decoration.set([linkMark.range(effect.value.from, effect.value.to)]) : Decoration.none;
    return transaction.docChanged ? Decoration.none : value;
  },
  provide: field => EditorView.decorations.from(field),
});

const liveHovers = new Set<HoverPlugin>();
let lastFocusedHover: HoverPlugin | undefined;
let unregisterQuickInfo: (() => void) | undefined;

/** Keyboard access: shows the hover for the caret of the focused editor and moves focus into it. */
function quickInfo(): void {
  const plugins = [...liveHovers];
  const target = plugins.find(item => item.view.hasFocus) ?? (lastFocusedHover && liveHovers.has(lastFocusedHover) ? lastFocusedHover : undefined) ?? plugins.find(item => item.runtime.binding.isActive());
  target?.showAtCaret();
}

const definitionIsAvailable = (runtime: Runtime) => !runtime.destroyed && runtime.binding.isActive() && Boolean(runtime.binding.getCapabilities()?.definition);

class HoverPlugin {
  runtime: Runtime;
  seq = 0;
  wantedKey: string | undefined;
  showingKey: string | undefined;
  showTimer: ReturnType<typeof setTimeout> | undefined;
  closeTimer: ReturnType<typeof setTimeout> | undefined;
  toastTimer: ReturnType<typeof setTimeout> | undefined;
  linkTimer: ReturnType<typeof setTimeout> | undefined;
  pointer: { x: number; y: number } | undefined;
  modifier = false;
  chorded = false;
  overTip = false;
  linkKey: string | undefined;
  linkCache = new Map<string, LocationDto | false>();
  gesture: { time: number; target: EventTarget | null; x: number; y: number } | undefined;
  stops: (() => void)[] = [];

  constructor(readonly view: EditorView) {
    this.runtime = view.state.facet(runtimeFacet)!;
    liveHovers.add(this);
    if (!unregisterQuickInfo) unregisterQuickInfo = registerNavigationHandler("quickInfo", quickInfo);
    const key = (event: KeyboardEvent) => {
      // Escape closes a popup the pointer is resting on even though the editor has no focus.
      if (event.type === "keydown" && event.key === "Escape" && this.view.state.field(tipField, false) && !completionStatus(this.view.state)) { this.hide(); this.seq++; clearTimeout(this.showTimer); return; }
      // A modifier chord (Cmd+Shift+I, Cmd+S) is not a request to follow a link.
      if (event.type === "keydown" && !["Meta", "Control", "Alt", "Shift"].includes(event.key)) { this.chorded = true; this.clearLink(); return; }
      this.modifierChanged(event);
    };
    const blur = () => this.modifierChanged(undefined);
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key, true);
    window.addEventListener("blur", blur);
    this.stops.push(() => { window.removeEventListener("keydown", key, true); window.removeEventListener("keyup", key, true); window.removeEventListener("blur", blur); });
    const reset = this.runtime.binding.subscribeReset(() => { this.linkCache.clear(); this.clearLink(); this.hide(); });
    this.stops.push(reset);
  }

  get binding() { return this.runtime.binding; }

  update(update: ViewUpdate) {
    if (update.docChanged) { this.linkCache.clear(); this.linkKey = undefined; this.seq++; clearTimeout(this.showTimer); this.wantedKey = undefined; this.showingKey = undefined; }
    if (update.focusChanged && update.view.hasFocus) lastFocusedHover = this;
  }

  destroy() {
    liveHovers.delete(this);
    if (lastFocusedHover === this) lastFocusedHover = undefined;
    if (!liveHovers.size) { unregisterQuickInfo?.(); unregisterQuickInfo = undefined; }
    for (const timer of [this.showTimer, this.closeTimer, this.toastTimer, this.linkTimer]) clearTimeout(timer);
    this.seq++;
    this.stops.forEach(stop => stop());
    this.runtime.linkSession.dispose();
  }

  // ---- popup

  hide() {
    clearTimeout(this.closeTimer); clearTimeout(this.toastTimer);
    this.overTip = false;
    this.showingKey = undefined;
    if (this.view.state.field(tipField, false)) this.view.dispatch({ effects: setTip.of(null) });
  }

  scheduleClose(ms = 280) {
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => {
      const tip = this.view.state.field(tipField, false);
      if (!tip) return;
      const focused = tip.tooltip && this.view.dom.querySelector(".cm-lsp-hover")?.contains(document.activeElement);
      if (this.overTip || focused) return;
      this.hide();
    }, ms);
  }

  private tipEvents(dom: HTMLElement) {
    dom.addEventListener("mouseenter", () => { this.overTip = true; clearTimeout(this.closeTimer); });
    dom.addEventListener("mouseleave", () => { this.overTip = false; this.scheduleClose(); });
    // Focus that moves out of a focused popup (a click elsewhere) closes it.
    dom.addEventListener("focusout", event => { if (!(event.relatedTarget instanceof Node && dom.contains(event.relatedTarget))) this.hide(); });
  }

  private show(spec: Omit<TipSpec, "tooltip"> & { token: TokenAt; dom: HTMLElement; ready?: Promise<void>; focus?: boolean }) {
    clearTimeout(this.closeTimer);
    this.tipEvents(spec.dom);
    const focus = spec.focus;
    const tooltip: Tooltip = { pos: spec.token.from, end: spec.token.to, above: true, create: () => ({ dom: spec.dom, mount: focus ? () => { spec.dom.focus({ preventScroll: true }); } : undefined }) };
    this.showingKey = spec.key;
    this.view.dispatch({ effects: setTip.of({ tooltip, kind: spec.kind, key: spec.key }) });
    // Colour arrives a moment later; the popup may need to re-measure.
    void spec.ready?.then(() => this.view.requestMeasure());
  }

  toast(token: TokenAt, text: string) {
    clearTimeout(this.toastTimer);
    this.show({ kind: "toast", key: `toast:${token.key}`, token, dom: buildNotice(text) });
    this.toastTimer = setTimeout(() => { if (this.view.state.field(tipField, false)?.kind === "toast") this.hide(); }, 1800);
  }

  // ---- hover request

  private diagnosticsAt(token: TokenAt): HoverDiagnostic[] {
    return (this.view.state.field(marksField, false) ?? []).filter(mark => mark.from < token.to && mark.to > token.from)
      .map(mark => ({ severity: mark.severity === "error" ? "error" : mark.severity === "warning" ? "warning" : "info", message: mark.message, source: mark.source ?? serverLabels[this.binding.server], code: mark.code } as HoverDiagnostic)).slice(0, 6);
  }

  private hintAt(pos: number, hadResult = false): HoverHintView | undefined {
    let hint: string | HoverHintView | undefined;
    try { hint = this.binding.hoverHint?.(pos, hadResult); } catch { hint = undefined; }
    return typeof hint === "string" ? (hint ? { text: hint } : undefined) : hint?.text ? hint : undefined;
  }

  private actionsFor(token: TokenAt): HoverAction[] {
    const caps = this.binding.getCapabilities();
    if (!caps?.definition) return [];
    const toToken = () => { if (!this.view.state.selection.main.empty || this.view.state.selection.main.head !== token.at) this.view.dispatch({ selection: { anchor: token.at } }); };
    return [
      { id: "goToDefinition", label: "Go to Definition", hint: isMac() ? "Cmd+click" : "Ctrl+click", run: () => { this.hide(); void this.openDefinition(token); } },
      { id: "peekDefinition", label: "Peek Definition", hint: this.binding.getShortcut?.("peekDefinition") || undefined, run: () => { this.hide(); toToken(); this.view.focus(); runNavigationAction("peekDefinition"); } },
    ];
  }

  async resolve(token: TokenAt, options: { focus?: boolean; explicit?: boolean } = {}) {
    const id = ++this.seq;
    const runtime = this.runtime;
    const binding = runtime.binding;
    const view = this.view;
    const stale = () => id !== this.seq || runtime.destroyed;
    if (runtime.destroyed || !binding.isActive()) return;
    const caps = binding.getCapabilities();
    let markdown = "";
    let range: { from: number; to: number } | undefined;
    if (caps?.hover) {
      if (!await awaitSynchronized(binding, stale)) return;
      const snapshot = capture(runtime, view);
      const outcome = await runtime.session.hover(runtime.path, offsetToPosition(snapshot.doc, token.at));
      if (stale()) return;
      if (outcome.kind === "error") binding.reportError?.(outcome.error);
      if (outcome.kind === "ok") binding.reportOk?.();
      if (outcome.kind === "ok" && current(runtime, view, snapshot, outcome.response)) {
        const hover = outcome.response.data;
        if (hover) {
          markdown = hoverContentsToMarkdown(hover.markdown);
          if (hover.range) { const r = rangeToOffsets(snapshot.doc, hover.range); if (r.from <= token.at && token.at <= r.to && r.to > r.from) range = r; }
        }
      }
    }
    if (stale()) return;
    const shown: TokenAt = range ? { ...token, from: range.from, to: range.to } : token;
    const language = resolveLanguageId("", runtime.path);
    const input = {
      markdown, diagnostics: this.diagnosticsAt(token), hint: this.hintAt(token.at, Boolean(markdown.trim())), actions: [] as HoverAction[],
      fallbackLanguage: language === "text" ? undefined : language,
      openExternal: binding.openExternal, navigate: binding.navigateFile,
      onEscape: () => { this.hide(); view.focus(); },
    };
    const built = buildHoverContent({ ...input, actions: this.actionsFor(token) });
    if (!built.empty) { this.show({ kind: "hover", key: token.key, token: shown, dom: built.dom, ready: built.ready, focus: options.focus }); return; }
    // Empty answer. While the server is still coming up that is not a verdict, so say so instead of nothing.
    const notice = binding.getServerNotice?.();
    if (notice) { this.show({ kind: "notice", key: token.key, token, dom: buildNotice(SERVER_NOTICE_TEXT[notice]), focus: false }); return; }
    if (options.explicit) this.toast(token, "No information available");
    else if (this.showingKey !== undefined) this.hide();
  }

  showAtCaret() {
    const head = this.view.state.selection.main.head;
    const token = tokenAtOffset(this.view.state, head) ?? (head > 0 ? tokenAtOffset(this.view.state, head - 1) : null);
    this.pointer = undefined;
    if (!token) return;
    this.wantedKey = token.key;
    clearTimeout(this.showTimer);
    void this.resolve(token, { focus: true, explicit: true }).catch(() => undefined);
  }

  // ---- pointer

  tokenAtEvent(event: MouseEvent): TokenAt | null { return tokenAtCoords(this.view, event.clientX, event.clientY); }

  move(event: MouseEvent) {
    if (event.buttons) { this.hide(); return; }
    this.pointer = { x: event.clientX, y: event.clientY };
    this.modifier = this.isModifier(event);
    const token = this.tokenAtEvent(event);
    this.updateLink(token);
    if (!token) {
      this.wantedKey = undefined; this.seq++;
      clearTimeout(this.showTimer);
      if (this.view.state.field(tipField, false)) this.scheduleClose();
      return;
    }
    if (token.key === this.wantedKey) { clearTimeout(this.closeTimer); return; }
    if (this.modifier && token.kind === "identifier" && definitionIsAvailable(this.runtime) && this.binding.readSource) { this.wantedKey = token.key; this.seq++; clearTimeout(this.showTimer); return; }
    this.wantedKey = token.key;
    this.seq++;
    clearTimeout(this.showTimer);
    if (this.showingKey !== undefined && this.showingKey !== token.key) this.scheduleClose(160);
    this.showTimer = setTimeout(() => { void this.resolve(token).catch(() => undefined); }, HOVER_DELAY_MS);
  }

  leave() {
    this.pointer = undefined;
    this.wantedKey = undefined; this.seq++;
    clearTimeout(this.showTimer);
    this.clearLink();
    if (this.view.state.field(tipField, false)) this.scheduleClose();
  }

  // ---- link affordance and click

  isModifier(event: { metaKey: boolean; ctrlKey: boolean }) { return isMac() ? event.metaKey || event.ctrlKey : event.ctrlKey; }

  modifierChanged(event: KeyboardEvent | undefined) {
    if (!event || !this.isModifier(event)) this.chorded = false;
    const held = event ? this.isModifier(event) && !this.chorded : false;
    if (held === this.modifier) return;
    this.modifier = held;
    if (!held) { this.clearLink(); return; }
    if (this.pointer) this.updateLink(tokenAtCoords(this.view, this.pointer.x, this.pointer.y));
  }

  clearLink() {
    clearTimeout(this.linkTimer);
    this.linkKey = undefined;
    if (this.view.state.field(tipField, false)?.kind === "preview") this.hide();
    if (this.view.state.field(linkField, false)?.size) this.view.dispatch({ effects: setLink.of(null) });
  }

  updateLink(token: TokenAt | null) {
    if (!this.modifier || !token || token.kind !== "identifier" || !definitionIsAvailable(this.runtime)) { this.clearLink(); return; }
    if (token.key === this.linkKey) return;
    this.clearLink();
    this.linkKey = token.key;
    const apply = (target: LocationDto | undefined) => {
      if (!target || this.linkKey !== token.key || !this.modifier) return;
      this.view.dispatch({ effects: setLink.of({ from: token.from, to: token.to }) });
      void this.preview(token, target);
    };
    const cached = this.linkCache.get(token.key);
    if (cached !== undefined) { apply(cached || undefined); return; }
    const doc = this.view.state.doc;
    this.linkTimer = setTimeout(() => {
      void lookupDefinition(this.view, token.at, this.runtime.linkSession).then(result => {
        if (this.view.state.doc !== doc || result.status === "skipped" || result.status === "unavailable") return;
        if (result.status !== "failed") this.linkCache.set(token.key, result.status === "found" ? result.target : false);
        apply(result.status === "found" ? result.target : undefined);
      }).catch(() => undefined);
    }, 120);
  }

  /** VS Code shows the declaration while the modifier is held over a symbol. Read only, a few lines, coloured with the fence renderer. */
  async preview(token: TokenAt, target: LocationDto) {
    const read = this.binding.readSource;
    if (!read) return;
    try {
      const snippet = await read(target, 4);
      if (this.linkKey !== token.key || !this.modifier || this.runtime.destroyed) return;
      const lines = snippet.text.replace(/\n+$/, "").split("\n");
      const first = Math.max(0, target.range.start.line - snippet.startLine);
      const window = lines.slice(first, first + 7).join("\n");
      const language = resolveLanguageId("", snippet.path || target.path);
      const built = buildHoverContent({
        markdown: `\`\`\`${language === "text" ? "" : language}\n${window.replace(/`{3,}/g, "``")}\n\`\`\``, diagnostics: [], actions: [],
        onEscape: () => this.hide(),
      });
      const caption = this.view.dom.ownerDocument.createElement("div");
      caption.className = "cm-lsp-preview-path";
      caption.textContent = `${snippet.displayPath || target.path}:${target.range.start.line + 1}`;
      built.dom.prepend(caption);
      built.dom.classList.add("cm-lsp-preview");
      this.show({ kind: "preview", key: `preview:${token.key}`, token, dom: built.dom, ready: built.ready });
    } catch {
      // The underline alone is still useful.
    }
  }

  async openDefinition(token: TokenAt, side = false) {
    const result = side && this.binding.openLocationToSide ? await this.openToSide(token) : await resolveDefinition(this.view, token.at, false);
    if (result === "none") this.toast(token, NO_DEFINITION_TEXT);
  }

  private async openToSide(token: TokenAt): Promise<DefinitionResult> {
    const result = await lookupDefinition(this.view, token.at);
    if (result.status === "found") { this.binding.openLocationToSide?.(result.target); return "opened"; }
    return result.status;
  }

  /** Cmd/Ctrl-click. Decided synchronously, because the page default (a cursor, or the system context menu) has to be cancelled now. */
  mousedown(event: MouseEvent): boolean {
    this.hide();
    // Alt alone adds a cursor. With Cmd or Ctrl it opens the definition to the side.
    if (event.button !== 0 || event.shiftKey || !(event.metaKey || event.ctrlKey)) return false;
    if (!definitionIsAvailable(this.runtime)) return false;
    const token = this.tokenAtEvent(event);
    if (!token || token.kind !== "identifier") return false;
    event.preventDefault();
    this.gesture = { time: Date.now(), target: event.target, x: event.clientX, y: event.clientY };
    this.clearLink();
    void this.openDefinition(token, event.altKey).catch(() => undefined);
    return true;
  }

  /** On macOS the web view follows Ctrl-click with a `contextmenu` event. That one belongs to the gesture above and is swallowed. */
  contextmenu(event: MouseEvent): boolean {
    const gesture = this.gesture;
    this.gesture = undefined;
    if (gesture && Date.now() - gesture.time < 400 && (gesture.target === event.target || (Math.abs(gesture.x - event.clientX) <= 6 && Math.abs(gesture.y - event.clientY) <= 6))) {
      event.preventDefault(); event.stopPropagation();
      return true;
    }
    // A real context menu: act on the symbol under the pointer, like VS Code.
    this.hide();
    const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos !== null && !this.view.state.selection.ranges.some(range => !range.empty && pos >= range.from && pos <= range.to)) {
      const token = this.tokenAtEvent(event);
      this.view.dispatch({ selection: { anchor: token ? token.at : pos } });
    }
    return false;
  }

  keydown(event: KeyboardEvent): boolean {
    if (event.key === "Escape") {
      if (!this.view.state.field(tipField, false) || completionStatus(this.view.state)) return false;
      this.hide(); this.seq++; clearTimeout(this.showTimer);
      return true;
    }
    if (!["Shift", "Control", "Alt", "Meta"].includes(event.key) && !event.metaKey && !event.ctrlKey) this.hide();
    return false;
  }
}

const hoverPlugin = ViewPlugin.fromClass(HoverPlugin, {
  eventHandlers: {
    mousemove(event) { this.move(event); },
    mouseleave() { this.leave(); },
    mousedown(event) { return this.mousedown(event); },
    contextmenu(event) { return this.contextmenu(event); },
    keydown(event) { return this.keydown(event); },
    blur(event) { if (!this.overTip && !(event.relatedTarget instanceof Node && this.view.dom.querySelector(".cm-lsp-hover")?.contains(event.relatedTarget))) this.hide(); },
  },
});

function createHover(runtime: Runtime): Extension {
  return [
    tipField, linkField, hoverPlugin,
    // Alt+click adds a cursor. Cmd/Ctrl+click is go to definition while a server can answer, and CodeMirror's own rule when none can.
    EditorView.clickAddsSelectionRange.of(event => definitionIsAvailable(runtime) ? event.altKey : isMac() ? event.metaKey : event.ctrlKey),
  ];
}

// --------------------------------------------------------------- commands

function runtimeOf(view: EditorView): Runtime | undefined { return view.state.facet(runtimeFacet); }

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export type DefinitionResult = "opened" | "none" | "failed" | "skipped" | "unavailable";
export type DefinitionLookup = { status: "found"; target: LocationDto } | { status: "none" | "failed" | "skipped" | "unavailable" };

/** Asks for the definition without opening it. `session` lets the pointer-rest lookup use its own flights. */
export async function lookupDefinition(view: EditorView, pos: number, session?: LspSession): Promise<DefinitionLookup> {
  const runtime = runtimeOf(view);
  if (!runtime || runtime.destroyed) return { status: "unavailable" };
  const binding = runtime.binding;
  if (!binding.getCapabilities()?.definition) return { status: "unavailable" };
  if (!await awaitSynchronized(binding, () => runtime.destroyed)) return { status: "skipped" };
  const snapshot = capture(runtime, view);
  const outcome = await (session ?? runtime.session).definition(runtime.path, offsetToPosition(snapshot.doc, pos));
  if (outcome.kind === "silent") return { status: "skipped" };
  if (outcome.kind === "error") { binding.reportError?.(outcome.error); if (!session) binding.notify(outcome.message); return { status: "failed" }; }
  binding.reportOk?.();
  if (!current(runtime, view, snapshot, outcome.response)) return { status: "skipped" };
  const target = outcome.response.data[0];
  return target ? { status: "found", target } : { status: "none" };
}

/**
 * Asks the server for a definition and opens it. "unavailable" means no server feature is wired up,
 * "skipped" means the reply was superseded or stale, "none" and "failed" mean nothing was opened.
 */
export async function resolveDefinition(view: EditorView, pos: number, announceNone = true): Promise<DefinitionResult> {
  const result = await lookupDefinition(view, pos);
  if (result.status === "found") { runtimeOf(view)?.binding.openLocation(result.target); return "opened"; }
  if (result.status === "none" && announceNone) runtimeOf(view)?.binding.notify("No definition found.");
  return result.status;
}

export async function goToDefinitionAt(view: EditorView, pos: number): Promise<boolean> {
  return await resolveDefinition(view, pos) !== "unavailable";
}

export const goToDefinition = (view: EditorView) => {
  void goToDefinitionAt(view, view.state.selection.main.head).catch(() => undefined);
  return Boolean(runtimeOf(view)?.binding.getCapabilities()?.definition);
};

export type FormatOutcome = { status: "applied" | "unchanged" | "unsupported" | "stale" | "failed"; message?: string };

/** Converts server edits against `doc` into one change set. Throws when the edits overlap. */
export function editsToChanges(doc: Text, edits: readonly TextEditDto[]): ChangeSet {
  const specs = edits.map(edit => { const { from, to } = rangeToOffsets(doc, edit.range); return { from, to, insert: edit.newText }; }).sort((x, y) => x.from - y.from || x.to - y.to);
  for (let i = 1; i < specs.length; i++) if (specs[i].from < specs[i - 1].to) throw new RangeError("The language server returned overlapping edits.");
  return ChangeSet.of(specs, doc.length);
}

/**
 * Formats with the language server as ONE transaction. The document is left alone when it changed
 * since the request, and every failure becomes a message. This never takes part in saving.
 */
export async function formatWithLanguageServer(view: EditorView): Promise<FormatOutcome> {
  const runtime = runtimeOf(view);
  const fail = (status: FormatOutcome["status"], message: string): FormatOutcome => { runtime?.binding.notify(message); return { status, message }; };
  if (!runtime || runtime.destroyed) return { status: "unsupported" };
  const binding = runtime.binding;
  if (!binding.getCapabilities()?.formatting || view.state.readOnly) return fail("unsupported", `${serverLabels[binding.server]} cannot format this file.`);
  try {
    if (!await awaitSynchronized(binding, () => runtime.destroyed, 1500)) return fail("stale", "Formatting skipped because the file is still syncing. Try again.");
    const snapshot = capture(runtime, view);
    const outcome = await runtime.session.format(runtime.path, null);
    if (outcome.kind === "silent") return { status: "stale" };
    if (outcome.kind === "error") { binding.reportError?.(outcome.error); return fail("failed", `Formatting failed: ${outcome.message}`); }
    binding.reportOk?.();
    if (!current(runtime, view, snapshot, outcome.response)) return fail("stale", "Formatting skipped because the file changed. Try again.");
    const changes = editsToChanges(snapshot.doc, outcome.response.data);
    if (changes.empty) return { status: "unchanged" };
    view.dispatch({ changes, userEvent: "input.format", scrollIntoView: true });
    return { status: "applied" };
  } catch (cause) {
    return fail("failed", `Formatting failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

// --------------------------------------------------------------- extension

/** Adds language server features to one editor view. Separate extension entries. Formatting is the shared `formatWithLanguageServer` action, so it can be rebound. */
export function lspExtension(path: string, binding: LspBinding): Extension {
  const runtime: Runtime = { path, binding, session: binding.createSession(), linkSession: binding.createSession(), destroyed: false };
  const source = createCompletionSource(runtime);
  return [
    runtimeFacet.of(runtime),
    EditorState.languageData.of(() => binding.getCapabilities()?.completion ? [{ autocomplete: source }] : []),
    createHover(runtime),
    createDiagnostics(runtime),
    keymap.of([
      { key: "F12", run: goToDefinition, preventDefault: true },
    ]),
  ];
}
