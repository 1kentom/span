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

export type FileQuery = { filter: string; suffix: string; line?: number; column?: number; invalidPosition?: boolean };

/** Real colon-containing paths take priority over an ambiguous position suffix. */
export function parseFileQuery(query: string, files: readonly FileEntry[] = [], root?: string): FileQuery {
  const value = query.trim();
  const normalized = relativePath(value, root).toLowerCase();
  const filePaths = files.filter(file => !file.isDir).map(file => relativePath(file.path, root).toLowerCase());
  if (!value || /^[a-z]:$/i.test(value) || filePaths.some(path => path.includes(normalized))) return { filter: value, suffix: "" };
  const candidates = [/^(.*):([0-9]+):([0-9]*)$/, /^(.*):([0-9]*)$/].flatMap(pattern => {
    const match = value.match(pattern);
    if (!match || (/^[a-z]$/i.test(match[1]) && value[1] === ":" && !match[2])) return [];
    const [, filter, rawLine, rawColumn] = match;
    const line = rawLine ? Number(rawLine) : undefined;
    const column = rawColumn ? Number(rawColumn) : undefined;
    return [{ filter, suffix: value.slice(filter.length), line, column, invalidPosition: [line, column].some(number => number !== undefined && (!Number.isSafeInteger(number) || number < 1)) }];
  });
  return candidates.find(candidate => filePaths.some(path => path === relativePath(candidate.filter, root).toLowerCase() || fileName(path) === candidate.filter.toLowerCase())) || candidates[0] || { filter: value, suffix: "" };
}

export function fileResults(files: FileEntry[], query: string, recent: readonly string[] = [], root?: string): FileEntry[] {
  const parsed = parseFileQuery(query, files, root);
  if (parsed.invalidPosition) return [];
  const term = relativePath(parsed.filter, root).toLowerCase();
  const candidates = files.filter(file => !file.isDir && (!term || relativePath(file.path, root).toLowerCase().includes(term)));
  if (!term && recent.length) {
    const order = new Map(recent.map((path, index) => [normalizePath(path), index]));
    candidates.sort((a, b) => (order.get(normalizePath(a.path)) ?? Infinity) - (order.get(normalizePath(b.path)) ?? Infinity));
  }
  return candidates.slice(0, 100);
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
