import { batch, createRoot, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type {
  CallHierarchyItemDto_Serialize, CapabilitiesDto, LocationDto, PositionDto, RangeDto, SymbolDto_Serialize, TypeHierarchyItemDto_Serialize,
} from "../bindings";
import { replyIsCurrent, awaitSynchronized } from "../lib/lsp-codemirror";
import {
  createNavigationSession, dedupeLocations, editsToOffsets, featureLabels, flattenSymbols, groupByFile, linePreview, planWorkspaceEdit,
  pluralize, symbolPathAt, toPosition, wordAt, comparePositions, fileLabel, type NavigationFeature, type SymbolCrumb,
} from "../lib/lsp-navigation";
import { closePeek, openPeek, setExternalLocationOpener } from "../lib/lsp-peek";
import {
  configureNavigationContext, currentPlace, editorViewFor, focusEditor, jumpHistory, navigationContext, type NavigationContext, type Place,
} from "../lib/navigation-context";
import { NAVIGATION_UNAVAILABLE_MESSAGE, registerNavigationHandler, type NavigationActionId } from "../lib/navigation-actions";

export type BottomTab = "terminal" | "references" | "hierarchy";

/** All navigation state lives in one root so it is shared between the editor extensions and the panels. */
const state = createRoot(() => {
  const [bottomTab, setBottomTab] = createSignal<BottomTab>("terminal");
  const [toast, setToast] = createSignal<{ id: number; message: string } | undefined>();
  const [rename, setRename] = createSignal<RenameState | undefined>();
  const [caret, setCaret] = createSignal<PositionDto | undefined>();
  const [symbolState, setSymbolState] = createSignal<{ path: string; revision: number; symbols: SymbolDto_Serialize[] } | undefined>();
  const [references, setReferences] = createStore<ReferencesState>({ status: "idle", symbol: "", error: "", groups: [], count: 0 });
  const [hierarchy, setHierarchy] = createStore<HierarchyState>({ kind: "call", direction: "incoming", status: "idle", error: "", roots: [], title: "" });
  const [library, setLibrary] = createStore<{ docs: LibraryDoc[]; active: string | undefined }>({ docs: [], active: undefined });
  return { bottomTab, setBottomTab, toast, setToast, rename, setRename, caret, setCaret, symbolState, setSymbolState, references, setReferences, hierarchy, setHierarchy, library, setLibrary };
});

export interface RenameState { path: string; from: number; to: number; original: string; position: PositionDto; left: number; top: number; busy: boolean; error: string }
export interface RefItem { id: string; location: LocationDto; line: number; text?: string; matchStart?: number; matchEnd?: number }
export interface RefGroup { key: string; displayPath: string; external: boolean; collapsed: boolean; items: RefItem[] }
export interface ReferencesState { status: "idle" | "loading" | "ready" | "error"; symbol: string; error: string; groups: RefGroup[]; count: number; origin?: { path: string; position: PositionDto } }
export type HierarchyItem = CallHierarchyItemDto_Serialize | TypeHierarchyItemDto_Serialize;
export interface HNode { id: string; item: HierarchyItem; ranges: RangeDto[]; expanded: boolean; status: "idle" | "loading" | "done" | "error"; error: string; children: HNode[] }
export interface HierarchyState {
  kind: "call" | "type"; direction: "incoming" | "outgoing" | "supertypes" | "subtypes"; status: "idle" | "loading" | "ready" | "error"; error: string;
  roots: HNode[]; title: string; origin?: { path: string; position: PositionDto };
}
export interface LibraryDoc { id: string; location: LocationDto; title: string; status: "loading" | "ready" | "error"; text: string; startLine: number; language: string; error: string }

export const navigationState = {
  bottomTab: state.bottomTab, setBottomTab: state.setBottomTab, toast: state.toast, rename: state.rename,
  references: state.references, hierarchy: state.hierarchy, library: state.library,
};

// ------------------------------------------------------------ setup

let stopHandlers: (() => void) | undefined;

/** Connects the workbench. Returns a function that disconnects it and removes the handlers. */
export function configureNavigation(context: Omit<NavigationContext, "session"> & { session?: NavigationContext["session"] }): () => void {
  const session = context.session ?? createNavigationSession(context.port);
  const full: NavigationContext = { ...context, session };
  configureNavigationContext(full);
  setExternalLocationOpener(location => { void openLibrary(location); });
  stopHandlers?.();
  const off = registerHandlers();
  stopHandlers = () => { off(); session.dispose(); configureNavigationContext(undefined); setExternalLocationOpener(undefined); resetNavigationState(); stopHandlers = undefined; };
  return stopHandlers;
}

export function resetNavigationState(): void {
  batch(() => {
    state.setRename(undefined); state.setToast(undefined); state.setSymbolState(undefined);
    state.setReferences({ status: "idle", symbol: "", error: "", groups: [], count: 0, origin: undefined });
    state.setHierarchy({ kind: "call", direction: "incoming", status: "idle", error: "", roots: [], title: "", origin: undefined });
    state.setLibrary({ docs: [], active: undefined });
    state.setBottomTab("terminal");
  });
  jumpHistory.clear();
}

/** The workspace or the active tab changed: nothing in flight may land on the new context. */
export function dropTransientNavigation(): void {
  const ctx = navigationContext();
  for (const key of ["goto", "references-peek", "rename", "prepareRename", "pick-symbols", "pick-workspace"]) ctx?.session.cancel(key);
  state.setRename(undefined);
}

export function dropWorkspaceNavigation(): void {
  resetNavigationState();
  forgetDocumentSymbols();
}

// ------------------------------------------------------------ helpers

interface Target { ctx: NavigationContext; path: string; view: NonNullable<ReturnType<typeof editorViewFor>>; offset: number; caps: CapabilitiesDto; label: string }

function unavailable(ctx: NavigationContext, path: string | undefined, feature?: NavigationFeature): void {
  const info = path ? ctx.server(path) : undefined;
  if (!info) { ctx.notify(NAVIGATION_UNAVAILABLE_MESSAGE); return; }
  if (!info.capabilities) { ctx.notify(`${NAVIGATION_UNAVAILABLE_MESSAGE}: ${info.label} is ${info.state ?? "not ready"}.`); return; }
  ctx.notify(`${NAVIGATION_UNAVAILABLE_MESSAGE}: ${info.label} does not support ${feature ? featureLabels[feature] : "this command"}.`);
}

/** Reads the active editor and checks the capability. Shows the not-available message itself when it cannot proceed. */
function begin(feature: NavigationFeature): Target | undefined {
  const ctx = navigationContext();
  if (!ctx) return undefined;
  const path = ctx.activePath();
  const view = path ? editorViewFor(path) : undefined;
  if (!path || !view) { ctx.notify(NAVIGATION_UNAVAILABLE_MESSAGE); return undefined; }
  const info = ctx.server(path);
  if (!info?.capabilities?.[feature]) { unavailable(ctx, path, feature); return undefined; }
  return { ctx, path, view, offset: view.state.selection.main.head, caps: info.capabilities, label: info.label };
}

/** One editor bound request: waits for the buffer to sync, then drops the reply when the document, tab, server or workspace moved. */
async function request<T>(target: Target, key: string, call: (id: string) => Promise<import("../bindings").LspResponse<T>>): Promise<T | undefined> {
  const { ctx, path, view } = target;
  const doc = view.state.doc; const epoch = ctx.epoch(path); const generation = ctx.workspaceGeneration();
  if (!await awaitSynchronized({ isSynchronized: () => ctx.synchronized(path) }, () => ctx.activePath() !== path)) { ctx.notify("The file is still saving changes to the language server. Try again."); return undefined; }
  const outcome = await ctx.session.run(key, call);
  if (outcome.kind === "silent") return undefined;
  if (outcome.kind === "error") { ctx.notify(outcome.message); return undefined; }
  const binding = { isActive: () => ctx.activePath() === path, getRevision: () => ctx.revision(path), getEpoch: () => ctx.epoch(path), getWorkspaceGeneration: ctx.workspaceGeneration };
  if (!replyIsCurrent(binding, { doc, epoch, generation }, view.state.doc, outcome.response)) return undefined;
  return outcome.response.data;
}

const caretCoordinates = (target: Target, offset = target.offset) => {
  const box = target.view.coordsAtPos(offset);
  const rect = target.view.dom.getBoundingClientRect();
  return { left: box?.left ?? rect.left + 40, top: box?.bottom ?? rect.top + 40 };
};

const lineColumn = (location: LocationDto) => [location.range.start.line + 1, location.range.start.character + 1] as const;

// ------------------------------------------------------------ opening places

export async function openLocation(location: LocationDto, options: { record?: boolean } = {}): Promise<void> {
  const ctx = navigationContext();
  if (!ctx) return;
  if (location.external) { await openLibrary(location); return; }
  if (options.record !== false) jumpHistory.record(currentPlace());
  const [line, column] = lineColumn(location);
  await ctx.open(location.path, line, column);
}

async function jumpToPlace(place: Place | undefined): Promise<void> {
  const ctx = navigationContext();
  if (!ctx || !place) return;
  await ctx.open(place.path, place.line, place.column);
}

// ------------------------------------------------------------ go to and peek

type GotoFeature = "definition" | "typeDefinition" | "implementation";
const gotoNames: Record<GotoFeature, string> = { definition: "definition", typeDefinition: "type definition", implementation: "implementation" };

async function gotoLocations(feature: GotoFeature, peek: boolean): Promise<void> {
  const target = begin(feature);
  if (!target) return;
  const { path, view } = target; const position = toPosition(view.state.doc, target.offset);
  const data = await request(target, "goto", id => target.ctx.port[feature](path, position, id));
  if (!data) return;
  const locations = dedupeLocations(data);
  if (!locations.length) { target.ctx.notify(`No ${gotoNames[feature]} found.`); return; }
  presentLocations(target, locations, peek, `${gotoNames[feature]} (${locations.length})`);
}

/** One result navigates straight there. Several open as a peek list, like VS Code's default for `editor.gotoLocation.multiple`. */
function presentLocations(target: Target, locations: LocationDto[], peek: boolean, title: string): void {
  if (!peek && locations.length === 1) { void openLocation(locations[0]); return; }
  openPeek(target.view, locations, title);
}

/** Loads the line text of each location, one read per file, with a small concurrency. Never throws. */
async function fillPreviews(locations: readonly LocationDto[], apply: (location: LocationDto, preview: { text: string; matchStart: number; matchEnd: number }) => void): Promise<void> {
  const ctx = navigationContext();
  if (!ctx) return;
  const byFile = new Map<string, LocationDto[]>();
  for (const location of locations) byFile.set(location.path, [...byFile.get(location.path) ?? [], location]);
  const queue = [...byFile.values()];
  const worker = async () => {
    for (let group = queue.shift(); group; group = queue.shift()) {
      try {
        const open = group[0].external ? undefined : ctx.documentText(group[0].path);
        let rowOf: (line: number) => string | undefined;
        if (open) rowOf = line => line < open.lines ? open.line(line + 1).text : undefined;
        else {
          const first = Math.min(...group.map(item => item.range.start.line)); const last = Math.max(...group.map(item => item.range.end.line));
          const snippet = await ctx.port.readSource({ ...group[0], range: { start: { line: first, character: 0 }, end: { line: last, character: 0 } } }, 0);
          const rows = snippet.text.split("\n");
          rowOf = line => rows[line - snippet.startLine];
        }
        for (const location of group) {
          const row = rowOf(location.range.start.line);
          if (row !== undefined) apply(location, linePreview(row, location.range.start.character, location.range.end.line === location.range.start.line ? location.range.end.character : row.length));
        }
      } catch { /* a missing preview leaves the row without text */ }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

// ------------------------------------------------------------ references

function symbolNameAt(target: Target): string {
  return wordAt(target.view.state.doc, target.offset)?.text ?? "symbol";
}

async function runReferences(path: string, position: PositionDto, symbol: string, target: Target): Promise<void> {
  state.setReferences({ status: "loading", symbol, error: "", groups: [], count: 0, origin: { path, position } });
  state.setBottomTab("references"); target.ctx.revealBottomPanel();
  const data = await request(target, "references", id => target.ctx.port.references(path, position, true, id));
  if (!data) {
    if (state.references.status === "loading") state.setReferences({ status: "error", error: "The language server did not return references. Try again.", groups: [], count: 0 });
    return;
  }
  const locations = dedupeLocations(data);
  const groups = groupByFile(locations.map((location, index) => ({ id: `${index}`, location, line: location.range.start.line + 1 }))).map((group): RefGroup => ({ key: group.key, displayPath: group.displayPath, external: group.external, collapsed: false, items: group.items }));
  state.setReferences({ status: "ready", error: "", groups, count: locations.length });
  void fillPreviews(locations, (location, preview) => {
    state.setReferences(produce(draft => {
      for (const group of draft.groups) for (const item of group.items) if (item.location.path === location.path && comparePositions(item.location.range.start, location.range.start) === 0) { item.text = preview.text; item.matchStart = preview.matchStart; item.matchEnd = preview.matchEnd; }
    }));
  });
}

export async function findReferences(): Promise<void> {
  const target = begin("references");
  if (!target) return;
  await runReferences(target.path, toPosition(target.view.state.doc, target.offset), symbolNameAt(target), target);
}

export async function refreshReferences(): Promise<void> {
  const origin = state.references.origin;
  const ctx = navigationContext();
  const view = origin ? editorViewFor(origin.path) : undefined;
  if (!origin || !ctx || !view) { ctx?.notify("Open the file again to refresh the references."); return; }
  const target = begin("references");
  if (!target || target.path !== origin.path) { ctx.notify("Switch back to the file the references were found in to refresh them."); return; }
  await runReferences(origin.path, origin.position, state.references.symbol, target);
}

async function peekReferences(): Promise<void> {
  const target = begin("references");
  if (!target) return;
  const position = toPosition(target.view.state.doc, target.offset);
  const data = await request(target, "references-peek", id => target.ctx.port.references(target.path, position, true, id));
  if (!data) return;
  const locations = dedupeLocations(data);
  if (!locations.length) { target.ctx.notify("No references found."); return; }
  openPeek(target.view, locations, `references (${locations.length})`);
}

export function toggleReferenceGroup(key: string): void {
  state.setReferences(produce(draft => { const group = draft.groups.find(item => item.key === key); if (group) group.collapsed = !group.collapsed; }));
}
export function setReferencesCollapsed(collapsed: boolean): void {
  state.setReferences(produce(draft => { for (const group of draft.groups) group.collapsed = collapsed; }));
}

// ------------------------------------------------------------ hierarchies

let nodeSequence = 0;
const makeNode = (item: HierarchyItem, ranges: RangeDto[] = []): HNode => ({ id: `h${++nodeSequence}`, item, ranges, expanded: false, status: "idle", error: "", children: [] });

function findNode(nodes: HNode[], id: string): HNode | undefined {
  for (const node of nodes) { if (node.id === id) return node; const child = findNode(node.children, id); if (child) return child; }
  return undefined;
}

async function showHierarchy(kind: "call" | "type"): Promise<void> {
  const target = begin(kind === "call" ? "callHierarchy" : "typeHierarchy");
  if (!target) return;
  const { ctx, path, view } = target; const position = toPosition(view.state.doc, target.offset);
  const direction = kind === "call" ? "incoming" : "supertypes";
  state.setHierarchy({ kind, direction, status: "loading", error: "", roots: [], title: symbolNameAt(target), origin: { path, position } });
  state.setBottomTab("hierarchy"); ctx.revealBottomPanel();
  const items = await request<HierarchyItem[]>(target, "hierarchy-prepare", id => kind === "call" ? ctx.port.callPrepare(path, position, id) : ctx.port.typePrepare(path, position, id));
  if (!items) { if (state.hierarchy.status === "loading") state.setHierarchy({ status: "error", error: "The language server did not answer. Try again." }); return; }
  const roots = items.map(item => makeNode(item));
  state.setHierarchy({ status: "ready", roots, title: items[0]?.name ?? state.hierarchy.title });
  if (roots[0]) void expandNode(roots[0].id, true);
}

export function setHierarchyDirection(direction: HierarchyState["direction"]): void {
  if (state.hierarchy.direction === direction) return;
  const roots = state.hierarchy.roots.map(root => makeNode(root.item));
  state.setHierarchy({ direction, roots });
  if (roots[0]) void expandNode(roots[0].id, true);
}

async function fetchChildren(node: HNode): Promise<HNode[]> {
  const ctx = navigationContext();
  if (!ctx) return [];
  const { kind, direction } = state.hierarchy; const generation = ctx.workspaceGeneration();
  const item = node.item;
  const key = `hier:${node.id}`;
  const response = await ctx.session.run(key, id => {
    if (kind === "call") return (direction === "incoming" ? ctx.port.callIncoming(item as CallHierarchyItemDto_Serialize, id) : ctx.port.callOutgoing(item as CallHierarchyItemDto_Serialize, id)) as Promise<import("../bindings").LspResponse<unknown>>;
    return (direction === "supertypes" ? ctx.port.typeSupertypes(item as TypeHierarchyItemDto_Serialize, id) : ctx.port.typeSubtypes(item as TypeHierarchyItemDto_Serialize, id)) as Promise<import("../bindings").LspResponse<unknown>>;
  });
  if (response.kind === "silent") throw Object.assign(new Error("superseded"), { silent: true });
  if (response.kind === "error") throw new Error(response.message);
  if (ctx.workspaceGeneration() !== generation) throw Object.assign(new Error("superseded"), { silent: true });
  const data = response.response.data as unknown[];
  if (kind === "type") return (data as TypeHierarchyItemDto_Serialize[]).map(entry => makeNode(entry));
  if (direction === "incoming") return (data as { from: CallHierarchyItemDto_Serialize; fromRanges: RangeDto[] }[]).map(entry => makeNode(entry.from, entry.fromRanges));
  return (data as { to: CallHierarchyItemDto_Serialize; fromRanges: RangeDto[] }[]).map(entry => makeNode(entry.to, entry.fromRanges));
}

/** Lazy expansion: children are requested once, using the opaque token carried by the item. */
export async function expandNode(id: string, force = false): Promise<void> {
  const node = findNode(state.hierarchy.roots, id);
  if (!node) return;
  if (node.status === "done" || node.status === "loading") { if (!force || node.status === "loading") { state.setHierarchy(produce(draft => { const entry = findNode(draft.roots, id); if (entry) entry.expanded = !entry.expanded || force; })); return; } }
  state.setHierarchy(produce(draft => { const entry = findNode(draft.roots, id); if (entry) { entry.expanded = true; entry.status = "loading"; entry.error = ""; } }));
  try {
    const children = await fetchChildren(node);
    state.setHierarchy(produce(draft => { const entry = findNode(draft.roots, id); if (entry) { entry.children = children; entry.status = "done"; } }));
  } catch (error) {
    if ((error as { silent?: boolean }).silent) return;
    state.setHierarchy(produce(draft => { const entry = findNode(draft.roots, id); if (entry) { entry.status = "error"; entry.error = error instanceof Error ? error.message : String(error); } }));
  }
}

export function collapseNode(id: string): void {
  state.setHierarchy(produce(draft => { const entry = findNode(draft.roots, id); if (entry) entry.expanded = false; }));
}

export function openHierarchyItem(item: HierarchyItem): void {
  const [line, column] = [item.selectionRange.start.line + 1, item.selectionRange.start.character + 1];
  void openLocation({ ...item.location, range: { start: { line: line - 1, character: column - 1 }, end: item.selectionRange.end } });
}

// ------------------------------------------------------------ rename

async function startRename(): Promise<void> {
  const target = begin("rename");
  if (!target) return;
  const { ctx, path, view } = target; const doc = view.state.doc;
  const word = wordAt(doc, target.offset);
  const position = toPosition(doc, target.offset);
  if (ctx.isReadOnly(path)) { ctx.notify("This file is read-only, so it cannot be renamed."); return; }
  let from = word?.from ?? target.offset; let to = word?.to ?? target.offset; let original = word?.text ?? "";
  if (target.caps.prepareRename) {
    const prepared = await request(target, "prepareRename", id => ctx.port.prepareRename(path, position, id));
    if (prepared === undefined) return;
    if (prepared === null) { ctx.notify("This element cannot be renamed."); return; }
    if (prepared.range) {
      const start = view.state.doc.line(Math.min(view.state.doc.lines, prepared.range.start.line + 1)); const end = view.state.doc.line(Math.min(view.state.doc.lines, prepared.range.end.line + 1));
      from = start.from + Math.min(start.length, prepared.range.start.character); to = end.from + Math.min(end.length, prepared.range.end.character);
    }
    original = prepared.placeholder ?? view.state.doc.sliceString(from, to);
  }
  if (!original) { ctx.notify("Place the caret on a symbol to rename it."); return; }
  const { left, top } = caretCoordinates(target, from);
  state.setRename({ path, from, to, original, position: toPosition(view.state.doc, from), left, top, busy: false, error: "" });
}

export function cancelRename(): void {
  const current = state.rename();
  navigationContext()?.session.cancel("rename");
  state.setRename(undefined);
  if (current) focusEditor(current.path);
}

export async function commitRename(newName: string): Promise<void> {
  const current = state.rename(); const ctx = navigationContext();
  if (!current || !ctx || current.busy) return;
  const name = newName.trim();
  if (!name) { state.setRename({ ...current, error: "Enter a new name." }); return; }
  if (name === current.original) { cancelRename(); return; }
  const target = begin("rename");
  if (!target || target.path !== current.path) { state.setRename(undefined); return; }
  state.setRename({ ...current, busy: true, error: "" });
  const before = ctx.revisions();
  const data = await request(target, "rename", id => ctx.port.rename(current.path, current.position, name, id));
  const live = state.rename();
  if (!live || live.path !== current.path) return;
  if (!data) { state.setRename({ ...live, busy: false, error: "Rename did not finish. Nothing was changed." }); return; }
  const refuse = (message: string) => { state.setRename(undefined); ctx.notify(message); focusEditor(current.path); };
  const plan = planWorkspaceEdit(data, path => ctx.isReadOnly(path));
  if (!plan.ok) { refuse(plan.message); return; }
  for (const file of plan.files) if (ctx.isOpen(file.path) && before[file.path] !== undefined && ctx.revision(file.path) !== before[file.path]) { refuse(`${file.path} changed while renaming. Nothing was changed.`); return; }
  const opened: string[] = [];
  for (const file of plan.files) {
    if (ctx.isOpen(file.path)) continue;
    if (!await ctx.openFile(file.path)) { refuse(`Could not open ${file.path} to rename in it. Nothing was changed.`); return; }
    opened.push(file.path);
  }
  const resolved: { path: string; offsets: NonNullable<ReturnType<typeof editsToOffsets>> }[] = [];
  for (const file of plan.files) {
    const doc = ctx.documentText(file.path); const offsets = doc ? editsToOffsets(doc, file.edits) : undefined;
    if (!offsets) { refuse(`The edits for ${file.path} no longer match the file. Nothing was changed.`); return; }
    resolved.push({ path: file.path, offsets });
  }
  if (ctx.activePath() !== current.path && !opened.length) { refuse("The active file changed while renaming. Nothing was changed."); return; }
  for (const file of resolved) if (!ctx.applyEdits(file.path, file.offsets)) { refuse(`Could not apply the rename to ${file.path}. Some files may have changed, check the undo history.`); return; }
  state.setRename(undefined);
  const place = { path: current.path, line: current.position.line + 1, column: current.position.character + 1 };
  if (ctx.activePath() !== current.path) await ctx.open(place.path, place.line, place.column); else focusEditor(current.path);
  showToast(`Renamed ${pluralize(plan.occurrences, "occurrence")} in ${pluralize(plan.files.length, "file")}. The files are unsaved, save them to keep the change.`);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let toastId = 0;
export function showToast(message: string): void {
  clearTimeout(toastTimer);
  const id = ++toastId;
  state.setToast({ id, message });
  toastTimer = setTimeout(() => { if (state.toast()?.id === id) state.setToast(undefined); }, 7000);
}
export const dismissToast = (): void => { clearTimeout(toastTimer); state.setToast(undefined); };

// ------------------------------------------------------------ library sources

let libraryGeneration = 0;
export async function openLibrary(location: LocationDto): Promise<void> {
  const ctx = navigationContext();
  if (!ctx) return;
  const id = `${location.path}`;
  jumpHistory.record(currentPlace());
  const existing = state.library.docs.find(doc => doc.id === id);
  if (existing) { state.setLibrary({ active: id }); ctx.libraryChanged?.(true); return; }
  const doc: LibraryDoc = { id, location, title: location.displayPath || location.path, status: "loading", text: "", startLine: 0, language: "text", error: "" };
  state.setLibrary({ docs: [...state.library.docs, doc], active: id });
  ctx.libraryChanged?.(true);
  const generation = libraryGeneration;
  try {
    // Library files are read through the backend and never become buffers or reach a language server.
    const snippet = await ctx.port.readSource(location, 100000);
    if (generation !== libraryGeneration) return;
    state.setLibrary("docs", item => item.id === id, { status: "ready", text: snippet.text, startLine: snippet.startLine, language: snippet.language, title: snippet.displayPath || doc.title });
  } catch (error) {
    if (generation === libraryGeneration) state.setLibrary("docs", item => item.id === id, { status: "error", error: error instanceof Error ? error.message : String(error) });
  }
}

export function closeLibrary(id: string): void {
  const docs = state.library.docs.filter(doc => doc.id !== id);
  const active = state.library.active === id ? docs[docs.length - 1]?.id : state.library.active;
  state.setLibrary({ docs, active });
  if (!docs.length) { navigationContext()?.libraryChanged?.(false); focusEditor(); }
}
export const selectLibrary = (id: string): void => { state.setLibrary({ active: id }); };

// ------------------------------------------------------------ symbols: breadcrumbs and quick picks

let symbolTimer: ReturnType<typeof setTimeout> | undefined;
const symbolCache = new Map<string, { revision: number; symbols: SymbolDto_Serialize[] }>();

/** Document symbols of the active file, cached per revision and refreshed shortly after edits. */
export function refreshDocumentSymbols(immediate = false): void {
  clearTimeout(symbolTimer);
  const ctx = navigationContext();
  const path = ctx?.activePath();
  if (!ctx || !path) { state.setSymbolState(undefined); return; }
  const revision = ctx.revision(path);
  const cached = symbolCache.get(path);
  if (cached && cached.revision === revision) { state.setSymbolState({ path, revision, symbols: cached.symbols }); return; }
  if (!ctx.server(path)?.capabilities?.documentSymbol) { state.setSymbolState(undefined); return; }
  symbolTimer = setTimeout(async () => {
    try {
      if (ctx.activePath() !== path || !ctx.synchronized(path)) return;
      const generation = ctx.workspaceGeneration();
      const outcome = await ctx.session.run(`breadcrumb:${path}`, id => ctx.port.documentSymbols(path, id));
      if (outcome.kind !== "ok" || ctx.workspaceGeneration() !== generation || ctx.activePath() !== path || ctx.revision(path) !== outcome.response.revision) return;
      symbolCache.set(path, { revision: outcome.response.revision, symbols: outcome.response.data });
      state.setSymbolState({ path, revision: outcome.response.revision, symbols: outcome.response.data });
    } catch { /* breadcrumbs stay as they were */ }
  }, immediate ? 0 : 350);
}

export function forgetDocumentSymbols(path?: string): void { if (path) symbolCache.delete(path); else symbolCache.clear(); }
export const setCaretPosition = (position: PositionDto | undefined): void => { state.setCaret(position); };

/** The symbol path of the caret in the active file, or an empty list while symbols are unknown or unsupported. */
export function symbolCrumbs(): SymbolCrumb[] {
  const symbols = state.symbolState(); const caret = state.caret(); const path = navigationContext()?.activePath();
  if (!symbols || !caret || symbols.path !== path) return [];
  return symbolPathAt(symbols.symbols, caret);
}

export function openSymbol(symbol: SymbolDto_Serialize, path = navigationContext()?.activePath()): void {
  const ctx = navigationContext();
  if (!ctx || !path) return;
  jumpHistory.record(currentPlace());
  void ctx.open(path, symbol.selectionRange.start.line + 1, symbol.selectionRange.start.character + 1);
}

export interface SymbolItem {
  id: string; name: string; kind: import("../bindings").SymbolKindDto; container: string; depth: number;
  path: string; line: number; column: number; location?: LocationDto;
}
export interface SymbolPick { items: SymbolItem[]; message?: string }
export interface SymbolSource {
  fileSymbols(): Promise<SymbolPick>;
  workspaceSymbols(query: string): Promise<SymbolPick>;
  open(item: SymbolItem): void;
}

export function createSymbolSource(): SymbolSource | undefined {
  if (!navigationContext()) return undefined;
  return {
    async fileSymbols() {
      const ctx = navigationContext(); const path = ctx?.activePath();
      if (!ctx || !path) return { items: [], message: "Open a file to list its symbols" };
      const info = ctx.server(path);
      if (!info?.capabilities?.documentSymbol) return { items: [], message: info ? `${info.label} does not provide document symbols for this file` : NAVIGATION_UNAVAILABLE_MESSAGE };
      const generation = ctx.workspaceGeneration();
      const outcome = await ctx.session.run("pick-symbols", id => ctx.port.documentSymbols(path, id));
      if (outcome.kind === "silent" || ctx.workspaceGeneration() !== generation) return { items: [] };
      if (outcome.kind === "error") return { items: [], message: outcome.message };
      return { items: flattenSymbols(outcome.response.data).map(({ symbol, depth, container }, index): SymbolItem => ({ id: `${index}:${symbol.name}`, name: symbol.name, kind: symbol.kind, container: container.join("."), depth, path, line: symbol.selectionRange.start.line + 1, column: symbol.selectionRange.start.character + 1 })) };
    },
    async workspaceSymbols(query) {
      const ctx = navigationContext(); const path = ctx?.activePath();
      if (!ctx) return { items: [] };
      const info = path ? ctx.server(path) : undefined;
      if (!path || !info?.capabilities?.workspaceSymbol) return { items: [], message: info ? `${info.label} does not provide workspace symbols` : "Open a file handled by a language server to search workspace symbols" };
      const generation = ctx.workspaceGeneration();
      const outcome = await ctx.session.run("pick-workspace", id => ctx.port.workspaceSymbols(query, path, id));
      if (outcome.kind === "silent" || ctx.workspaceGeneration() !== generation) return { items: [] };
      if (outcome.kind === "error") return { items: [], message: outcome.message };
      return { items: outcome.response.data.map((symbol, index): SymbolItem => ({ id: `${index}:${symbol.location.path}:${symbol.name}`, name: symbol.name, kind: symbol.kind, container: symbol.containerName ?? "", depth: 0, path: symbol.location.path, line: symbol.location.range.start.line + 1, column: symbol.location.range.start.character + 1, location: symbol.location })) };
    },
    open(item) {
      if (item.location?.external) { void openLibrary(item.location); return; }
      jumpHistory.record(currentPlace());
      void navigationContext()?.open(item.path, item.line, item.column);
    },
  };
}

// ------------------------------------------------------------ history

export async function goBack(): Promise<void> {
  const place = jumpHistory.back(currentPlace());
  if (!place) { navigationContext()?.notify("There is nowhere to go back to."); return; }
  await jumpToPlace(place);
}
export async function goForward(): Promise<void> {
  const place = jumpHistory.forward();
  if (!place) { navigationContext()?.notify("There is nowhere to go forward to."); return; }
  await jumpToPlace(place);
}

// ------------------------------------------------------------ handlers

function openSymbolPicker(prefix: "@" | "#"): void {
  const ctx = navigationContext();
  if (!ctx) return;
  const path = ctx.activePath();
  const info = path ? ctx.server(path) : undefined;
  const feature: NavigationFeature = prefix === "@" ? "documentSymbol" : "workspaceSymbol";
  if (!path || !info?.capabilities?.[feature]) { unavailable(ctx, path, feature); return; }
  ctx.openQuickOpen(prefix);
}

function peekOf(feature: GotoFeature | "references") {
  return () => feature === "references" ? peekReferences() : gotoLocations(feature, true);
}

const handlers: Record<Exclude<NavigationActionId, "quickInfo">, () => void | Promise<void>> = {
  goToDefinition: () => gotoLocations("definition", false),
  goToTypeDefinition: () => gotoLocations("typeDefinition", false),
  goToImplementation: () => gotoLocations("implementation", false),
  peekDefinition: peekOf("definition"),
  peekTypeDefinition: peekOf("typeDefinition"),
  peekImplementation: peekOf("implementation"),
  findReferences: () => findReferences(),
  peekReferences: peekOf("references"),
  goToSymbolInFile: () => openSymbolPicker("@"),
  goToSymbolInWorkspace: () => openSymbolPicker("#"),
  showCallHierarchy: () => showHierarchy("call"),
  showTypeHierarchy: () => showHierarchy("type"),
  renameSymbol: () => startRename(),
  goBack: () => goBack(),
  goForward: () => goForward(),
};

/** Replaces the "not available" placeholder of every navigation action with its real implementation. */
function registerHandlers(): () => void {
  const offs = (Object.entries(handlers) as [Exclude<NavigationActionId, "quickInfo">, () => void | Promise<void>][]).map(([id, run]) =>
    registerNavigationHandler(id, async () => { try { await run(); } catch (error) { navigationContext()?.notify(`Navigation failed: ${error instanceof Error ? error.message : String(error)}`); } }));
  return () => offs.forEach(off => off());
}

export { closePeek, fileLabel };
