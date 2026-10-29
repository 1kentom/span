import { getCurrentWebview } from "@tauri-apps/api/webview";
import { commands, type DroppedPath } from "../bindings";
import { workspaceRelative } from "./agent-view";

/**
 * Native (OS) file drops. Span keeps Tauri's native drag-drop handler enabled (see docs/internal-dragging.md), so
 * files dragged from Finder or Explorer never reach HTML `dragover`/`drop` listeners: the webview receives Tauri
 * drag-drop events instead, with physical pixel positions. The Rust side only records the dropped paths; the
 * frontend decides by position what a drop means (attach on the agent panel, open in the editor).
 */
export type DropPoint = { x: number; y: number };
export type NativeDrop = { kind: "hover"; point: DropPoint } | { kind: "leave" } | { kind: "drop"; point: DropPoint; paths: string[] };
export type { DroppedPath };

/** Tauri reports physical pixels; layout boxes are CSS pixels. `scale` is `window.devicePixelRatio`. */
export function physicalToLogical(position: { x: number; y: number }, scale: number): DropPoint {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return { x: position.x / factor, y: position.y / factor };
}

/** True when a CSS pixel point lies inside a visible element's box (a hidden panel has an empty box). */
export function pointInside(element: Element | null | undefined, point: DropPoint): boolean {
  if (!element) return false;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
}

/** The agent panel element, when it is shown. */
export const agentPanelElement = (doc: Document = document) => doc.querySelector(".agent-panel");

/**
 * Target of one of Span's own pointer drags (editor tab, Explorer row): the agent panel wins over the editor
 * under it, so a tab released on the panel attaches instead of moving.
 */
export function internalDropTarget<K>(x: number, y: number, overAgent: (x: number, y: number) => boolean, editor: (x: number, y: number) => K | undefined): K | "agent" | undefined {
  return overAgent(x, y) ? "agent" : editor(x, y);
}

/** Listens to the webview's native drag-drop events. Resolves to the unlisten function. */
export async function listenNativeDrops(handler: (drop: NativeDrop) => void, scale: () => number = () => window.devicePixelRatio || 1): Promise<() => void> {
  return getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "leave") handler({ kind: "leave" });
    else if (payload.type === "drop") handler({ kind: "drop", paths: payload.paths, point: physicalToLogical(payload.position, scale()) });
    else handler({ kind: "hover", point: physicalToLogical(payload.position, scale()) });
  });
}

/** Windows canonical paths carry a verbatim prefix (`\\?\C:\...`) that a workspace root may not. */
const plainPath = (path: string) => path.replace(/^\\\\\?\\(?!UNC\\)/, "");
/** Path of a dropped item relative to the open project, or undefined when it is outside (or is the root). */
export const droppedRelative = (root: string | undefined, path: string) => (root ? workspaceRelative(plainPath(root), plainPath(path)) : undefined);

/** Kind, name and size of one path of the latest native drop. Rust refuses any other path. */
export const droppedPathInfo = (path: string): Promise<DroppedPath> => commands.droppedPathInfo(path);

/** Bytes of one file of the latest native drop, refused by Rust above `maxBytes` or for any other path. */
export async function readDroppedFile(path: string, maxBytes: number): Promise<Uint8Array> {
  const encoded = await commands.readDroppedFile(path, Math.max(0, Math.min(maxBytes, 0xffffffff)));
  return Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
}

export type EditorDropPlan = {
  /** Workspace relative files to open in the editor. */
  open: string[];
  /** Files that are not inside the open project. They are never opened by switching projects. */
  outside: DroppedPath[];
  /** A lone folder, offered as a project through the usual unsaved changes guard. */
  folder?: string;
  /** Why some folders were not used. */
  refused?: string;
};

/**
 * What a native drop on the editor area does. A dropped file opens only that file, and only when it is inside the
 * open project: it never switches the project to the file's folder. A single folder dropped on its own may open as
 * the project (the caller routes it through the same guard as Open Folder).
 */
export function planEditorDrop(items: readonly DroppedPath[], root: string | undefined): EditorDropPlan {
  const folders = items.filter((item) => item.isDir);
  const files = items.filter((item) => !item.isDir);
  const open: string[] = [];
  const outside: DroppedPath[] = [];
  for (const file of files) {
    const relative = droppedRelative(root, file.path);
    if (relative) open.push(relative);
    else outside.push(file);
  }
  if (folders.length === 1 && !files.length) return { open, outside, folder: folders[0].path };
  return { open, outside, refused: folders.length ? "Drop a folder on its own to open it as a project." : undefined };
}

/** The notice for files a drop could not open. */
export function outsideNotice(outside: readonly DroppedPath[], root: string | undefined): string | undefined {
  if (!outside.length) return undefined;
  const names = outside.length === 1 ? outside[0].name : `${outside[0].name} and ${outside.length - 1} more`;
  return root
    ? `${names}: outside the open folder, so it was not opened. Span does not switch projects for a dropped file. Drop it on the AI panel to attach it.`
    : `${names}: no folder is open, so it was not opened. Open a folder first, or drop it on the AI panel to attach it.`;
}
