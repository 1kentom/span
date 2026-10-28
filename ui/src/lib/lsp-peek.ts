import { Compartment, EditorState, Prec, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, lineNumbers, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { LanguageSupport, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { DocumentHighlightDto, LocationDto, SourceSnippetDto } from "../bindings";
import { loadLanguage } from "../editor/languages";
import { syntaxHighlightStyle } from "../editor/syntax-highlight";
import { awaitSynchronized, replyIsCurrent } from "./lsp-codemirror";
import { rangeToOffsets } from "./lsp-client";
import { directoryLabel, fileLabel, toPosition, wordAt } from "./lsp-navigation";
import { iconAssetPath } from "./menuIcons";
import { keepPeekOpen, setKeepPeekOpen } from "./navigation-prefs";
import { currentPlace, jumpHistory, navigationContext, registerEditorView } from "./navigation-context";

// ------------------------------------------------------------ read only source

const sourceLanguage = new Compartment();
const markedLines = StateEffect.define<number>();
const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(markedLines)) return Decoration.set([Decoration.line({ class: "cm-peek-target-line" }).range(transaction.state.doc.line(Math.max(1, Math.min(transaction.state.doc.lines, effect.value))).from)]);
    return value.map(transaction.changes);
  },
  provide: field => EditorView.decorations.from(field),
});

/**
 * A read-only, syntax highlighted view of a source snippet. It never connects to a language server
 * and never creates a buffer, so library and JDK sources cannot be edited or synchronised.
 */
export function createSourceView(parent: HTMLElement, snippet: SourceSnippetDto, options: { dark?: boolean } = {}): EditorView {
  const first = snippet.startLine + 1;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: snippet.text,
      extensions: [
        EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ "aria-readonly": "true", "aria-label": `Read-only source of ${snippet.displayPath}` }),
        lineNumbers({ formatNumber: line => String(line + first - 1) }),
        syntaxHighlighting(syntaxHighlightStyle), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        sourceLanguage.of([]), markField,
        EditorView.theme({}, { dark: options.dark !== false }),
      ],
    }),
  });
  const target = Math.max(1, Math.min(view.state.doc.lines, snippet.highlightRange.start.line - snippet.startLine + 1));
  view.dispatch({ effects: [markedLines.of(target), EditorView.scrollIntoView(view.state.doc.line(target).from, { y: "center" })] });
  void loadLanguage(snippet.language, snippet.path).then(support => {
    if (!support || !view.dom.isConnected) return;
    view.dispatch({ effects: sourceLanguage.reconfigure(support instanceof LanguageSupport ? support : support.extension) });
  }).catch(() => undefined);
  return view;
}

function icon(name: string, size = 14): HTMLElement {
  const element = document.createElement("span");
  element.className = "icon"; element.setAttribute("aria-hidden", "true");
  const url = `url('${iconAssetPath(name)}')`;
  Object.assign(element.style, { width: `${size}px`, height: `${size}px`, maskImage: url, webkitMaskImage: url, maskRepeat: "no-repeat", webkitMaskRepeat: "no-repeat", maskSize: "contain", webkitMaskSize: "contain", backgroundColor: "currentColor", display: "inline-block" });
  return element;
}

function button(label: string, iconName: string, onClick: () => void, text?: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button"; element.className = "cm-peek-button"; element.title = label; element.setAttribute("aria-label", label);
  element.append(icon(iconName)); if (text) element.append(Object.assign(document.createElement("span"), { textContent: text }));
  element.addEventListener("mousedown", event => event.preventDefault());
  element.addEventListener("click", onClick);
  return element;
}

// ------------------------------------------------------------ peek widget

export interface PeekEntry { location: LocationDto; snippet?: SourceSnippetDto; error?: string }
export interface PeekState { anchor: number; title: string; entries: readonly PeekEntry[]; index: number }

const openPeekEffect = StateEffect.define<PeekState | null>();
const patchPeekEffect = StateEffect.define<{ entries: readonly PeekEntry[]; index?: number; source: readonly PeekEntry[] }>();

let peekHeight = 280;
const PEEK_MIN = 120; const PEEK_MAX = 640;
const CONTEXT_LINES = 10;

