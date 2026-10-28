// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actionDefinitions, syntaxThemeIds, syntaxTokenIds } from "./commands";
import { NAVIGATION_UNAVAILABLE_MESSAGE, navigationActionIds, navigationActions, registerNavigationHandler, runNavigationAction, setNavigationNotifier } from "./navigation-actions";

const rust = readFileSync(new URL("../../../crates/core/src/settings.rs", import.meta.url), "utf8");
const schema = JSON.parse(readFileSync(new URL("../../../crates/core/settings.schema.json", import.meta.url), "utf8"));
const rustList = (name: string): string[] => {
  const body = new RegExp(`${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`).exec(rust)?.[1];
  if (!body) throw new Error(`${name} not found in settings.rs`);
  return [...body.matchAll(/"([A-Za-z0-9]+)"/g)].map(match => match[1]);
};

describe("Rust and TypeScript id lists", () => {
  it("keep the same command ids, including the JSON schema", () => {
    // Both older lists place goToLine differently, so the sets are compared; the new ids keep the same relative order.
    const ids = actionDefinitions.map(action => action.id).sort();
    expect([...rustList("COMMAND_IDS")].sort()).toEqual(ids);
    expect([...schema.properties.keybindings.propertyNames.enum].sort()).toEqual(ids);
    const navigation = (list: readonly string[]) => list.filter(id => (navigationActionIds as readonly string[]).includes(id));
    expect(navigation(rustList("COMMAND_IDS"))).toEqual(navigation(actionDefinitions.map(action => action.id)));
  });
  it("keep the same syntax themes and token ids, including the JSON schema", () => {
    expect(rustList("SYNTAX_TOKEN_IDS")).toEqual([...syntaxTokenIds]);
    expect(rustList("SYNTAX_THEMES")).toEqual([...syntaxThemeIds]);
    expect(schema.properties.syntaxColors.additionalProperties.propertyNames.enum).toEqual([...syntaxTokenIds]);
    expect(schema.properties.syntaxColors.propertyNames.enum).toEqual([...syntaxThemeIds]);
    expect(syntaxTokenIds).toHaveLength(30);
  });
  it("lists every navigation id as an action", () => {
    for (const id of navigationActionIds) expect(actionDefinitions.some(action => action.id === id), id).toBe(true);
    expect(Object.keys(navigationActions).sort()).toEqual([...navigationActionIds].sort());
  });
});

describe("navigation action registry", () => {
  afterEach(() => setNavigationNotifier(undefined));
  it("reports an unregistered action instead of silently doing nothing", () => {
    const notify = vi.fn(); setNavigationNotifier(notify);
    expect(runNavigationAction("peekReferences")).toBe(false);
    expect(notify).toHaveBeenCalledWith(NAVIGATION_UNAVAILABLE_MESSAGE);
    navigationActions.peekReferences();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(() => { setNavigationNotifier(undefined); runNavigationAction("peekReferences"); }).not.toThrow();
  });
  it("runs the registered handler through the action table and stops after unregistering", () => {
    const handler = vi.fn(), notify = vi.fn(); setNavigationNotifier(notify);
    const dispose = registerNavigationHandler("goToDefinition", handler);
    navigationActions.goToDefinition();
    expect(handler).toHaveBeenCalledOnce(); expect(notify).not.toHaveBeenCalled();
    dispose();
    expect(runNavigationAction("goToDefinition")).toBe(false);
  });
  it("lets the latest registration win and ignores a stale disposer", () => {
    const first = vi.fn(), second = vi.fn();
    const disposeFirst = registerNavigationHandler("renameSymbol", first);
    const disposeSecond = registerNavigationHandler("renameSymbol", second);
    disposeFirst(); runNavigationAction("renameSymbol");
    expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledOnce();
    disposeSecond();
  });
  it("reports handler failures, sync or async, without throwing", async () => {
    const notify = vi.fn(); setNavigationNotifier(notify);
    const a = registerNavigationHandler("goBack", () => { throw new Error("sync"); });
    expect(runNavigationAction("goBack")).toBe(true); expect(notify).toHaveBeenCalledWith("Error: sync"); a();
    const b = registerNavigationHandler("goForward", async () => { throw new Error("async"); });
    runNavigationAction("goForward"); await Promise.resolve(); await Promise.resolve();
    expect(notify).toHaveBeenCalledWith("Error: async"); b();
  });
});
