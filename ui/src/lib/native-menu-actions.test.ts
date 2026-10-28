import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { actionDefinitions, nativeMenuBindings, resolveKeybindings } from "./commands";

/** Ids in the native menu table of `apps/desktop/src/menu.rs`, read from the source so the two lists cannot drift apart. */
function nativeMenuIds(): string[] {
  const source = readFileSync(resolve("../apps/desktop/src/menu.rs"), "utf8");
  const table = source.slice(source.indexOf("const ACTIONS"));
  const end = table.indexOf("\n];");
  return [...table.slice(0, end).matchAll(/\(\s*"([A-Za-z0-9_]+)"\s*,\s*"[^"]*"\s*,\s*NativeAction::/g)].map(match => match[1]);
}

describe("native menu action ids", () => {
  it("reads a plausible table from the Rust source", () => {
    const ids = nativeMenuIds();
    expect(ids.length).toBeGreaterThan(10);
    expect(ids).toContain("quickOpen");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only sends ids the native menu owns, so sync_native_menu never answers Unknown native menu action", () => {
    const owned = new Set(nativeMenuIds());
    const sent = Object.keys(nativeMenuBindings(resolveKeybindings({}, "mac")));
    expect(sent.filter(id => !owned.has(id))).toEqual([]);
  });

  it("sends the language server format shortcut now that the native menu has an item for it", () => {
    expect(actionDefinitions.some(action => action.id === "formatWithLanguageServer")).toBe(true);
    expect(nativeMenuIds()).toContain("formatWithLanguageServer");
    expect(Object.keys(nativeMenuBindings(resolveKeybindings({}, "mac")))).toContain("formatWithLanguageServer");
  });

  it("still sends every other action that has a native menu item", () => {
    const sent = new Set(Object.keys(nativeMenuBindings(resolveKeybindings({}, "mac"))));
    expect(nativeMenuIds().filter(id => actionDefinitions.some(action => action.id === id) && !sent.has(id))).toEqual([]);
  });
});
