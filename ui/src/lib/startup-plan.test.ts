import { describe, expect, it } from "vitest";
import { commonFolder, planStartup } from "./startup-plan";

const file = (path: string) => ({ path, line: null, column: null });
describe("startup request plan", () => {
  it("opens a lone dropped file with its folder as project when none is open", () => {
    expect(planStartup({ workspaceRoot: "/w/a", files: [file("/w/a/x.ts")], impliedRoot: true })).toEqual({ switchTo: "/w/a", open: [file("/w/a/x.ts")], outside: [] });
  });
  it("opens files inside the open project without switching", () => {
    expect(planStartup({ workspaceRoot: "/w/a/src", files: [file("/w/a/src/x.ts")], impliedRoot: true }, "/w/a")).toEqual({ open: [file("/w/a/src/x.ts")], outside: [] });
  });
  it("asks about files outside the open project and never switches silently", () => {
    const plan = planStartup({ workspaceRoot: "/", files: [file("/w/a/x.ts"), file("/o/y.ts")], impliedRoot: true }, "/w/a");
    expect(plan.switchTo).toBeUndefined();
    expect(plan.open).toEqual([file("/w/a/x.ts")]);
    expect(plan.outside).toEqual([file("/o/y.ts")]);
  });
  it("a named folder switches project and keeps its files", () => {
    expect(planStartup({ workspaceRoot: "/o", files: [file("/o/y.ts")] }, "/w/a")).toEqual({ switchTo: "/o", open: [file("/o/y.ts")], outside: [] });
    expect(planStartup({ workspaceRoot: "/w/a", files: [] }, "/w/a").switchTo).toBeUndefined();
  });
  it("handles Windows style roots case insensitively", () => {
    expect(planStartup({ workspaceRoot: "C:\\W", files: [file("C:\\W\\x.ts")], impliedRoot: true }, "c:/w").open).toHaveLength(1);
  });
  it("finds the deepest common folder", () => {
    expect(commonFolder([file("/o/a/x.ts"), file("/o/b/y.ts")])).toBe("/o");
    expect(commonFolder([])).toBeUndefined();
  });
});