export const peekField = StateField.define<PeekState | null>({
  create: () => null,
  update(value, transaction) {
    if (value && transaction.docChanged) value = { ...value, anchor: transaction.changes.mapPos(value.anchor, 1) };
    for (const effect of transaction.effects) {
      if (effect.is(openPeekEffect)) value = effect.value;
      else if (effect.is(patchPeekEffect) && value && effect.value.source === value.entries) value = { ...value, entries: effect.value.entries, index: effect.value.index ?? value.index };
    }
    return value;
  },
  provide: field => EditorView.decorations.compute([field], state => {
    const peek = state.field(field);
    return peek ? Decoration.set([Decoration.widget({ widget: new PeekWidget(peek), block: true, side: 1 }).range(Math.min(state.doc.length, peek.anchor))]) : Decoration.none;
  }),
});

export const peekState = (state: EditorState): PeekState | null => state.field(peekField, false) ?? null;

class PeekWidget extends WidgetType {
  constructor(readonly peek: PeekState) { super(); }
  eq(other: PeekWidget): boolean { return other.peek.entries === this.peek.entries && other.peek.index === this.peek.index && other.peek.title === this.peek.title; }
  get estimatedHeight(): number { return peekHeight + 34; }
  ignoreEvent(): boolean { return true; }
  destroy(dom: HTMLElement): void { (dom as HTMLElement & { _peekSource?: EditorView })._peekSource?.destroy(); }

  toDOM(view: EditorView): HTMLElement {
    const { peek } = this;
    const entry = peek.entries[peek.index];
    const root = document.createElement("div") as HTMLElement & { _peekSource?: EditorView };
    root.className = "cm-peek"; root.tabIndex = 0; root.setAttribute("role", "dialog"); root.setAttribute("aria-label", `Peek ${peek.title}`);
    const header = document.createElement("div"); header.className = "cm-peek-header";
    const where = document.createElement("div"); where.className = "cm-peek-title";
    const name = Object.assign(document.createElement("strong"), { textContent: entry ? fileLabel(entry.location.displayPath || entry.location.path) : peek.title });
    const line = Object.assign(document.createElement("span"), { className: "cm-peek-line", textContent: entry ? `:${entry.location.range.start.line + 1}` : "" });
    const folder = Object.assign(document.createElement("span"), { className: "cm-peek-folder", textContent: entry ? directoryLabel(entry.location.displayPath || entry.location.path) : "" });
    where.append(name, line, folder);
    const count = Object.assign(document.createElement("span"), { className: "cm-peek-count", textContent: `${peek.index + 1} of ${peek.entries.length}` });
    count.setAttribute("aria-live", "polite");
    header.append(where, count,
      button("Previous result (Shift+F4)", "arrow-up3", () => stepPeek(view, -1)),
      button("Next result (F4)", "arrow-down4", () => stepPeek(view, 1)),
      button("Open in editor (Enter)", "ExportSquare", () => openPeekTarget(view), "Open"),
      keepButton(),
      button("Close peek (Escape)", "CloseCircle", () => closePeek(view)));
    function keepButton(): HTMLButtonElement {
      const toggle = button("Keep peek open on double click", "Eye", () => { setKeepPeekOpen(!keepPeekOpen()); toggle.setAttribute("aria-pressed", String(keepPeekOpen())); toggle.classList.toggle("on", keepPeekOpen()); });
      toggle.setAttribute("aria-pressed", String(keepPeekOpen())); toggle.classList.toggle("on", keepPeekOpen());
      return toggle;
    }
    const body = document.createElement("div"); body.className = "cm-peek-body";
    // Like VS Code: a double click in the peek closes it unless the "stable peek" preference is on.
    body.addEventListener("dblclick", event => { if (!keepPeekOpen() && !(event.target as HTMLElement).closest(".cm-peek-list")) closePeek(view); });
    body.dataset.testid = "peek-body"; body.style.height = `${peekHeight}px`;
    if (peek.entries.length > 1) {
      const list = document.createElement("ul"); list.className = "cm-peek-list"; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "Peek results");
      peek.entries.forEach((item, index) => {
        const row = document.createElement("li"); row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(index === peek.index));
        row.className = index === peek.index ? "selected" : "";
        row.append(Object.assign(document.createElement("span"), { className: "cm-peek-row-name", textContent: fileLabel(item.location.displayPath || item.location.path) }),
          Object.assign(document.createElement("span"), { className: "cm-peek-row-line", textContent: `:${item.location.range.start.line + 1}` }));
        row.title = item.location.displayPath || item.location.path;
        row.addEventListener("mousedown", event => event.preventDefault());
        row.addEventListener("click", () => setPeekIndex(view, index));
        row.addEventListener("dblclick", () => openPeekTarget(view));
        list.append(row);
      });
      body.append(list);
    }
    const source = document.createElement("div"); source.className = "cm-peek-source";
    if (entry?.snippet) root._peekSource = createSourceView(source, entry.snippet, { dark: view.state.facet(EditorView.darkTheme) });
    else source.append(Object.assign(document.createElement("div"), { className: "cm-peek-message", textContent: entry?.error ?? "Loading source…" }));
    body.append(source);
    const resize = document.createElement("div"); resize.className = "cm-peek-resize"; resize.setAttribute("role", "separator"); resize.setAttribute("aria-orientation", "horizontal");
    resize.setAttribute("aria-label", "Resize peek"); resize.tabIndex = 0;
    const setHeight = (height: number) => { peekHeight = Math.max(PEEK_MIN, Math.min(PEEK_MAX, Math.round(height))); body.style.height = `${peekHeight}px`; view.requestMeasure(); };
    resize.addEventListener("pointerdown", event => {
      event.preventDefault(); const startY = event.clientY; const startHeight = peekHeight;
      const move = (next: PointerEvent) => setHeight(startHeight + next.clientY - startY);
      const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop);
    });
    resize.addEventListener("keydown", event => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault(); event.stopPropagation(); setHeight(peekHeight + (event.key === "ArrowDown" ? 24 : -24));
    });
    root.append(header, body, resize);
    root.addEventListener("keydown", event => {
      if (event.target instanceof HTMLElement && event.target.closest(".cm-peek-resize")) return;
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
      let handled = true;
      if (event.key === "Escape" && plain) closePeek(view);
      else if (event.key === "Enter" && plain) openPeekTarget(view);
      else if (event.key === "F4" && !event.ctrlKey && !event.metaKey && !event.altKey) stepPeek(view, event.shiftKey ? -1 : 1);
      else if (event.key === "ArrowDown" && plain && peek.entries.length > 1) stepPeek(view, 1);
      else if (event.key === "ArrowUp" && plain && peek.entries.length > 1) stepPeek(view, -1);
      else handled = false;
      if (handled) { event.preventDefault(); event.stopPropagation(); }
    });
    const refocus = view.dom.contains(document.activeElement) || view.hasFocus;
    if (refocus) queueMicrotask(() => { if (root.isConnected) root.focus({ preventScroll: false }); });
    return root;
  }
}

