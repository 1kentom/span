import type { Text } from "@codemirror/state";
import type {
  CallHierarchyItemDto_Deserialize, CallHierarchyItemDto_Serialize, DocumentHighlightDto, IncomingCallDto_Serialize, LocationDto,
  LspErrorDto, LspResponse, OutgoingCallDto_Serialize, PositionDto, PrepareRenameDto_Serialize, RangeDto, SourceSnippetDto,
  SymbolDto_Serialize, SymbolKindDto, TypeHierarchyItemDto_Deserialize, TypeHierarchyItemDto_Serialize, WorkspaceEditDto,
  WorkspaceSymbolDto_Serialize,
} from "../bindings";
import { describeLspError, isSilentLspError, normalizeLspError, positionToOffset, type LspOutcome } from "./lsp-client";

type Reply<T> = Promise<LspResponse<T>>;

/** The Tauri command boundary for code navigation. Browser preview and tests replace it with a labelled fixture. */
export interface NavigationPort {
  definition(path: string, position: PositionDto, requestId: string | null): Reply<LocationDto[]>;
  typeDefinition(path: string, position: PositionDto, requestId: string | null): Reply<LocationDto[]>;
  implementation(path: string, position: PositionDto, requestId: string | null): Reply<LocationDto[]>;
  declaration(path: string, position: PositionDto, requestId: string | null): Reply<LocationDto[]>;
  references(path: string, position: PositionDto, includeDeclaration: boolean, requestId: string | null): Reply<LocationDto[]>;
  documentSymbols(path: string, requestId: string | null): Reply<SymbolDto_Serialize[]>;
  workspaceSymbols(query: string, pathHint: string | null, requestId: string | null): Reply<WorkspaceSymbolDto_Serialize[]>;
  callPrepare(path: string, position: PositionDto, requestId: string | null): Reply<CallHierarchyItemDto_Serialize[]>;
  callIncoming(item: CallHierarchyItemDto_Deserialize, requestId: string | null): Reply<IncomingCallDto_Serialize[]>;
  callOutgoing(item: CallHierarchyItemDto_Deserialize, requestId: string | null): Reply<OutgoingCallDto_Serialize[]>;
  typePrepare(path: string, position: PositionDto, requestId: string | null): Reply<TypeHierarchyItemDto_Serialize[]>;
  typeSupertypes(item: TypeHierarchyItemDto_Deserialize, requestId: string | null): Reply<TypeHierarchyItemDto_Serialize[]>;
  typeSubtypes(item: TypeHierarchyItemDto_Deserialize, requestId: string | null): Reply<TypeHierarchyItemDto_Serialize[]>;
  highlights(path: string, position: PositionDto, requestId: string | null): Reply<DocumentHighlightDto[]>;
  prepareRename(path: string, position: PositionDto, requestId: string | null): Reply<PrepareRenameDto_Serialize | null>;
  rename(path: string, position: PositionDto, newName: string, requestId: string | null): Reply<WorkspaceEditDto>;
  readSource(location: LocationDto, contextLines: number): Promise<SourceSnippetDto>;
  cancel(requestId: string): Promise<unknown>;
}

export type NavigationRequestKey = string;

export interface NavigationSession {
  /** A newer call with the same key cancels the older one in the backend and makes its reply silent. Nothing here rejects. */
  run<T>(key: NavigationRequestKey, call: (requestId: string) => Promise<LspResponse<T>>): Promise<LspOutcome<T>>;
  /** Cancels one key without starting another request. */
  cancel(key: NavigationRequestKey): void;
  /** Cancels everything in flight. Later requests resolve silently. */
  dispose(): void;
}

