import { ChangeSet, EditorSelection, EditorState, Facet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin, hoverTooltip, keymap, type Tooltip } from "@codemirror/view";
import { pickedCompletion, snippet, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { forceLinting, linter, type Diagnostic } from "@codemirror/lint";
import type {
  CapabilitiesDto, CompletionItemDto_Serialize, DiagnosticDto_Deserialize, DiagnosticsPublished_Deserialize, LanguageServerId,
  LocationDto, LspErrorDto, LspResponse, TextEditDto,
} from "../bindings";
import { offsetToPosition, rangeToOffsets, serverLabels, type LspSession } from "./lsp-client";

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
}

interface Runtime {
  path: string;
  binding: LspBinding;
  session: LspSession;
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

// ------------------------------------------------------------------- hover

/** Builds hover content from markdown without ever touching innerHTML. Fenced code stays verbatim. */
export function renderHoverMarkdown(markdown: string, doc: Document = document): HTMLElement {
  const root = doc.createElement("div");
  root.className = "cm-lsp-hover";
  const text = markdown.length > 8000 ? `${markdown.slice(0, 8000)}\n...` : markdown;
  const fence = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  const prose = (chunk: string) => {
    for (const block of chunk.split(/\n\s*\n/)) {
      const cleaned = block.trim().replace(/^#{1,6}\s+/gm, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\\([\\`*_{}[\]()#+\-.!])/g, "$1");
      if (!cleaned) continue;
      if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(cleaned)) { root.append(doc.createElement("hr")); continue; }
      const paragraph = doc.createElement("p");
      cleaned.split(/(`[^`\n]+`)/).forEach(part => {
        if (/^`[^`\n]+`$/.test(part)) { const code = doc.createElement("code"); code.textContent = part.slice(1, -1); paragraph.append(code); }
        else if (part) paragraph.append(doc.createTextNode(part));
      });
      root.append(paragraph);
    }
  };
  for (let match = fence.exec(text); match; match = fence.exec(text)) {
    prose(text.slice(last, match.index));
    const pre = doc.createElement("pre");
    const code = doc.createElement("code");
    code.textContent = match[1].replace(/\n$/, "");
    pre.append(code);
    root.append(pre);
    last = match.index + match[0].length;
    if (match[0].length === 0) fence.lastIndex++;
  }
  prose(text.slice(last));
  return root;
}

function createHover(runtime: Runtime) {
  return hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
    const binding = runtime.binding;
    if (runtime.destroyed || !binding.isActive() || !binding.getCapabilities()?.hover || !binding.isSynchronized()) return null;
    const snapshot = capture(runtime, view);
    const outcome = await runtime.session.hover(runtime.path, offsetToPosition(snapshot.doc, pos));
    if (outcome.kind === "error") binding.reportError?.(outcome.error);
    if (outcome.kind === "ok") binding.reportOk?.();
    if (outcome.kind !== "ok" || !current(runtime, view, snapshot, outcome.response)) return null;
    const hover = outcome.response.data;
    if (!hover || !hover.markdown.trim()) return null;
    const word = view.state.wordAt(pos);
    const range = hover.range ? rangeToOffsets(snapshot.doc, hover.range) : word ? { from: word.from, to: word.to } : { from: pos, to: pos };
    return { pos: range.from, end: range.to, above: true, create: () => ({ dom: renderHoverMarkdown(hover.markdown) }) };
  }, { hideOnChange: true });
}

// ------------------------------------------------------------- diagnostics

export interface LspMark { from: number; to: number; severity: Diagnostic["severity"]; message: string; source?: string; code?: string }

const severities: Record<string, Diagnostic["severity"]> = { error: "error", warning: "warning", information: "info", hint: "info" };

/** Maps server diagnostics (UTF-16 line and character) to clamped, non-empty document ranges. */
export function mapDiagnostics(doc: Text, diagnostics: readonly DiagnosticDto_Deserialize[]): LspMark[] {
  return diagnostics.slice(0, 2000).map(item => {
    let { from, to } = rangeToOffsets(doc, item.range);
    if (from === to) {
      if (to < doc.length && doc.sliceString(to, to + 1) !== "\n") to += 1;
      else if (from > 0) from -= 1;
    }
    return { from, to, severity: severities[item.severity ?? "error"] ?? "error", message: item.message, source: item.source ?? undefined, code: item.code ?? undefined };
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
    source: [mark.source ?? serverLabels[runtime.binding.server], mark.code].filter(Boolean).join(" "),
  })), { delay: 250 });
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