async function loadEntry(view: EditorView, source: readonly PeekEntry[], index: number): Promise<void> {
  const ctx = navigationContext();
  const entry = source[index];
  if (!ctx || !entry || entry.snippet || entry.error) return;
  let patch: PeekEntry;
  try { patch = { ...entry, snippet: await ctx.port.readSource(entry.location, CONTEXT_LINES) }; }
  catch (error) { patch = { ...entry, error: error instanceof Error ? error.message : String(error) }; }
  const state = peekState(view.state);
  if (!view.dom.isConnected || !state || state.entries !== source) return;
  view.dispatch({ effects: patchPeekEffect.of({ entries: source.map((item, position) => position === index ? patch : item), source }) });
}

function load(view: EditorView, index: number): void {
  const state = peekState(view.state);
  if (state) void loadEntry(view, state.entries, index);
}

/** Opens (or replaces) the inline peek under the caret line. */
export function openPeek(view: EditorView, locations: readonly LocationDto[], title: string, startAt = 0): boolean {
  if (!locations.length) return false;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const index = Math.max(0, Math.min(locations.length - 1, startAt));
  view.dispatch({ effects: [openPeekEffect.of({ anchor: line.to, title, entries: locations.map(location => ({ location })), index }), EditorView.scrollIntoView(line.to, { y: "nearest", yMargin: 40 })] });
  load(view, index);
  return true;
}

export function closePeek(view: EditorView): boolean {
  if (!peekState(view.state)) return false;
  view.dispatch({ effects: openPeekEffect.of(null) });
  view.focus();
  return true;
}

export function setPeekIndex(view: EditorView, index: number): void {
  const state = peekState(view.state);
  if (!state || index < 0 || index >= state.entries.length) return;
  view.dispatch({ effects: patchPeekEffect.of({ entries: state.entries, index, source: state.entries }) });
  load(view, index);
}

export function stepPeek(view: EditorView, delta: number): boolean {
  const state = peekState(view.state);
  if (!state) return false;
  const count = state.entries.length;
  setPeekIndex(view, ((state.index + delta) % count + count) % count);
  return true;
}