let sequence = 0;
const nextRequestId = () => `nav-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
interface Flight { id: string; superseded: boolean }

/** Same stale, epoch and cancel rules as `createLspSession`, for the navigation request family. */
export function createNavigationSession(port: Pick<NavigationPort, "cancel">): NavigationSession {
  const inflight = new Map<string, Flight>();
  let disposed = false;
  const cancelBackend = (id: string) => { void Promise.resolve().then(() => port.cancel(id)).catch(() => undefined); };
  const supersede = (key: string) => {
    const previous = inflight.get(key);
    if (previous) { previous.superseded = true; cancelBackend(previous.id); inflight.delete(key); }
  };
  return {
    async run<T>(key: string, call: (requestId: string) => Promise<LspResponse<T>>): Promise<LspOutcome<T>> {
      if (disposed) return { kind: "silent" };
      supersede(key);
      const flight: Flight = { id: nextRequestId(), superseded: false };
      inflight.set(key, flight);
      try {
        const response = await call(flight.id);
        if (flight.superseded || disposed) return { kind: "silent" };
        return { kind: "ok", response };
      } catch (cause) {
        if (flight.superseded || disposed) return { kind: "silent" };
        const error: LspErrorDto = normalizeLspError(cause);
        return isSilentLspError(error) ? { kind: "silent" } : { kind: "error", error, message: describeLspError(error) };
      } finally {
        if (inflight.get(key) === flight) inflight.delete(key);
      }
    },
    cancel: supersede,
    dispose() {
      disposed = true;
      for (const flight of inflight.values()) { flight.superseded = true; cancelBackend(flight.id); }
      inflight.clear();
    },
  };
}

// ------------------------------------------------------------ capabilities

export type NavigationFeature =
  | "definition" | "typeDefinition" | "implementation" | "declaration" | "references" | "documentSymbol" | "workspaceSymbol"
  | "callHierarchy" | "typeHierarchy" | "rename" | "documentHighlight";

export const featureLabels: Readonly<Record<NavigationFeature, string>> = {
  definition: "Go to Definition", typeDefinition: "Go to Type Definition", implementation: "Go to Implementation", declaration: "Go to Declaration",
  references: "Find References", documentSymbol: "Document symbols", workspaceSymbol: "Workspace symbols", callHierarchy: "Call Hierarchy",
  typeHierarchy: "Type Hierarchy", rename: "Rename", documentHighlight: "Document highlights",
};

// ------------------------------------------------------------ positions

export const toPosition = (doc: Text, offset: number): PositionDto => {
  const clamped = Math.max(0, Math.min(doc.length, Math.floor(offset)));
  const line = doc.lineAt(clamped);
  return { line: line.number - 1, character: clamped - line.from };
};

export function comparePositions(a: PositionDto, b: PositionDto): number {
  return a.line - b.line || a.character - b.character;
}

export function rangeContains(range: RangeDto, position: PositionDto): boolean {
  return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) <= 0;
}

const wordCharacter = /[\p{L}\p{N}_$]/u;

/** The identifier around `offset`, or undefined when the caret is not on one. */
export function wordAt(doc: Text, offset: number): { from: number; to: number; text: string } | undefined {
  const line = doc.lineAt(Math.max(0, Math.min(doc.length, offset)));
  const text = line.text;
  let start = offset - line.from; let end = start;
  while (start > 0 && wordCharacter.test(text[start - 1])) start -= 1;
  while (end < text.length && wordCharacter.test(text[end])) end += 1;
  if (start === end) return undefined;
  return { from: line.from + start, to: line.from + end, text: text.slice(start, end) };
}

// ------------------------------------------------------------ symbols

export interface FlatSymbol {
  symbol: SymbolDto_Serialize;
  depth: number;
  /** Names of the enclosing symbols, outermost first. */
  container: string[];
}

export function flattenSymbols(symbols: readonly SymbolDto_Serialize[], depth = 0, container: string[] = []): FlatSymbol[] {
  return symbols.flatMap(symbol => [{ symbol, depth, container }, ...flattenSymbols(symbol.children, depth + 1, [...container, symbol.name])]);
}

export interface SymbolCrumb { symbol: SymbolDto_Serialize; siblings: readonly SymbolDto_Serialize[] }

/** The chain of symbols whose range holds `position`, outermost first, each with the siblings it can be swapped for. */
export function symbolPathAt(symbols: readonly SymbolDto_Serialize[], position: PositionDto): SymbolCrumb[] {
  const chain: SymbolCrumb[] = [];
  let level: readonly SymbolDto_Serialize[] = symbols;
  while (level.length) {
    const hit = level.find(symbol => rangeContains(symbol.range, position));
    if (!hit) break;
    chain.push({ symbol: hit, siblings: level });
    level = hit.children;
  }
  return chain;
}

const kindIcons: Readonly<Record<SymbolKindDto, string>> = {
  file: "DocumentText", module: "Element3", namespace: "Element3", package: "Element3",
  class: "symbol-class", struct: "symbol-class", object: "symbol-class", typeParameter: "symbol-class",
  interface: "symbol-interface", enum: "symbol-enum", enumMember: "symbol-constant", constant: "symbol-constant",
  method: "symbol-function", function: "symbol-function", constructor: "symbol-function", operator: "symbol-function", event: "flash",
  property: "symbol-property", field: "symbol-property", key: "symbol-property",
  variable: "symbol-variable", string: "symbol-variable", number: "symbol-variable", boolean: "symbol-variable", array: "symbol-variable", null: "symbol-variable",
};

/** Icon file (without extension) in `ui/public/icons` for a symbol kind. */
export const symbolKindIcon = (kind: SymbolKindDto): string => kindIcons[kind] ?? "symbol-variable";

export const symbolKindLabel = (kind: SymbolKindDto): string => kind === "enumMember" ? "enum member" : kind === "typeParameter" ? "type parameter" : kind;

export interface FuzzyMatch { score: number; indices: number[] }

/** Subsequence match, case insensitive. Consecutive runs, word starts and a prefix score higher. Undefined means no match. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return { score: 0, indices: [] };
  const haystack = text.toLowerCase();
  const exact = haystack.indexOf(needle);
  if (exact >= 0) return { score: 1000 - exact * 2 - (text.length - needle.length) * .01 + (exact === 0 ? 200 : 0), indices: Array.from({ length: needle.length }, (_, index) => exact + index) };
  const indices: number[] = []; let score = 0; let from = 0; let previous = -2;
  for (const character of needle) {
    const found = haystack.indexOf(character, from);
    if (found < 0) return undefined;
    const boundary = found === 0 || !/[a-z0-9]/i.test(text[found - 1]) || (text[found - 1] === text[found - 1].toLowerCase() && text[found] !== text[found].toLowerCase());
    score += 10 + (found === previous + 1 ? 15 : 0) + (boundary ? 12 : 0) - Math.min(8, found - from);
    indices.push(found); previous = found; from = found + 1;
  }
  return { score, indices };
}

// ------------------------------------------------------------ locations

export interface LocationGroup<T extends { location: LocationDto }> { key: string; displayPath: string; external: boolean; items: T[] }

export function groupByFile<T extends { location: LocationDto }>(items: readonly T[]): LocationGroup<T>[] {
  const groups = new Map<string, LocationGroup<T>>();
  for (const item of items) {
    const key = item.location.path;
    const group = groups.get(key) ?? { key, displayPath: item.location.displayPath || key, external: item.location.external, items: [] };
    group.items.push(item); groups.set(key, group);
  }
  return [...groups.values()].map(group => ({ ...group, items: group.items.sort((a, b) => comparePositions(a.location.range.start, b.location.range.start)) }));
}

export const sameLocation = (a: LocationDto, b: LocationDto) => a.path === b.path && comparePositions(a.range.start, b.range.start) === 0 && comparePositions(a.range.end, b.range.end) === 0;

export function dedupeLocations(locations: readonly LocationDto[]): LocationDto[] {
  const result: LocationDto[] = [];
  for (const location of locations) if (!result.some(existing => sameLocation(existing, location))) result.push(location);
  return result;
}

/** Text of one source line, trimmed for display, with the match range relative to the trimmed text. */
export function linePreview(lineText: string, startCharacter: number, endCharacter: number): { text: string; matchStart: number; matchEnd: number } {
  const lead = lineText.length - lineText.trimStart().length;
  const text = lineText.trim().slice(0, 240);
  const matchStart = Math.max(0, Math.min(text.length, startCharacter - lead));
  const matchEnd = Math.max(matchStart, Math.min(text.length, endCharacter - lead));
  return { text, matchStart, matchEnd };
}

// ------------------------------------------------------------ workspace edits

export interface PlannedEdit { from: number; to: number; insert: string }
export interface PlannedFile { path: string; edits: { range: RangeDto; newText: string }[] }
export type EditPlan = { ok: true; files: PlannedFile[]; occurrences: number } | { ok: false; message: string };

const outsideWorkspace = (path: string) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path) || path.split(/[\\/]/).includes("..") || /^[a-z][a-z0-9+.-]*:/i.test(path);

/** Refuses an edit that touches library files, paths outside the workspace or read-only buffers. Nothing is applied here. */
export function planWorkspaceEdit(edit: WorkspaceEditDto, isReadOnly: (path: string) => boolean): EditPlan {
  if (edit.skippedOperations > 0) return { ok: false, message: `Rename needs ${edit.skippedOperations} file operation${edit.skippedOperations === 1 ? "" : "s"} that Span does not apply. Nothing was changed.` };
  const files = edit.files.filter(file => file.edits.length);
  for (const file of files) {
    if (file.external) return { ok: false, message: `Rename would change a library file (${file.path}). Nothing was changed.` };
    if (outsideWorkspace(file.path)) return { ok: false, message: `Rename would change a file outside the workspace (${file.path}). Nothing was changed.` };
    if (isReadOnly(file.path)) return { ok: false, message: `Rename would change a read-only file (${file.path}). Nothing was changed.` };
  }
  if (!files.length) return { ok: false, message: "The language server returned no changes for this rename." };
  return { ok: true, files: files.map(file => ({ path: file.path, edits: file.edits })), occurrences: files.reduce((sum, file) => sum + file.edits.length, 0) };
}

/** Converts server edits to non-overlapping offsets in `doc`. Undefined when an edit overlaps another or leaves the document. */
export function editsToOffsets(doc: Text, edits: readonly { range: RangeDto; newText: string }[]): PlannedEdit[] | undefined {
  const rows: PlannedEdit[] = [];
  for (const edit of edits) {
    const { start, end } = edit.range;
    if (start.line >= doc.lines || end.line >= doc.lines || start.line < 0 || comparePositions(start, end) > 0) return undefined;
    rows.push({ from: positionToOffset(doc, start), to: positionToOffset(doc, end), insert: edit.newText });
  }
  rows.sort((a, b) => a.from - b.from || a.to - b.to);
  for (let index = 1; index < rows.length; index += 1) if (rows[index].from < rows[index - 1].to) return undefined;
  return rows;
}

export const pluralize = (count: number, singular: string, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;

export const fileLabel = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
export const directoryLabel = (path: string): string => path.split(/[\\/]/).filter(Boolean).slice(0, -1).join("/");
