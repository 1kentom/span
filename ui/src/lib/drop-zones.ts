/** Editor drop zones, following the design reference: edges first (left, right, top, bottom at 25 percent), else the centre. */
export type DropZone = "center" | "left" | "right" | "top" | "bottom";
export type EditorDropTarget = { group: number; zone: DropZone };

export function zoneAt(box: { left: number; top: number; width: number; height: number }, x: number, y: number): DropZone {
  const rx = (x - box.left) / Math.max(1, box.width);
  const ry = (y - box.top) / Math.max(1, box.height);
  if (rx < .25) return "left";
  if (rx > .75) return "right";
  if (ry < .25) return "top";
  if (ry > .75) return "bottom";
  return "center";
}

/** Inset style of the translucent overlay. Edge zones cover half the pane, the centre covers all of it. */
export function zoneStyle(zone: DropZone): Record<string, string> {
  const half = "calc(50% - 6px)";
  switch (zone) {
    case "left": return { left: "4px", top: "4px", bottom: "4px", width: half };
    case "right": return { right: "4px", top: "4px", bottom: "4px", width: half };
    case "top": return { left: "4px", right: "4px", top: "4px", height: half };
    case "bottom": return { left: "4px", right: "4px", bottom: "4px", height: half };
    default: return { left: "4px", right: "4px", top: "4px", bottom: "4px" };
  }
}

export const zoneLabel = (zone: DropZone, tab: boolean, copy: boolean): string => {
  const verb = tab ? (copy ? "Copy" : "Move") : "Open";
  return zone === "center" ? verb : `${verb} ${zone === "top" ? "above" : zone === "bottom" ? "below" : `to the ${zone}`}`;
};
