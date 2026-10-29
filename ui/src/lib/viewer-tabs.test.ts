import { describe, expect, it } from "vitest";
import { isViewerTab, viewerTabId, viewerTabName, viewerTabPath } from "./viewer-tabs";

describe("viewer tab paths", () => {
  it("round trips the attachment id and name", () => {
    const path = viewerTabPath("att-1", "shot.png");
    expect(isViewerTab(path)).toBe(true);
    expect(viewerTabId(path)).toBe("att-1");
    expect(viewerTabName(path)).toBe("shot.png");
  });
  it("keeps names with separators and spaces intact", () => {
    const path = viewerTabPath("a/b c", "notes/2026 draft.md");
    expect(viewerTabId(path)).toBe("a/b c");
    expect(viewerTabName(path)).toBe("notes/2026 draft.md");
  });
  it("never matches workspace files or the settings tab", () => {
    for (const path of ["src/a.ts", "span:settings", "settings://user", "span-viewer.ts"]) {
      expect(isViewerTab(path)).toBe(false);
      expect(viewerTabId(path)).toBeUndefined();
    }
  });
  it("falls back to a generic name when the name is missing", () => {
    expect(viewerTabName(viewerTabPath("x", ""))).toBe("Attachment");
  });
});
