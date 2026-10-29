import { describe, expect, it } from "vitest";
import {
  capabilityChips, filterRows, filterUseful, languageState, pillLabel, searchUseful, settleState, statusTooltip, withPercent, worstState, SETTLE_MS, type LanguageKind,
} from "./language-status";
import { allCapabilities } from "../stores/language-intelligence.testkit";

const kinds: LanguageKind[] = ["unknown", "unavailable", "disabled", "idle", "needs-install", "installing", "starting", "working", "ready", "runtime-missing", "install-failed", "failed", "crashed"];

describe("language state mapping", () => {
  it("maps every detailed state to one of the five visible states", () => {
    const map = Object.fromEntries(kinds.map(kind => [kind, languageState(kind)]));
    expect(map).toEqual({
      unknown: "starting", unavailable: "error", disabled: "off", idle: "off", "needs-install": "off", installing: "starting", starting: "starting",
      working: "starting", ready: "ready", "runtime-missing": "error", "install-failed": "error", failed: "error", crashed: "error",
    });
    expect(languageState("ready", true)).toBe("needs-trust");
    expect(languageState("failed", true)).toBe("error");
  });
  it("gives the pill a short word, with the percent while busy", () => {
    expect(pillLabel("ready")).toBe("Ready");
    expect(pillLabel("ready", true)).toBe("Needs trust");
    expect(pillLabel("installing")).toBe("Installing");
    expect(withPercent("Installing", 41.6)).toBe("Installing 42%");
    expect(withPercent("Installing", 140)).toBe("Installing 100%");
    expect(withPercent("Ready")).toBe("Ready");
    expect(pillLabel("working")).toBe("Indexing");
    expect(pillLabel("failed")).toBe("Error");
    expect(pillLabel("disabled")).toBe("Off");
    for (const kind of kinds) expect(pillLabel(kind)).not.toContain("\u2014");
  });
  it("builds the status bar tooltip from name, server and state", () => {
    expect(statusTooltip("Rust", "rust-analyzer 2026-10-12", "Ready")).toBe("Rust, rust-analyzer 2026-10-12, ready");
    expect(statusTooltip("Markdown", undefined, undefined)).toBe("Markdown, no language support");
  });
});

describe("capability chips", () => {
  it("always lists all seven in order and dims what the server lacks", () => {
    const chips = capabilityChips("ready", { ...allCapabilities, rename: false, formatting: false, rangeFormatting: false });
    expect(chips.map(chip => chip.label)).toEqual(["Completions", "Diagnostics", "Hover", "Definition", "References", "Rename", "Format"]);
    expect(chips.filter(chip => !chip.on).map(chip => chip.id)).toEqual(["rename", "format"]);
  });
  it("counts range formatting as Format and lights nothing while the server is not running", () => {
    expect(capabilityChips("working", { ...allCapabilities, formatting: false, rangeFormatting: true }).find(chip => chip.id === "format")!.on).toBe(true);
    expect(capabilityChips("starting", allCapabilities).some(chip => chip.on)).toBe(false);
    expect(capabilityChips("ready", null).some(chip => chip.on)).toBe(false);
  });
});

describe("language list filter", () => {
  const rows = [
    { name: "Java", technical: "Eclipse JDT LS", enabled: true },
    { name: "Rust", technical: "rust-analyzer", enabled: false },
    { name: "Python", technical: "basedpyright", enabled: true },
  ];
  it("filters by active and by name or server name", () => {
    expect(filterRows(rows, "all").map(row => row.name)).toEqual(["Java", "Rust", "Python"]);
    expect(filterRows(rows, "active").map(row => row.name)).toEqual(["Java", "Python"]);
    expect(filterRows(rows, "all", " ANALY").map(row => row.name)).toEqual(["Rust"]);
    expect(filterRows(rows, "active", "rust")).toEqual([]);
  });
  it("offers the All / Active switch only when it changes the list, and search only for a long list", () => {
    expect(filterUseful(rows)).toBe(true);
    expect(filterUseful(rows.map(row => ({ ...row, enabled: true })))).toBe(false);
    expect(filterUseful(rows.map(row => ({ ...row, enabled: false })))).toBe(false);
    expect(searchUseful(new Array(7))).toBe(false);
    expect(searchUseful(new Array(9))).toBe(true);
  });
});

describe("worst state for the top bar badge", () => {
  it("prefers an error, then an untrusted folder, and ignores servers that are off", () => {
    expect(worstState([{ state: "ready", enabled: true }, { state: "error", enabled: true }], true)).toBe("error");
    expect(worstState([{ state: "error", enabled: false }, { state: "ready", enabled: true }], false)).toBeUndefined();
    expect(worstState([{ state: "ready", enabled: true }], true)).toBe("needs-trust");
    expect(worstState([{ state: "needs-trust", enabled: true }], false)).toBe("needs-trust");
  });
});

describe("state settling", () => {
  it("holds Ready through a short busy burst and shows everything else at once", () => {
    expect(settleState("ready", "starting", 0)).toBe("ready");
    expect(settleState("ready", "starting", SETTLE_MS - 1)).toBe("ready");
    expect(settleState("ready", "starting", SETTLE_MS)).toBe("starting");
    expect(settleState("starting", "ready", 0)).toBe("ready");
    expect(settleState("ready", "error", 0)).toBe("error");
    expect(settleState("off", "starting", 0)).toBe("starting");
  });
});
