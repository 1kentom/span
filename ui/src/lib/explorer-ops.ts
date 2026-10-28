import type { FileEntry } from "../bindings";
import { normalizePath, parentPath } from "./navigation";

/** Name validation for the Explorer's inline editor, modelled on the design reference (VS Code rules plus Windows rules). */
export type NameCheck =
  | { level: "error"; msg: string }
  | { level: "warn" | null; msg: string; segs: string[]; trailingSlash: boolean; last: string; newDirs: string[] };

const BAD = /[<>:"|?*\\\x00-\x1f]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
export const join = (folder: string, name: string) => folder ? `${folder}/${name}` : name;

export function validateName(raw: string, parent: string, listing: (folder: string) => readonly FileEntry[] | undefined, selfPath?: string): NameCheck {
  const value = raw.replace(/\t/g, "");
  if (!value.trim()) return { level: "error", msg: "A file or folder name must be provided." };
  if (/^[/\\]/.test(value)) return { level: "error", msg: "A file or folder name cannot start with a slash." };
  const trailingSlash = /\/+$/.test(value);
  const segs = value.replace(/\/+$/, "").split("/");
  for (const segment of segs) {
    if (segment === "") return { level: "error", msg: "A name cannot contain two slashes in a row." };
    if (segment === "." || segment === "..") return { level: "error", msg: `The name '${segment}' is not valid as a file or folder name. Please choose a different name.` };
    const bad = BAD.exec(segment);
    if (bad) return { level: "error", msg: `The name '${segment}' is not valid as a file or folder name. Remove ${bad[0] < " " ? "a control character" : `'${bad[0]}'`}.` };
    if (RESERVED.test(segment.trim())) return { level: "error", msg: `'${segment.trim()}' is a reserved name on Windows. Please choose a different name.` };
    if (segment.length > 255) return { level: "error", msg: "Names can be at most 255 characters long." };
  }
  let current = parent; const newDirs: string[] = [];
  for (let index = 0; index < segs.length - 1; index++) {
    const siblings = listing(current);
    const hit = siblings?.find(entry => entry.name.toLowerCase() === segs[index].toLowerCase());
    if (hit && !hit.isDir) return { level: "error", msg: `'${segs[index]}' is a file, so it cannot contain other items.` };
    if (!hit) newDirs.push(segs[index]);
    current = join(current, hit?.name ?? segs[index]);
  }
  const last = segs[segs.length - 1];
  const clash = listing(current)?.find(entry => entry.name.toLowerCase() === last.toLowerCase());
  if (clash && join(current, clash.name) !== selfPath) return { level: "error", msg: `A file or folder '${clash.name}' already exists at this location. Please choose a different name.` };
  let level: "warn" | null = null; let msg = "";
  if (segs.some(segment => segment !== segment.trim())) { level = "warn"; msg = "Leading or trailing whitespace detected in file or folder name."; }
  else if (segs.some(segment => segment.endsWith("."))) { level = "warn"; msg = "Names that end with a period do not work on Windows."; }
  return { level, msg, segs, trailingSlash, last, newDirs };
}

/** End of the pre-selected part of a name in the rename editor: stops before `.d.ts`, `.test.ts`, `.min.js` style suffixes. */
export function renameSelectionEnd(name: string, directory: boolean): number {
  if (directory) return name.length;
  const compound = /(\.d\.ts|\.(test|spec)\.[cm]?[jt]sx?|\.min\.js|\.js\.map)$/i.exec(name);
  if (compound && compound.index > 0) return compound.index;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

/** `a.ts` becomes `a copy.ts`, then `a copy 2.ts`. */
export function copyName(name: string, directory: boolean, taken: (candidate: string) => boolean): string {
  let current = name;
  do {
    let stem = current; let ext = "";
    if (!directory) { const dot = current.lastIndexOf("."); if (dot > 0) { stem = current.slice(0, dot); ext = current.slice(dot); } }
    const match = /^(.*) copy(?: (\d+))?$/.exec(stem);
    current = (match ? `${match[1]} copy ${(match[2] ? Number(match[2]) : 1) + 1}` : `${stem} copy`) + ext;
  } while (taken(current));
  return current;
}

/** Folder that receives a new item: the selected folder, the folder of the selected file, or the folder of the active file. */
export function creationFolder(selection: readonly string[], isDirectory: (path: string) => boolean, activePath?: string): string {
  const first = selection[0];
  if (first !== undefined) return isDirectory(first) ? first : parentPath(first);
  return activePath ? parentPath(activePath) : "";
}

/** A move is refused into itself, into its own descendant, or onto the folder it already sits in. */
export function moveRefusal(source: string, folder: string): string | undefined {
  const from = normalizePath(source); const to = normalizePath(folder);
  if (from === to || to.startsWith(`${from}/`)) return "A folder cannot be moved inside itself.";
  if (parentPath(from) === to) return "That item is already in this folder.";
  return undefined;
}

/** Drop the sources that already travel with a selected ancestor. */
export function topLevelPaths(paths: readonly string[]): string[] {
  return paths.filter(path => !paths.some(other => other !== path && path.startsWith(`${other}/`)));
}

/** Range of visible rows between two paths, inclusive. */
export function rangeBetween(visible: readonly string[], a: string, b: string): string[] {
  const from = visible.indexOf(a); const to = visible.indexOf(b);
  if (from < 0 || to < 0) return [b];
  return visible.slice(Math.min(from, to), Math.max(from, to) + 1);
}
