import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Annotation, Compartment, EditorState, StateEffect, StateField, Text, Transaction, type ChangeSet, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, rectangularSelection, crosshairCursor, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, foldService, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { gotoLine, highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { tags } from "@lezer/highlight";
import type { BufferSnapshot, EditProposal, ProposalHunk, SyntaxSnapshot, TextEdit } from "../bindings";
import "../styles/editor.css";

export interface EditorEdit {
  baseRevision: number;
  changes: TextEdit[];
  document: Text;
  previousDocument: Text;
  changeSet: ChangeSet;
  historyOrigin?: object;
}

export interface EditorDocumentChange { before: Text; changes: ChangeSet }

export interface EditorCursor {
  line: number;
  column: number;
  from: number;
  to: number;
  selectedText: string;
}

export interface EditorProps {
  buffer: BufferSnapshot;
  document?: Text;
  change?: EditorDocumentChange;
  onEdit: (edit: EditorEdit) => void;
  onSave: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onCursor?: (cursor: EditorCursor) => void;
  syntax?: SyntaxSnapshot;
  theme?: "dark" | "light" | "purple";
  active?: boolean;
  autofocus?: boolean;
  revealLine?: number;
  fontSize?: number;
  tabSize?: number;
  wordWrap?: boolean;
  proposal?: EditProposal;
  proposalBusy?: boolean;
  proposalStale?: boolean;
  onApplyProposal?: (proposalId: string, hunkIds: string[]) => void;
  onRejectProposal?: (proposalId: string) => void;
}

const remoteEdit = Annotation.define<boolean>();
const setSyntax = StateEffect.define<SyntaxSnapshot | undefined>();
const setProposalDecorations = StateEffect.define<DecorationSet>();

function proposalSnippet(text: string) {
  const excerpt = text.slice(0, 12_000).split("\n");
  const preview = excerpt.slice(0, 40).join("\n");
  return preview + (excerpt.length > 40 || text.length > 12_000 ? "\n… Preview shortened" : "");
}

const proposalDOMHunks = new WeakMap<HTMLElement, ProposalHunk>();

export class ProposalWidget extends WidgetType {
  constructor(
    readonly hunk: ProposalHunk,
    readonly index: number,
    readonly selected: boolean,
    readonly busy: boolean,
    readonly onToggle: (hunkId: string, keep: boolean) => void,
  ) { super(); }

  eq(other: ProposalWidget) {
    return this.hunk === other.hunk && this.index === other.index && this.selected === other.selected && this.busy === other.busy && this.onToggle === other.onToggle;
  }

  toDOM() {
    const container = document.createElement("section");
    container.contentEditable = "false";
    container.className = `cm-proposal-hunk ${this.selected ? "is-kept" : "is-skipped"}`;
    container.setAttribute("aria-label", `Suggested change ${this.index + 1}`);
    container.dataset.hunkId = this.hunk.id;
    container.dataset.hunkIndex = String(this.index);
    proposalDOMHunks.set(container, this.hunk);
    const header = document.createElement("div");
    header.className = "cm-proposal-hunk-header";
    const label = document.createElement("span");
    label.textContent = `Change ${this.index + 1}`;
    const controls = document.createElement("div");
    controls.className = "cm-proposal-hunk-controls";
    for (const keep of [true, false]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = keep ? "Keep" : "Skip";
      button.setAttribute("aria-label", `${keep ? "Keep" : "Skip"} change ${this.index + 1}`);
      button.setAttribute("aria-pressed", String(this.selected === keep));
      button.disabled = this.busy;
      button.addEventListener("click", (event) => { event.preventDefault(); this.onToggle(this.hunk.id, keep); });
      controls.append(button);
    }
    header.append(label, controls);
    container.append(header);
    for (const [title, content, kind] of [["Current", this.hunk.before, "before"], ["Suggested", this.hunk.after, "after"]] as const) {
      const snippet = document.createElement("div");
      snippet.className = `cm-proposal-snippet cm-proposal-${kind}`;
      const caption = document.createElement("span");
      caption.className = "cm-proposal-caption";
      caption.textContent = title;
      const code = document.createElement("pre");
      code.textContent = content ? proposalSnippet(content) : kind === "before" ? "(new code)" : "(removed)";
      snippet.append(caption, code);
      container.append(snippet);
    }
    return container;
  }

  updateDOM(container: HTMLElement) {
    if (proposalDOMHunks.get(container) !== this.hunk || container.dataset.hunkIndex !== String(this.index)) return false;
    container.classList.toggle("is-kept", this.selected);
    container.classList.toggle("is-skipped", !this.selected);
    const buttons = container.querySelectorAll("button");
    buttons.forEach((button, index) => {
      button.setAttribute("aria-pressed", String(this.selected === (index === 0)));
      button.disabled = this.busy;
    });
    return true;
  }

  ignoreEvent() { return true; }
}

const proposalState = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    if (transaction.docChanged) value = Decoration.none;
    for (const effect of transaction.effects) if (effect.is(setProposalDecorations)) value = effect.value;
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function isLowSurrogate(value: number) {
  return value >= 0xdc00 && value <= 0xdfff;
}

/** A recovery diff reads bounded chunks and preserves the persistent insertion. */
export function persistentDocumentChange(previous: Text, next: Text): { from: number; to: number; insert: Text } | undefined {
  if (previous === next) return undefined;
  const limit = Math.min(previous.length, next.length);
  let from = 0;
  while (from < limit) {
    const end = Math.min(from + 4096, limit);
    const before = previous.sliceString(from, end);
    const after = next.sliceString(from, end);
    if (before === after) { from = end; continue; }
    let index = 0;
    while (index < before.length && before.charCodeAt(index) === after.charCodeAt(index)) index++;
    from += index;
    break;
  }
  if (from === previous.length && from === next.length) return undefined;
  if (from > 0 && from < previous.length && isLowSurrogate(previous.sliceString(from, from + 1).charCodeAt(0))) from--;
  let to = previous.length;
  let nextEnd = next.length;
  while (to > from && nextEnd > from) {
    const size = Math.min(4096, to - from, nextEnd - from);
    const before = previous.sliceString(to - size, to);
    const after = next.sliceString(nextEnd - size, nextEnd);
    if (before === after) { to -= size; nextEnd -= size; continue; }
    let index = size;
    while (index > 0 && before.charCodeAt(index - 1) === after.charCodeAt(index - 1)) index--;
    to -= size - index;
    nextEnd -= size - index;
    break;
  }
  if (to < previous.length && isLowSurrogate(previous.sliceString(to, to + 1).charCodeAt(0))) { to++; nextEnd++; }
  return { from, to, insert: next.slice(from, nextEnd) };
}

export function transactionEdits(changes: ChangeSet): TextEdit[] {
  const edits: TextEdit[] = [];
  changes.iterChanges((from, to, _fromNext, _toNext, inserted) => edits.push({ from, to, insert: inserted.toString() }));
  return edits;
}

function languageFor(language: string, path: string): Extension {
  const name = language.toLowerCase();
  if (name.includes("typescript") || /\.[cm]?tsx?$/.test(path)) return javascript({ typescript: true, jsx: /\.tsx$/.test(path) });
  if (name.includes("javascript") || /\.[cm]?jsx?$/.test(path)) return javascript({ jsx: /\.jsx$/.test(path) });
  if (name === "json" || path.endsWith(".json")) return json();
  if (name === "markdown" || /\.(md|mdx)$/.test(path)) return markdown();
  if (name === "rust" || path.endsWith(".rs")) return rust();
  if (name === "python" || path.endsWith(".py")) return python();
  return [];
}

const codeHighlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "var(--syntax-keyword, #78c8c7)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--syntax-string, #cc8dcb)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--syntax-function, #d9ba7e)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--syntax-number, #d9ba7e)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--syntax-type, #80b7ec)" },
  { tag: [tags.comment, tags.meta], color: "var(--syntax-comment, #72777c)", fontStyle: "italic" },
  { tag: [tags.definition(tags.variableName)], color: "var(--syntax-definition, #af9bf2)" },
  { tag: [tags.heading], color: "var(--syntax-function, #d9ba7e)", fontWeight: "600" },
  { tag: [tags.link, tags.url], color: "var(--syntax-type, #80b7ec)", textDecoration: "underline" },
  { tag: [tags.invalid], color: "var(--syntax-invalid, #e58a8a)" },
]);

