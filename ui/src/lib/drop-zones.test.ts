import { describe, expect, it } from "vitest";
import { zoneAt, zoneStyle, zoneLabel } from "./drop-zones";

const box = { left: 100, top: 50, width: 400, height: 200 };
describe("editor drop zones", () => {
  it("classifies edges before the centre in the design's order", () => {
    expect(zoneAt(box, 110, 150)).toBe("left");
    expect(zoneAt(box, 490, 150)).toBe("right");
    expect(zoneAt(box, 300, 55)).toBe("top");
    expect(zoneAt(box, 300, 245)).toBe("bottom");
    expect(zoneAt(box, 300, 150)).toBe("center");
    expect(zoneAt(box, 110, 55)).toBe("left");
    expect(zoneAt(box, 199, 150)).toBe("left");
    expect(zoneAt(box, 201, 150)).toBe("center");
  });
  it("covers half the pane for edge zones with a 4px inset", () => {
    expect(zoneStyle("right")).toEqual({ right: "4px", top: "4px", bottom: "4px", width: "calc(50% - 6px)" });
    expect(zoneStyle("top").height).toBe("calc(50% - 6px)");
    expect(zoneStyle("center").width).toBeUndefined();
  });
  it("labels the action", () => {
    expect(zoneLabel("bottom", false, false)).toBe("Open below");
    expect(zoneLabel("left", true, true)).toBe("Copy to the left");
    expect(zoneLabel("center", true, false)).toBe("Move");
  });
});
