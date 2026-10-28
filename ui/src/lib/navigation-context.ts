import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { CapabilitiesDto } from "../bindings";
import type { NavigationPort, NavigationSession, PlannedEdit } from "./lsp-navigation";

export interface ServerInfo {
  /** Display name of the language server family, for messages. */
  label: string;
  /** Capabilities of the ready server, or undefined while it is not ready. */
  capabilities?: CapabilitiesDto;
  /** Why no capabilities are known, for example "starting". */
  state?: string;
}

/** What code navigation needs from the workbench. The App fills it in, tests replace it with a fixture. */
export interface NavigationContext {
  port: NavigationPort;
  session: NavigationSession;
  activePath(): string | undefined;
  workspaceRoot(): string | undefined;
  workspaceGeneration(): number;
  revision(path: string): number;
  /** Revision of every open buffer, to detect that a file moved while a rename was in flight. */
  revisions(): Record<string, number>;
  synchronized(path: string): boolean;
  epoch(path: string): number | undefined;
  server(path: string): ServerInfo | undefined;
  isReadOnly(path: string): boolean;
  isOpen(path: string): boolean;
  documentText(path: string): Text | undefined;
  /** Opens a workspace file at a 1-based line and column, exactly like every other jump in the app. */
  open(path: string, line?: number, column?: number): Promise<void> | void;
  /** Same as `open`, in the other editor group. */
  openToSide?(path: string, line?: number, column?: number): Promise<void> | void;
  /** Opens a workspace file as a buffer. False when it could not be opened. */
  openFile(path: string): Promise<boolean>;
  /** Applies edits through the normal buffer edit path, so they are undoable and leave the buffer dirty. */
  applyEdits(path: string, edits: readonly PlannedEdit[]): boolean;
  notify(message: string): void;
  revealBottomPanel(): void;
  openQuickOpen(initialQuery: string): void;
  /** Tells the app a read-only viewer is showing, so it can hide it again. */
  libraryChanged?(open: boolean): void;
}

let current: NavigationContext | undefined;
export const configureNavigationContext = (context: NavigationContext | undefined): void => { current = context; };
export const navigationContext = (): NavigationContext | undefined => current;

// --------------------------------------------------------------- editor views

const views = new Map<string, Set<EditorView>>();

export function registerEditorView(path: string, view: EditorView): () => void {
  const set = views.get(path) ?? new Set();
  set.add(view); views.set(path, set);
  return () => { set.delete(view); if (!set.size && views.get(path) === set) views.delete(path); };
}

/** The editor showing `path`. A focused view wins, then the last one mounted. Hidden views are skipped when a visible one exists. */
export function editorViewFor(path: string): EditorView | undefined {
  const set = views.get(path);
  if (!set) return undefined;
  const all = [...set];
  return all.find(view => view.hasFocus) ?? [...all].reverse().find(view => view.dom.offsetParent !== null) ?? all[all.length - 1];
}

export const focusEditor = (path = current?.activePath()): void => { if (path) editorViewFor(path)?.focus(); };

// --------------------------------------------------------------- back and forward

export interface Place { path: string; line: number; column: number }

const samePlace = (a: Place, b: Place) => a.path === b.path && a.line === b.line;

/** A jump history in the style of VS Code: leaving a place records it, back and forward walk the list. */
export function createJumpHistory(limit = 100) {
  let entries: Place[] = [];
  let index = 0;
  let live: Place | undefined;
  return {
    /** Remember the place being left, before a navigation command moves the caret. */
    record(from: Place | undefined): void {
      if (!from) return;
      entries = entries.slice(0, index);
      if (!entries.length || !samePlace(entries[entries.length - 1], from)) entries.push(from);
      if (entries.length > limit) entries.shift();
      index = entries.length; live = undefined;
    },
    back(here: Place | undefined): Place | undefined {
      if (index <= 0) return undefined;
      if (index === entries.length) live = here;
      index -= 1;
      return entries[index];
    },
    forward(): Place | undefined {
      if (index >= entries.length) return undefined;
      index += 1;
      return index === entries.length ? live : entries[index];
    },
    canGoBack: () => index > 0,
    canGoForward: () => index < entries.length && (index + 1 < entries.length || live !== undefined),
    clear(): void { entries = []; index = 0; live = undefined; },
    snapshot: () => ({ entries: [...entries], index }),
  };
}

export const jumpHistory = createJumpHistory();

export function currentPlace(): Place | undefined {
  const path = current?.activePath();
  const view = path ? editorViewFor(path) : undefined;
  if (!path || !view) return undefined;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  return { path, line: line.number, column: view.state.selection.main.head - line.from + 1 };
}