/** "Open in editor": navigate to the shown result through the app's jump path and close the peek. */
export function openPeekTarget(view: EditorView): boolean {
  const state = peekState(view.state);
  const ctx = navigationContext();
  const entry = state?.entries[state.index];
  if (!state || !ctx || !entry) return false;
  view.dispatch({ effects: openPeekEffect.of(null) });
  const location = entry.location;
  jumpHistory.record(currentPlace());
  // The navigation store decides: library locations open in the read-only viewer, the rest in the workspace.
  if (openExternalHandler) openExternalHandler(location);
  else if (!location.external) void ctx.open(location.path, location.range.start.line + 1, location.range.start.character + 1);
  return true;
}

/** The navigation store registers how a location is opened (see `openLocation`), so the peek stays free of store imports. */
let openExternalHandler: ((location: LocationDto) => void) | undefined;
export const setExternalLocationOpener = (open: ((location: LocationDto) => void) | undefined): void => { openExternalHandler = open; };

// ------------------------------------------------------------ document highlights

const setHighlights = StateEffect.define<DecorationSet>();
const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    if (transaction.docChanged) return Decoration.none;
    for (const effect of transaction.effects) if (effect.is(setHighlights)) return effect.value;
    return value;
  },
  provide: field => EditorView.decorations.from(field),
});

export function highlightDecorations(view: Pick<EditorView, "state">, highlights: readonly DocumentHighlightDto[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const rows = highlights.map(highlight => ({ ...rangeToOffsets(view.state.doc, highlight.range), kind: highlight.kind })).filter(row => row.to > row.from).sort((a, b) => a.from - b.from || a.to - b.to);
  let last = -1;
  for (const row of rows) { if (row.from < last) continue; builder.add(row.from, row.to, Decoration.mark({ class: `cm-lsp-occurrence cm-lsp-occurrence-${row.kind}` })); last = row.to; }
  return builder.finish();
}

const HIGHLIGHT_DELAY = 280;

function highlightPlugin(path: string) {
  return ViewPlugin.fromClass(class {
    timer: ReturnType<typeof setTimeout> | undefined;
    generation = 0;
    constructor(readonly view: EditorView) {}
    update(update: ViewUpdate) {
      if (update.docChanged) { this.cancel(); return; }
      if (update.selectionSet) this.schedule();
    }
    cancel() { this.generation += 1; clearTimeout(this.timer); this.timer = undefined; navigationContext()?.session.cancel(`highlight:${path}`); }
    schedule() {
      this.cancel();
      const request = this.generation;
      this.timer = setTimeout(() => { void this.run(request).catch(() => undefined); }, HIGHLIGHT_DELAY);
      if (this.view.state.field(highlightField, false)?.size) queueMicrotask(() => { if (request === this.generation && this.view.dom.isConnected) this.view.dispatch({ effects: setHighlights.of(Decoration.none) }); });
    }
    async run(request: number) {
      const ctx = navigationContext(); const view = this.view;
      if (!ctx || ctx.activePath() !== path || !ctx.server(path)?.capabilities?.documentHighlight) return;
      const selection = view.state.selection.main;
      if (!selection.empty || !wordAt(view.state.doc, selection.head)) return;
      const doc = view.state.doc; const epoch = ctx.epoch(path); const generation = ctx.workspaceGeneration();
      if (!await awaitSynchronized({ isSynchronized: () => ctx.synchronized(path) }, () => request !== this.generation)) return;
      const outcome = await ctx.session.run(`highlight:${path}`, id => ctx.port.highlights(path, toPosition(doc, selection.head), id));
      if (outcome.kind !== "ok" || request !== this.generation) return;
      const binding = { isActive: () => ctx.activePath() === path, getRevision: () => ctx.revision(path), getEpoch: () => ctx.epoch(path), getWorkspaceGeneration: ctx.workspaceGeneration };
      if (!replyIsCurrent(binding, { doc, epoch, generation }, view.state.doc, outcome.response)) return;
      view.dispatch({ effects: setHighlights.of(highlightDecorations(view, outcome.response.data)) });
    }
    destroy() { this.cancel(); }
  });
}

// ------------------------------------------------------------ extension

/**
 * Everything the navigation UI adds to one editor view: the peek block, document highlights and the
 * registration that lets commands find the view of a file. Keys only act while a peek is open.
 */
export function navigationExtension(path: string): Extension {
  return [
    peekField, highlightField, highlightPlugin(path),
    ViewPlugin.fromClass(class {
      off: () => void;
      constructor(view: EditorView) { this.off = registerEditorView(path, view); }
      destroy() { this.off(); }
    }),
    Prec.highest(keymap.of([
      { key: "Escape", run: view => closePeek(view) },
      { key: "F4", run: view => stepPeek(view, 1) },
      { key: "Shift-F4", run: view => stepPeek(view, -1) },
    ])),
  ];
}
