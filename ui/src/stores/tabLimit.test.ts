import { describe, expect, it } from "vitest";
import { planTabEvictions } from "./tabLimit";
import type { EditorGroup } from "./workbench";

const groups = (...tabs: string[][]): EditorGroup[] => tabs.map((items, index) => ({ id: index + 1, tabs: items, active: items.at(-1) }));

describe("tab limit eviction planning", () => {
  it("evicts least-recently-used clean tabs across groups and removes shared files once per group", () => {
    const result = planTabEvictions(groups(["shared", "a", "active"], ["shared", "b", "other-active"]), 2, false, ["active", "other-active", "b", "shared", "a"], () => false);
    expect(result).toEqual([{ path: "a", group: 1 }, { path: "shared", group: 1 }, { path: "shared", group: 2 }, { path: "b", group: 2 }]);
  });

  it("applies the limit per group and retains dirty and active tabs", () => {
    const result = planTabEvictions(groups(["dirty", "old", "active"], ["other-old", "other-active"]), 1, true, ["active", "other-active", "old", "other-old", "dirty"], path => path === "dirty");
    expect(result).toEqual([{ path: "old", group: 1 }, { path: "other-old", group: 2 }]);
  });

  it("leaves an over-limit group alone when only dirty or active tabs remain", () => {
    const result = planTabEvictions(groups(["dirty", "active"]), 1, false, ["active", "dirty"], path => path === "dirty");
    expect(result).toEqual([]);
  });

  it("counts one file once when a group contains duplicate references", () => {
    const result = planTabEvictions([{ id: 1, tabs: ["shared", "shared", "active"], active: "active" }], 2, true, ["active", "shared"], () => false);
    expect(result).toEqual([]);
  });
});
