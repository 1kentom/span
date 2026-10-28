import type { EditorGroup } from "./workbench";

export type TabEviction = { path: string; group: number };

/** Plan clean least-recently-used file-tab removals without mutating the workbench. */
export function planTabEvictions(
  groups: readonly EditorGroup[],
  limit: number,
  perGroup: boolean,
  mostRecentFirst: readonly string[],
  isDirty: (path: string) => boolean,
  protectedPaths: ReadonlySet<string> = new Set(),
): TabEviction[] {
  const order = [...new Set(mostRecentFirst)];
  const known = new Set(groups.flatMap(group => group.tabs));
  for (const path of known) if (!order.includes(path)) order.push(path);
  const recency = new Map(order.map((path, index) => [path, index]));
  const copies = groups.map(group => ({ id: group.id, tabs: [...new Set(group.tabs)], active: group.active }));
  const removals: TabEviction[] = [];

  if (perGroup) {
    for (const group of copies) {
      const candidates = [...group.tabs]
        .filter(path => path !== group.active && !protectedPaths.has(path) && !isDirty(path))
        .sort((a, b) => (recency.get(b) ?? -1) - (recency.get(a) ?? -1));
      while (group.tabs.length > limit && candidates.length) {
        const path = candidates.shift()!;
        group.tabs.splice(group.tabs.indexOf(path), 1);
        removals.push({ path, group: group.id });
      }
    }
    return removals;
  }

  const active = new Set(copies.map(group => group.active).filter((path): path is string => !!path));
  const count = () => new Set(copies.flatMap(group => group.tabs)).size;
  const candidates = [...known]
    .filter(path => !active.has(path) && !protectedPaths.has(path) && !isDirty(path))
    .sort((a, b) => (recency.get(b) ?? -1) - (recency.get(a) ?? -1));
  while (count() > limit && candidates.length) {
    const path = candidates.shift()!;
    const owners = copies.filter(group => group.tabs.includes(path));
    for (const group of owners) {
      group.tabs.splice(group.tabs.indexOf(path), 1);
      removals.push({ path, group: group.id });
    }
  }
  return removals;
}