function indentation(view: EditorView): DecorationSet {
  const decorations = [];
  const visited = new Set<number>();
  for (const range of view.visibleRanges) {
    let position = range.from;
    while (position <= range.to) {
      const line = view.state.doc.lineAt(position);
      if (!visited.has(line.from)) {
        visited.add(line.from);
        const leading = /^\s*/.exec(line.text)?.[0] ?? "";
        let columns = 0;
        for (const character of leading) columns += character === "\t" ? view.state.tabSize - (columns % view.state.tabSize) : 1;
        if (columns > 0) decorations.push(Decoration.line({ attributes: { class: "cm-indent-guides", style: `--indent-guide-width: ${columns}ch` } }).range(line.from));
      }
      if (line.to >= range.to || line.to === view.state.doc.length) break;
      position = line.to + 1;
    }
  }
  return Decoration.set(decorations, true);
}

const indentGuides = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = indentation(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.state.tabSize !== update.startState.tabSize) this.decorations = indentation(update.view);
  }
}, { decorations: (plugin) => plugin.decorations });

const syntaxState = StateField.define<SyntaxSnapshot | undefined>({
  create: () => undefined,
  update(value, transaction) {
    if (transaction.docChanged) value = undefined;
    for (const effect of transaction.effects) if (effect.is(setSyntax)) value = effect.value;
    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (snapshot) => Decoration.set((snapshot?.highlights ?? [])
      .filter((span) => span.to > span.from)
      .map((span) => Decoration.mark({ class: `cm-tree-${span.kind.replace(/[^\w-]/g, "-")}` }).range(span.from, span.to)), true)),
    foldService.from(field, (snapshot) => (state, lineStart, lineEnd) => {
      const fold = snapshot?.folds.find((range) => range.from >= lineStart && range.from <= lineEnd && range.to <= state.doc.length);
      return fold ? { from: fold.from, to: fold.to } : null;
    }),
  ],
});

