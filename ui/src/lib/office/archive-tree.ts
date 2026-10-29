/** Archive tree model: flat entry paths to a sorted tree, unsafe entry detection, filter, selection and extract gating. */
import type { ArchiveEntry } from '../archive-api';

export interface ArchiveNode {
  id: string;
  name: string;
  /** Normalised path (forward slashes, no ./ prefix). Unsafe nodes keep the raw path. */
  path: string;
  dir: boolean;
  size: number;
  packed: number;
  modified?: number;
  children: ArchiveNode[];
  unsafe: boolean;
  /** A folder that has no entry of its own, created from its children's paths. */
  implicit: boolean;
  hidden: boolean;
  encrypted: boolean;
}
export interface ArchiveTree { root: ArchiveNode[]; unsafe: ArchiveEntry[]; files: number; folders: number; size: number; packed: number }

/** Entries that would land outside the destination: parent segments, absolute paths, drive letters, NUL. */
export function isUnsafePath(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  if (p.includes('\u0000') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return true;
  return p.split('/').some(segment => segment === '..');
}
/** Dot files and OS metadata (.DS_Store, __MACOSX, Thumbs.db). */
export function isHiddenEntry(path: string): boolean {
  return path.replace(/\\/g, '/').split('/').some(s => s === '__MACOSX' || (s.startsWith('.') && s !== '.' && s !== '..') || s === 'Thumbs.db' || s === 'desktop.ini');
}
const normalise = (path: string) => path.replace(/\\/g, '/').split('/').filter(s => s && s !== '.').join('/');
const compare = (a: ArchiveNode, b: ArchiveNode) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1);

export function buildArchiveTree(entries: readonly ArchiveEntry[]): ArchiveTree {
  const root: ArchiveNode[] = [];
  const unsafeNodes: ArchiveNode[] = [];
  const unsafe: ArchiveEntry[] = [];
  const dirs = new Map<string, ArchiveNode>();
  const makeNode = (id: string, name: string, path: string, dir: boolean, entry?: ArchiveEntry): ArchiveNode => ({
    id, name, path, dir, size: entry && !dir ? entry.size : 0, packed: entry && !dir ? entry.packed : 0, modified: entry?.modified,
    children: [], unsafe: false, implicit: !entry, hidden: isHiddenEntry(path), encrypted: !!entry?.encrypted,
  });
  const ensureDir = (path: string): ArchiveNode[] => {
    if (!path) return root;
    let node = dirs.get(path);
    if (!node) {
      const slash = path.lastIndexOf('/');
      node = makeNode(`d:${path}`, path.slice(slash + 1), path, true);
      dirs.set(path, node);
      ensureDir(slash < 0 ? '' : path.slice(0, slash)).push(node);
    }
    return node.children;
  };
  entries.forEach((entry, i) => {
    if (entry.unsafeReason || isUnsafePath(entry.path)) {
      unsafe.push(entry);
      unsafeNodes.push({ ...makeNode(`u:${i}`, entry.path, entry.path, entry.dir, entry), unsafe: true, implicit: false });
      return;
    }
    const path = normalise(entry.path);
    if (!path) return;
    if (entry.dir || /[\\/]$/.test(entry.path)) {
      ensureDir(path);
      const node = dirs.get(path)!;
      node.implicit = false;
      node.modified = entry.modified;
      return;
    }
    const slash = path.lastIndexOf('/');
    ensureDir(slash < 0 ? '' : path.slice(0, slash)).push(makeNode(`f:${i}`, path.slice(slash + 1), path, false, entry));
  });
  let files = 0, size = 0, packed = 0;
  const finish = (nodes: ArchiveNode[]): void => {
    nodes.sort(compare);
    for (const node of nodes) {
      if (!node.dir) { files++; size += node.size; packed += node.packed; continue; }
      finish(node.children);
      node.size = node.children.reduce((sum, c) => sum + c.size, 0);
      node.packed = node.children.reduce((sum, c) => sum + c.packed, 0);
    }
  };
  finish(root);
  root.push(...unsafeNodes);
  return { root, unsafe, files, folders: dirs.size, size, packed };
}

export interface ArchiveRow { node: ArchiveNode; depth: number; open: boolean }
export function visibleRows(root: readonly ArchiveNode[], open: ReadonlySet<string>, filter: string): ArchiveRow[] {
  const q = filter.trim().toLowerCase();
  const rows: ArchiveRow[] = [];
  const matches = new Map<ArchiveNode, boolean>();
  const hit = (node: ArchiveNode): boolean => {
    const known = matches.get(node);
    if (known !== undefined) return known;
    const value = node.name.toLowerCase().includes(q) || node.children.some(hit);
    matches.set(node, value);
    return value;
  };
  const walk = (nodes: readonly ArchiveNode[], depth: number): void => {
    for (const node of nodes) {
      if (q && !hit(node)) continue;
      const descendantHit = q && node.children.some(hit);
      const isOpen = node.dir && (open.has(node.id) || !!descendantHit);
      rows.push({ node, depth, open: isOpen });
      if (isOpen) walk(node.children, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}
export function allDirIds(root: readonly ArchiveNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: readonly ArchiveNode[]) => { for (const n of nodes) if (n.dir) { out.push(n.id); walk(n.children); } };
  walk(root);
  return out;
}

/** Safe files under a node (the node itself for a file). Unsafe entries are never selectable. */
export function filesUnder(node: ArchiveNode): ArchiveNode[] {
  if (node.unsafe) return [];
  if (!node.dir) return [node];
  return node.children.flatMap(filesUnder);
}
export function toggleSelection(selected: ReadonlySet<string>, node: ArchiveNode): Set<string> {
  const next = new Set(selected);
  const files = filesUnder(node);
  const allOn = files.length > 0 && files.every(f => selected.has(f.id));
  for (const f of files) if (allOn) next.delete(f.id); else next.add(f.id);
  return next;
}
export function checkState(node: ArchiveNode, selected: ReadonlySet<string>): 'on' | 'off' | 'mixed' {
  const files = filesUnder(node);
  const on = files.filter(f => selected.has(f.id)).length;
  return on === 0 ? 'off' : on === files.length ? 'on' : 'mixed';
}
export function selectedPaths(root: readonly ArchiveNode[], selected: ReadonlySet<string>): string[] {
  return root.flatMap(filesUnder).filter(f => selected.has(f.id)).map(f => f.path);
}

export interface ExtractGateInput { canExtract: boolean; safeFiles: number; selected: number; running: boolean }
export interface ExtractGate { all: boolean; selected: boolean; note?: string }
export function extractGate(input: ExtractGateInput): ExtractGate {
  if (!input.canExtract) return { all: false, selected: false, note: 'Extraction needs the desktop app. This preview lists and opens entries only.' };
  if (input.running) return { all: false, selected: false };
  if (input.safeFiles <= 0) return { all: false, selected: false, note: 'Nothing in this archive can be extracted safely.' };
  return { all: true, selected: input.selected > 0 };
}
