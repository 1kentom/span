/** Pure helpers for compact folder chains in the Explorer. No IO: they only read already loaded listings. */
export interface TreeEntry { name: string; path: string; isDir: boolean }
export interface ChainSegment { name: string; path: string }
export interface Chain {
  segments: ChainSegment[];
  /** Path of the deepest directory. It is the identity of the row. */
  deepest: string;
  label: string;
  separator: "/" | ".";
  /** True when the chain lives below a detected source root, so its names are package segments. */
  inSourceRoot: boolean;
  /** True when the head directory is itself a source root (always a single row). */
  isSourceRoot: boolean;
}

/** One place to add more source root conventions. A root is never merged with its parent or its children. */
export const SOURCE_ROOT_RULES: readonly RegExp[] = [
  /(^|\/)src\/[^/]+\/java$/,
  /(^|\/)src\/[^/]+\/kotlin$/,
];
export const MAX_CHAIN_DEPTH = 32;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const isSourceRoot = (path: string) => SOURCE_ROOT_RULES.some(rule => rule.test(path));
export function insideSourceRoot(path: string): boolean {
  const parts = path.split("/");
  for (let end = 1; end < parts.length; end++) if (isSourceRoot(parts.slice(0, end).join("/"))) return true;
  return false;
}

export function compactChain(path: string, directories: Readonly<Record<string, readonly TreeEntry[] | undefined>>, maxDepth = MAX_CHAIN_DEPTH): Chain {
  const segments: ChainSegment[] = [{ name: path.split("/").pop() || path, path }];
  const root = isSourceRoot(path);
  let current = path;
  while (!root && segments.length < maxDepth) {
    const listing = directories[current];
    if (!listing || listing.length !== 1 || !listing[0].isDir || isSourceRoot(listing[0].path)) break;
    segments.push({ name: listing[0].name, path: listing[0].path });
    current = listing[0].path;
  }
  const inRoot = !root && insideSourceRoot(path);
  const dotted = inRoot && segments.every(segment => IDENTIFIER.test(segment.name));
  const separator = dotted ? "." : "/";
  return { segments, deepest: current, label: segments.map(segment => segment.name).join(separator), separator, inSourceRoot: inRoot, isSourceRoot: root };
}
