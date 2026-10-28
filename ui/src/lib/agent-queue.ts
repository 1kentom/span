/** Pure helpers for the queued-message list: reorder, drop targets, the clear confirmation and announcements. */

/** Clearing asks first only when more than this many messages would be lost. */
export const CLEAR_CONFIRM_ABOVE = 3;
export const needsClearConfirm = (count: number) => count > CLEAR_CONFIRM_ABOVE;

const inRange = (index: number, length: number) => Number.isInteger(index) && index >= 0 && index < length;

/** Moves one item to a new index. Returns the same array when nothing moves (same index or an index out of range). */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || !inRange(from, items.length) || !inRange(to, items.length)) return items as T[];
  const next = [...items];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

/**
 * The index the dragged row takes when released at pointer height `y`: the number of other rows whose midpoint is
 * above the pointer. `rects` are the row boxes measured when the drag began.
 */
export function dropIndex(rects: readonly { top: number; height: number }[], y: number, from: number): number {
  let slot = 0;
  rects.forEach((rect, index) => {
    if (index !== from && rect.top + rect.height / 2 < y) slot += 1;
  });
  return slot;
}

/** The row boundary (0 to length, in the order before the move) where the drop line is drawn, or none for a no-op. */
export function dropLine(from: number, to: number): number | undefined {
  if (from === to) return undefined;
  return to < from ? to : to + 1;
}

export const moveAnnouncement = (position: number, total: number) => `Moved to position ${position} of ${total}`;
