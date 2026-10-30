// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { countText, findMatches, firstVisible, openFeedFind, registerFeedFind, stepIndex } from "./feed-find";

afterEach(() => document.body.replaceChildren());

describe("findMatches", () => {
  it("finds every case-insensitive occurrence across text nodes, in document order", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>Build failed. <b>build</b> again</p><pre>BUILD ok, rebuild</pre>";
    const ranges = findMatches(root, "build");
    expect(ranges.map((range) => range.toString())).toEqual(["Build", "build", "BUILD", "build"]);
    expect(findMatches(root, "")).toEqual([]);
    expect(findMatches(root, "missing")).toEqual([]);
  });

  it("skips the find bar itself and stops at the limit", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p>${"aa ".repeat(10)}</p><div data-find-skip><input value="aa"><span>aa</span></div>`;
    expect(findMatches(root, "aa")).toHaveLength(10);
    expect(findMatches(root, "aa", 4)).toHaveLength(4);
  });
});

describe("find helpers", () => {
  it("steps forward and back with wrap-around", () => {
    expect(stepIndex(2, 3)).toBe(0);
    expect(stepIndex(0, 3, true)).toBe(2);
    expect(stepIndex(-1, 0)).toBe(-1);
  });

  it("counts like an editor find", () => {
    expect(countText(2, 17)).toBe("3 of 17");
    expect(countText(-1, 0)).toBe("No results");
    expect(countText(0, 1000)).toBe("1 of 1000+");
  });

  it("starts at the first match below the view top", () => {
    const at = (bottom: number) => ({ getBoundingClientRect: () => ({ bottom }) }) as unknown as Range;
    expect(firstVisible([at(-50), at(-1), at(30), at(400)], 0)).toBe(2);
    expect(firstVisible([at(-50), at(-10)], 0)).toBe(1);
  });
});

describe("openFeedFind", () => {
  it("opens the find bar of the panel holding focus, never from an editor", () => {
    const panel = document.createElement("section");
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const input = document.createElement("textarea");
    const inner = document.createElement("div");
    editor.append(inner);
    panel.append(input, editor);
    const outside = document.createElement("button");
    document.body.append(panel, outside);
    const open = vi.fn();
    const unregister = registerFeedFind(panel, open);
    expect(openFeedFind(input)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(openFeedFind(inner)).toBe(false);
    expect(openFeedFind(outside)).toBe(false);
    expect(openFeedFind(null)).toBe(false);
    unregister();
    expect(openFeedFind(input)).toBe(false);
  });
});