// --------------------------------------------------------------- commands

function runtimeOf(view: EditorView): Runtime | undefined { return view.state.facet(runtimeFacet); }

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export type DefinitionResult = "opened" | "none" | "failed" | "skipped" | "unavailable";

/**
 * Asks the server for a definition and opens it. "unavailable" means no server feature is wired up,
 * "skipped" means the reply was superseded or stale, "none" and "failed" mean nothing was opened.
 */
export async function resolveDefinition(view: EditorView, pos: number, announceNone = true): Promise<DefinitionResult> {
  const runtime = runtimeOf(view);
  if (!runtime || runtime.destroyed) return "unavailable";
  const binding = runtime.binding;
  if (!binding.getCapabilities()?.definition) return "unavailable";
  if (!await awaitSynchronized(binding, () => runtime.destroyed)) return "skipped";
  const snapshot = capture(runtime, view);
  const outcome = await runtime.session.definition(runtime.path, offsetToPosition(snapshot.doc, pos));
  if (outcome.kind === "silent") return "skipped";
  if (outcome.kind === "error") { binding.reportError?.(outcome.error); binding.notify(outcome.message); return "failed"; }
  binding.reportOk?.();
  if (!current(runtime, view, snapshot, outcome.response)) return "skipped";
  const target = outcome.response.data[0];
  if (target) { binding.openLocation(target); return "opened"; }
  if (announceNone) binding.notify("No definition found.");
  return "none";
}

export async function goToDefinitionAt(view: EditorView, pos: number): Promise<boolean> {
  return await resolveDefinition(view, pos) !== "unavailable";
}

export const goToDefinition = (view: EditorView) => {
  void goToDefinitionAt(view, view.state.selection.main.head).catch(() => undefined);
  return Boolean(runtimeOf(view)?.binding.getCapabilities()?.definition);
};

/**
 * Cmd/Ctrl-click choice: CodeMirror uses that modifier to add a cursor, and multiple selections stay on.
 * So the click first asks the server whether the token under it has a definition. If it does, the
 * definition opens. If it does not (or the request fails), the cursor is added exactly as the default
 * would have done. Clicks off a word, and any click while no server can answer, are left to
 * CodeMirror untouched. F12 always goes to the definition.
 */
export async function definitionOrAddCursor(view: EditorView, pos: number): Promise<DefinitionResult> {
  const doc = view.state.doc;
  const result = await resolveDefinition(view, pos, false);
  if ((result === "none" || result === "failed") && view.state.doc === doc && view.state.facet(EditorState.allowMultipleSelections)) {
    const ranges = view.state.selection.ranges;
    view.dispatch({ selection: EditorSelection.create([...ranges, EditorSelection.cursor(Math.min(pos, doc.length))], ranges.length), userEvent: "select.pointer" });
  }
  return result;
}

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

/** Adds language server features to one editor view. Separate extension entries, no keymap overlap with the editor. */
export function lspExtension(path: string, binding: LspBinding): Extension {
  const runtime: Runtime = { path, binding, session: binding.createSession(), destroyed: false };
  const source = createCompletionSource(runtime);
  return [
    runtimeFacet.of(runtime),
    EditorState.languageData.of(() => binding.getCapabilities()?.completion ? [{ autocomplete: source }] : []),
    createHover(runtime),
    createDiagnostics(runtime),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !(isMac() ? event.metaKey : event.ctrlKey) || !binding.getCapabilities()?.definition) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null || !view.state.wordAt(pos)) return false;
        event.preventDefault();
        void definitionOrAddCursor(view, pos).catch(() => undefined);
        return true;
      },
    }),
    keymap.of([
      { key: "F12", run: goToDefinition, preventDefault: true },
      { key: "Mod-Alt-Shift-f", run: view => { if (!runtimeOf(view)?.binding.getCapabilities()?.formatting) return false; void formatWithLanguageServer(view).catch(() => undefined); return true; }, preventDefault: true },
    ]),
  ];
}
