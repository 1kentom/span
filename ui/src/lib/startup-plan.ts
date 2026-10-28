import type { StartupFile_Serialize as StartupFile } from "../bindings";
import { normalizePath, parentPath, relativePath } from "./navigation";

type Request = { workspaceRoot: string | null; files: StartupFile[]; impliedRoot?: boolean };
export type StartupPlan = {
  /** Folder to switch the window to, when the request changes project. */
  switchTo?: string;
  /** Files to open in the (possibly new) project. */
  open: StartupFile[];
  /** Files outside the open project that need the user's decision. */
  outside: StartupFile[];
};

const isAbsolute = (path: string) => /^(?:\/|[A-Za-z]:\/)/.test(path);
const windowsLike = (path: string) => /^[A-Za-z]:\//.test(path) || path.startsWith("//");

export function isInside(path: string, root: string): boolean {
  const normalized = normalizePath(path);
  return !isAbsolute(relativePath(normalized, root));
}

/** Deepest folder that holds every file. */
export function commonFolder(files: readonly StartupFile[]): string | undefined {
  if (!files.length) return undefined;
  let root = parentPath(files[0].path);
  for (const file of files) {
    const fold = (value: string) => windowsLike(root) ? normalizePath(value).toLowerCase() : normalizePath(value);
    while (root && !fold(file.path).startsWith(`${fold(root)}/`)) root = parentPath(root);
  }
  return root || undefined;
}

/**
 * Decide what a startup request does. A request that only names files (the folder was derived from them)
 * never swaps an open project: files inside it open there, files outside ask first. With no project open,
 * the files' folder becomes the project and only the files are opened.
 */
export function planStartup(request: Request, openRoot?: string): StartupPlan {
  const root = request.workspaceRoot ?? undefined;
  if (!request.impliedRoot) {
    const changing = !!root && (!openRoot || relativePath(root, openRoot) !== "");
    return { switchTo: changing ? root : undefined, open: request.files, outside: [] };
  }
  if (!openRoot) return { switchTo: root, open: request.files, outside: [] };
  const open = request.files.filter(file => isInside(file.path, openRoot));
  return { open, outside: request.files.filter(file => !isInside(file.path, openRoot)) };
}
