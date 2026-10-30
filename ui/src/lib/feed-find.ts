/**
 * Find in thread: text matches in the rendered agent feed, and the route that sends the Find shortcut to the feed when
 * focus is in an agent panel instead of an editor. Collapsed tool output is not in the DOM, so it is not searched.
 */

/** Matches past this many are not collected: the count reads "1000+". */
export const MATCH_LIMIT = 1000;

/** Ranges of every case-insensitive occurrence of `query` in the text of `root`, in document order. */
export function findMatches(root: Node, query: string, limit = MATCH_LIMIT): Range[] {
  const needle = query.toLowerCase();
  if (!needle || typeof document === "undefined") return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest("[data-find-skip]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode() as Text | null; node && ranges.length < limit; node = walker.nextNode() as Text | null) {
    const haystack = node.data.toLowerCase();
    // Lower-casing can change the length of a few characters; such a node is matched as written.
    const text = haystack.length === node.data.length ? haystack : node.data;
    for (let at = text.indexOf(needle); at >= 0 && ranges.length < limit; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}

/** The index after `index` in a list of `count`, wrapping, or before it when `back`. */
export const stepIndex = (index: number, count: number, back = false) => (count ? (index + (back ? -1 : 1) + count) % count : -1);

/** The first match at or below `top` (the view's top edge), so a new search starts where the reader is. */
export function firstVisible(ranges: readonly Range[], top: number): number {
  const index = ranges.findIndex((range) => range.getBoundingClientRect().bottom > top);
  return index < 0 ? ranges.length - 1 : index;
}

/** "3 of 17", "No results", or "1000+" past the limit. */
export function countText(index: number, count: number, limit = MATCH_LIMIT): string {
  if (!count) return "No results";
  return `${index + 1} of ${count >= limit ? `${limit}+` : count}`;
}

const openers = new Map<Element, () => void>();

/** Lets the Find shortcut open this panel's find bar while focus is inside `scope`. Returns the cleanup. */
export function registerFeedFind(scope: Element, open: () => void): () => void {
  openers.set(scope, open);
  return () => {
    if (openers.get(scope) === open) openers.delete(scope);
  };
}

/** Opens the find bar of the agent panel that holds `active`. False when focus is elsewhere (an editor keeps Find). */
export function openFeedFind(active: Element | null): boolean {
  if (!active || active.closest(".cm-editor")) return false;
  for (const [scope, open] of openers) {
    if (scope.contains(active)) {
      open();
      return true;
    }
  }
  return false;
}
