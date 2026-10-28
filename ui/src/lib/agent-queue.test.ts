import { describe, expect, it } from "vitest";
import { CLEAR_CONFIRM_ABOVE, dropIndex, dropLine, moveAnnouncement, moveItem, needsClearConfirm } from "./agent-queue";

describe("moveItem", () => {
  const base = ["a", "b", "c", "d"];
  it("moves an item up", () => expect(moveItem(base, 2, 1)).toEqual(["a", "c", "b", "d"]));
  it("moves an item down", () => expect(moveItem(base, 1, 2)).toEqual(["a", "c", "b", "d"]));
  it("moves to the ends", () => {
    expect(moveItem(base, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(base, 0, 3)).toEqual(["b", "c", "d", "a"]);
  });
  it("returns the same array for the same index", () => expect(moveItem(base, 2, 2)).toBe(base));
  it("returns the same array when an index is out of range", () => {
    expect(moveItem(base, -1, 1)).toBe(base);
    expect(moveItem(base, 4, 1)).toBe(base);
    expect(moveItem(base, 1, 4)).toBe(base);
    expect(moveItem(base, 1, -1)).toBe(base);
    expect(moveItem(base, 1.5, 2)).toBe(base);
  });
  it("never mutates its input", () => {
    const copy = [...base];
    moveItem(base, 0, 3);
    expect(base).toEqual(copy);
  });
});

describe("dropIndex", () => {
  const rects = [0, 30, 60, 90].map((top) => ({ top, height: 28 }));
  it("keeps the slot while the pointer stays near the dragged row", () => expect(dropIndex(rects, 44, 1)).toBe(1));
  it("moves down past the midpoints of the rows it crosses", () => {
    expect(dropIndex(rects, 80, 0)).toBe(2);
    expect(dropIndex(rects, 500, 0)).toBe(3);
  });
  it("moves up above the midpoints of the rows it crosses", () => {
    expect(dropIndex(rects, 5, 3)).toBe(0);
    expect(dropIndex(rects, -200, 2)).toBe(0);
  });
});

describe("dropLine", () => {
  it("draws nothing for a no-op", () => expect(dropLine(2, 2)).toBeUndefined());
  it("draws before the row that will follow the dropped one", () => {
    expect(dropLine(3, 1)).toBe(1);
    expect(dropLine(0, 2)).toBe(3);
    expect(dropLine(0, 3)).toBe(4);
  });
});

describe("clear confirmation and announcements", () => {
  it("asks only above three items", () => {
    expect(CLEAR_CONFIRM_ABOVE).toBe(3);
    expect([1, 2, 3, 4, 9].map(needsClearConfirm)).toEqual([false, false, false, true, true]);
  });
  it("announces the new position", () => expect(moveAnnouncement(2, 5)).toBe("Moved to position 2 of 5"));
});
