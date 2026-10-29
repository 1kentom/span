// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost"}
import { beforeEach, describe, expect, it } from "vitest";
import { explorerPreferences, legacyExplorerPreferences, resolveLegacyExplorerPreferences, setCompactFolders, setAutoReveal, setConfirmDelete } from "./explorer-prefs";

beforeEach(() => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage;
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
});

describe("Explorer preferences", () => {
  it("uses the generated typed settings when present", () => {
    const settings = { explorer: { showHiddenFiles: false, showIgnoredFiles: true, compactFolders: false, autoReveal: false, confirmDelete: false } } as never;
    expect(explorerPreferences(settings)).toEqual({ showHiddenFiles: false, showIgnoredFiles: true, compactFolders: false, autoReveal: false, confirmDelete: false });
  });

  it("falls back to legacy values only when typed Explorer settings are absent", () => {
    setCompactFolders(false); setAutoReveal(false); setConfirmDelete(false);
    expect(explorerPreferences({} as never)).toEqual({ showHiddenFiles: true, showIgnoredFiles: false, compactFolders: false, autoReveal: false, confirmDelete: false });
    expect(explorerPreferences({ explorer: { showHiddenFiles: true, showIgnoredFiles: false, compactFolders: true, autoReveal: true, confirmDelete: true } } as never).compactFolders).toBe(true);
  });

  it("reads nullable legacy values and removes only backend-confirmed known leaves", () => {
    window.localStorage.setItem("span.explorer.compactFolders", "false");
    window.localStorage.setItem("span.explorer.autoReveal", "true");
    window.localStorage.setItem("span.explorer.confirmDelete", "false");
    expect(legacyExplorerPreferences()).toEqual({ compactFolders: false, autoReveal: true, confirmDelete: false });
    resolveLegacyExplorerPreferences(["compactFolders", "unknown"]);
    expect(window.localStorage.getItem("span.explorer.compactFolders")).toBeNull();
    expect(window.localStorage.getItem("span.explorer.autoReveal")).toBe("true");
    expect(window.localStorage.getItem("span.explorer.confirmDelete")).toBe("false");
  });
});
