import type { FileEntry, Workspace } from "../bindings";

export const normalizePath = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");
export const fileName = (path: string): string => normalizePath(path).split("/").pop() || path;
export const parentPath = (path: string): string => normalizePath(path).split("/").slice(0, -1).join("/");
const absolute = (path: string) => /^(?:\/|[A-Za-z]:\/)/.test(path);

/** Paths passed to workspace commands are relative to the actual workspace root. */
export function relativePath(path: string, root?: string): string {
  const normalized = normalizePath(path);
  if (!root || !absolute(normalized)) return normalized;
  const base = normalizePath(root);
  const windows = /^[A-Za-z]:\//.test(base) || base.startsWith("//");
  const compare = (value: string) => windows ? value.toLowerCase() : value;
  if (compare(normalized) === compare(base)) return "";
  return compare(normalized).startsWith(`${compare(base)}/`) ? normalized.slice(base.length + 1) : normalized;
}

export function absolutePath(path: string, root?: string): string {
  const normalized = normalizePath(path);
  if (absolute(normalized) || !root) return path;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${normalized ? separator + normalized.replace(/\//g, separator) : ""}`;
}

export type Breadcrumb = { name: string; path: string; directory: boolean };
export function pathBreadcrumbs(path: string, workspace?: Workspace | null): Breadcrumb[] {
  const relative = relativePath(path, workspace?.root);
  const parts = relative.split("/").filter(Boolean);
  return [
    ...workspace ? [{ name: workspace.name, path: "", directory: true }] : [],
    ...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/"), directory: index < parts.length - 1 })),
  ];
}

export function fileResults(files: FileEntry[], query: string, recent: readonly string[] = []): FileEntry[] {
  const term = query.replace(/:\d+$/, "").trim().toLowerCase();
  const candidates = files.filter(file => !file.isDir && (!term || normalizePath(file.path).toLowerCase().includes(term)));
  if (!term && recent.length) {
    const order = new Map(recent.map((path, index) => [normalizePath(path), index]));
    candidates.sort((a, b) => (order.get(normalizePath(a.path)) ?? Infinity) - (order.get(normalizePath(b.path)) ?? Infinity));
  }
  return candidates.slice(0, 80);
}

export function contextMenuPosition(event: MouseEvent | KeyboardEvent): { x: number; y: number } {
  if (event instanceof MouseEvent && (event.clientX || event.clientY)) return { x: event.clientX, y: event.clientY };
  const bounds = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
  return { x: bounds?.left ?? 8, y: bounds?.bottom ?? 8 };
}
export function isContextMenuKey(event: KeyboardEvent): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

export function clampMenu(x: number, y: number, width: number, height: number, viewportWidth = window.innerWidth, viewportHeight = window.innerHeight) {
  return { x: Math.max(8, Math.min(x, viewportWidth - width - 8)), y: Math.max(8, Math.min(y, viewportHeight - height - 8)) };
}