export default function Editor(props: EditorProps) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let currentPath = "";
  let currentLanguage = "";
  let syncGeneration = 0;
  let lastReveal = "";
  let appliedSyntax: SyntaxSnapshot | undefined;
  let sharedDocument: Text | undefined;
  let wasActive = false;
  let historyOrigin = {};
  let proposalId: string | undefined;
  let proposalGeneration = 0;
  const [selectedHunks, setSelectedHunks] = createSignal(new Set<string>());
  const [proposalChanged, setProposalChanged] = createSignal(false);
  const language = new Compartment();
  const appearance = new Compartment();
  const preferences = new Compartment();
  const proposalIsStale = () => Boolean(props.proposal && (props.proposalStale || proposalChanged() || props.buffer.revision !== props.proposal.baseRevision));
  const toggleHunk = (hunkId: string, keep: boolean) => setSelectedHunks((current) => {
    const next = new Set(current);
    if (keep) next.add(hunkId); else next.delete(hunkId);
    return next;
  });

  const preferenceExtensions = (tabSize: number, wordWrap: boolean): Extension => [
    EditorState.tabSize.of(tabSize), indentUnit.of(" ".repeat(tabSize)), wordWrap ? EditorView.lineWrapping : [],
  ];

  function reportCursor() {
    if (!view) return;
    const selection = view.state.selection.main;
    const line = view.state.doc.lineAt(selection.head);
    props.onCursor?.({ line: line.number, column: selection.head - line.from + 1, from: selection.from, to: selection.to, selectedText: view.state.sliceDoc(selection.from, selection.to) });
  }

  function extensions(): Extension[] {
    return [
      lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(),
      props.onUndo ? [] : history(), rectangularSelection(), crosshairCursor(), indentOnInput(), bracketMatching(),
      closeBrackets(), foldGutter({ markerDOM: (open) => {
        const marker = document.createElement("span");
        marker.className = `cm-fold-chevron ${open ? "is-open" : ""}`;
        marker.setAttribute("aria-hidden", "true");
        return marker;
      } }),
      search({ top: true }), highlightSelectionMatches(), indentGuides, syntaxState, proposalState,
      EditorState.allowMultipleSelections.of(true),
      preferences.of(preferenceExtensions(props.tabSize ?? 2, props.wordWrap ?? false)),
      language.of(languageFor(props.buffer.language, props.buffer.path)),
      appearance.of(EditorView.theme({}, { dark: props.theme !== "light" })),
      syntaxHighlighting(codeHighlighting), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([
        { key: "Mod-z", run: (editor) => { if (props.onUndo) { props.onUndo(); return true; } return undo(editor); }, preventDefault: true },
        { key: "Mod-Shift-z", run: (editor) => { if (props.onRedo) { props.onRedo(); return true; } return redo(editor); }, preventDefault: true },
        { key: "Mod-y", run: (editor) => { if (props.onRedo) { props.onRedo(); return true; } return redo(editor); }, preventDefault: true },
        { key: "Mod-s", run: () => { props.onSave(); return true; }, preventDefault: true },
        { key: "Mod-Alt-g", run: gotoLine },
        ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, ...completionKeymap, indentWithTab,
      ]),
      EditorView.domEventHandlers({ beforeinput: (event) => {
        if (event.inputType === "historyUndo" && props.onUndo) { event.preventDefault(); props.onUndo(); return true; }
        if (event.inputType === "historyRedo" && props.onRedo) { event.preventDefault(); props.onRedo(); return true; }
        return false;
      } }),
      EditorView.contentAttributes.of({ "aria-label": `Edit ${props.buffer.path.split(/[\\/]/).pop() ?? "document"}`, "aria-multiline": "true", spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          appliedSyntax = undefined;
          if (props.proposal) setProposalChanged(true);
          for (const transaction of update.transactions) {
            if (transaction.docChanged && !transaction.annotation(remoteEdit)) {
              const previousDocument = sharedDocument ?? transaction.startState.doc;
              sharedDocument = transaction.newDoc;
              props.onEdit({ baseRevision: props.buffer.revision, changes: transactionEdits(transaction.changes), document: transaction.newDoc, previousDocument, changeSet: transaction.changes, historyOrigin });
            }
          }
        }
        if (update.selectionSet && !update.docChanged) historyOrigin = {};
        if (update.selectionSet || update.docChanged || update.focusChanged) reportCursor();
      }),
    ];
  }

  onMount(() => {
    currentPath = props.buffer.path;
    currentLanguage = props.buffer.language;
    const state = EditorState.create({ doc: props.document ?? props.buffer.text, extensions: extensions() });
    sharedDocument = state.doc;
    view = new EditorView({ parent: host, state });
    reportCursor();
    if (props.autofocus) view.focus();
  });

  createEffect(() => {
    const snapshot = { path: props.buffer.path, language: props.buffer.language, text: props.buffer.text, revision: props.buffer.revision };
    const syntax = props.syntax;
    const nextDocument = props.document;
    const transition = props.change;
    const theme = props.theme;
    const revealLine = props.revealLine;
    const tabSize = props.tabSize ?? 2;
    const wordWrap = props.wordWrap ?? false;
    const active = props.active !== false;
    const generation = ++syncGeneration;
    // Store acknowledgments can arrive inside the update listener. Defer their
    // application until CodeMirror has finished its current transaction.
    queueMicrotask(() => {
      if (!view || generation !== syncGeneration) return;
      if (snapshot.path !== currentPath) {
        currentPath = snapshot.path;
        currentLanguage = snapshot.language;
        appliedSyntax = undefined;
        view.setState(EditorState.create({ doc: nextDocument ?? snapshot.text, extensions: extensions() }));
        sharedDocument = view.state.doc;
        reportCursor();
      }
      const wanted = nextDocument ?? Text.of(snapshot.text.split("\n"));
      const change = wanted === sharedDocument ? undefined
        : transition && transition.before === sharedDocument ? transition.changes
        : persistentDocumentChange(view.state.doc, wanted);
      const effects: StateEffect<unknown>[] = [];
      if (snapshot.language !== currentLanguage) {
        currentLanguage = snapshot.language;
        effects.push(language.reconfigure(languageFor(snapshot.language, snapshot.path)));
      }
      if (view.state.facet(EditorView.darkTheme) !== (theme !== "light")) {
        effects.push(appearance.reconfigure(EditorView.theme({}, { dark: theme !== "light" })));
      }
      if (view.state.tabSize !== tabSize || view.lineWrapping !== wordWrap) effects.push(preferences.reconfigure(preferenceExtensions(tabSize, wordWrap)));
      const validSyntax = syntax?.revision === snapshot.revision ? syntax : undefined;
      if (appliedSyntax !== validSyntax || change) {
        appliedSyntax = validSyntax;
        effects.push(setSyntax.of(validSyntax));
      }
      if (change || effects.length) view.dispatch({ changes: change, effects, annotations: [remoteEdit.of(true), Transaction.addToHistory.of(false)] });
      sharedDocument = wanted;
      const revealKey = `${currentPath}:${revealLine ?? ""}`;
      if (revealKey !== lastReveal) {
        lastReveal = revealKey;
        if (revealLine !== undefined) {
          const position = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, Math.floor(revealLine)))).from;
          view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "center" }) });
        }
      }
      if (active && !wasActive) { view.requestMeasure(); reportCursor(); }
      wasActive = active;
    });
  });

  createEffect(() => {
    const proposal = props.proposal;
    if (proposal?.id !== proposalId) {
      proposalId = proposal?.id;
      setSelectedHunks(new Set(proposal?.hunks.map((hunk) => hunk.id) ?? []));
      setProposalChanged(false);
    }
  });

  createEffect(() => {
    const proposal = props.proposal;
    const selected = selectedHunks();
    const stale = proposalIsStale();
    const busy = props.proposalBusy ?? false;
    const generation = ++proposalGeneration;
    queueMicrotask(() => {
      if (!view || generation !== proposalGeneration) return;
      const ranges = !proposal || stale ? [] : proposal.hunks.map((hunk, index) => {
        const position = view!.state.doc.lineAt(Math.min(hunk.from, view!.state.doc.length)).from;
        return Decoration.widget({ widget: new ProposalWidget(hunk, index, selected.has(hunk.id), busy, toggleHunk), block: true, side: -1 }).range(position);
      });
      view.dispatch({ effects: setProposalDecorations.of(Decoration.set(ranges, true)) });
    });
  });

  onCleanup(() => { view?.destroy(); view = undefined; });
  return <div class="span-editor" classList={{ "is-active": props.active !== false }} data-theme={props.theme ?? "dark"} style={{ "--editor-font-size": `${props.fontSize ?? 13}px`, "--editor-line-height": `${Math.max(22, Math.round((props.fontSize ?? 13) * 22 / 13))}px`, "--editor-indent-size": `${props.tabSize ?? 2}ch` }}>
    <Show when={props.proposal}>{(proposal) => <div class="editor-proposal-review" role="region" aria-label="Review suggested changes">
      <div class="editor-proposal-summary"><strong>{proposalIsStale() ? "Proposal needs a fresh revision" : `${proposal().hunks.length} suggested ${proposal().hunks.length === 1 ? "change" : "changes"}`}</strong><span>{proposalIsStale() ? "This file changed. Reject this proposal and request a new one." : "Keep or skip each change, then apply your selection."}</span></div>
      <div class="editor-proposal-actions"><button type="button" class="proposal-reject" disabled={props.proposalBusy || !props.onRejectProposal} onClick={() => props.onRejectProposal?.(proposal().id)}>Reject proposal</button><button type="button" class="proposal-apply" disabled={props.proposalBusy || proposalIsStale() || selectedHunks().size === 0 || !props.onApplyProposal} onClick={() => props.onApplyProposal?.(proposal().id, [...selectedHunks()])}>{props.proposalBusy ? "Reviewing…" : `Apply selected (${selectedHunks().size})`}</button></div>
    </div>}</Show>
    <div class="span-editor-surface" ref={host} />
  </div>;
}

export { Editor };
