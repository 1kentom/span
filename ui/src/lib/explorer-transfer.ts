import { commands } from "../bindings";
import { droppedPathInfo, droppedRelative, pointInside, type DropPoint, type DroppedPath } from "./native-drop";
import { copyName } from "./explorer-ops";
import { fileName, parentPath } from "./navigation";

/**
 * Copying files into the Explorer from outside Span: a native drop from Finder or Explorer, or files on the OS
 * clipboard. Rust copies only paths it recorded from the latest drop or clipboard read (see
 * apps/desktop/src/file_import.rs); the frontend only chooses the folder and the clash policy.
 */
export type ImportItems = Parameters<typeof commands.importPaths>[1];
export type ConflictPolicy = ImportItems[number]["policy"];
export type ImportReport = Awaited<ReturnType<typeof commands.importPaths>>;
export type ImportProgress = NonNullable<Awaited<ReturnType<typeof commands.importProgress>>>;
export type ClipboardContents = Awaited<ReturnType<typeof commands.clipboardFiles>>;
export type PastedKind = Parameters<typeof commands.pasteClipboardFile>[1];

/** Desktop commands the Explorer uses for transfers. Tests pass a fake. */
export type ExplorerTransfer = {
  pathInfo(path: string): Promise<DroppedPath>;
  importPaths(target: string, items: ImportItems): Promise<ImportReport>;
  progress(): Promise<ImportProgress | null>;
  cancel(): Promise<void>;
  readClipboard(): Promise<ClipboardContents>;
  writeClipboard(paths: string[]): Promise<void>;
  pasteFile(path: string, kind: PastedKind): Promise<{ path: string }>;
};

export const desktopTransfer: ExplorerTransfer = {
  pathInfo: droppedPathInfo,
  importPaths: (target, items) => commands.importPaths(target, items),
  progress: () => commands.importProgress(),
  cancel: () => commands.cancelImport(),
  readClipboard: () => commands.clipboardFiles(),
  writeClipboard: paths => commands.setClipboardFiles(paths).then(() => undefined),
  pasteFile: (path, kind) => commands.pasteClipboardFile(path, kind),
};

/**
 * Folder a native drop at `point` (CSS pixels) copies into: the folder row under the pointer, the folder of a
 * file row, or the project root anywhere else on the Files view. Undefined outside the Explorer or without a tree.
 */
export function explorerDropFolder(point: DropPoint, isDirectory: (path: string) => boolean, doc: Document = document): string | undefined {
  const panel = doc.querySelector(".explorer-panel");
  if (!panel || !pointInside(panel, point) || !panel.querySelector(".file-tree")) return undefined;
  const row = doc.elementFromPoint(point.x, point.y)?.closest<HTMLElement>('.file-tree [role="treeitem"]');
  if (!row) return "";
  const path = row.dataset.path ?? "";
  return isDirectory(path) ? path : parentPath(path);
}

/** "Copied 3 items to src/", with what was skipped, replaced or stopped. */
export function importSummary(report: ImportReport, folder: string): string {
  const count = report.created.length;
  const what = count === 1 ? fileName(report.created[0]) : `${count} items`;
  const parts = [count ? `Copied ${what} to ${folder ? `${folder}/` : "the project root"}` : "Nothing was copied"];
  if (report.replaced.length) parts.push(`${report.replaced.length} replaced (the old ${report.replaced.length === 1 ? "item is" : "items are"} in the Trash)`);
  if (report.skipped.length) parts.push(`${report.skipped.length} skipped`);
  if (report.skippedLinks) parts.push(`${report.skippedLinks} ${report.skippedLinks === 1 ? "link" : "links"} not copied`);
  if (report.cancelled) parts.push("cancelled");
  return parts.join(", ");
}

/** Default name for clipboard content pasted as a new file, never one that exists. */
export function pastedName(kind: PastedKind, taken: (name: string) => boolean): string {
  const name = kind === "image" ? "Pasted image.png" : "Pasted text.txt";
  return taken(name) ? copyName(name, false, taken) : name;
}

/** True when the OS clipboard still holds exactly the workspace items Span itself put there. */
export function sameEntries(files: readonly DroppedPath[], root: string | undefined, paths: readonly string[]): boolean {
  if (!files.length || files.length !== paths.length) return false;
  const relative = new Set(files.map(file => droppedRelative(root, file.path)));
  return paths.every(path => relative.has(path));
}
