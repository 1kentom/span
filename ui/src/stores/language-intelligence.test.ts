import { describe, expect, it } from "vitest";
import { makeServer, type EntryOverrides, viewOf, javaInstalling, allCapabilities } from "./language-intelligence.testkit";
import { buildHubView } from "./language-intelligence";
import { makeSnapshot } from "./language-intelligence.testkit";

const MB = 1024 * 1024;
const ready = (entry: EntryOverrides = {}, activity: { title?: string; message?: string; percentage?: number }[] = []) =>
  makeServer("jdtls", { kind: "ready", server: "jdtls", capabilities: allCapabilities }, { state: { kind: "ready" }, ...entry }, activity);
const actions = (view: ReturnType<typeof viewOf>) => view.card!.actions.map(item => item.id);

describe("hub view: every state", () => {
  it("has no card, a neutral button and no status bar item for a file without a language server", () => {
    const view = viewOf(undefined);
    expect(view.card).toBeUndefined();
    expect(view.noCardText).toContain("No language support");
    expect(view.button.tone).toBe("off");
    expect(view.button.ring.kind).toBe("none");
    expect(view.button.check).toBe(false);
    expect(view.button.badge).toBeUndefined();
    expect(view.statusBar.visible).toBe(false);
    expect(viewOf(undefined, { hasFile: false }).noCardText).toContain("Open a file");
  });
  it("needs install: size, install action and an attention badge", () => {
    const view = viewOf(makeServer("jdtls", { kind: "needs-install", server: "jdtls", version: "1.62.0", sizeHint: 120 * MB }, { state: { kind: "needsInstall", version: "1.62.0" }, installed: false }));
    expect(view.card!.detail).toContain("About 120 MB");
    expect(actions(view)).toEqual(["install"]);
    expect(view.card!.actions[0].label).toBe("Install Java support");
    expect(view.button.badge).toBe("attention");
    expect(view.statusBar.text).toBe("Java: not installed");
    expect(viewOf(makeServer("jdtls", { kind: "needs-install", server: "jdtls", version: "1" }), { autoInstall: false }).card!.detail).toContain("Automatic install is off");
  });
  it("installing: one bar from overall bytes, phase line, cancel, ring", () => {
    const view = viewOf(javaInstalling(42, 134 * MB, 320 * MB));
    expect(view.card!.headline).toBe("Downloading… 134 MB of 320 MB");
    expect(view.card!.progress).toMatchObject({ percent: 42, indeterminate: false });
    expect(view.card!.detail).toBe("You can keep editing. Java features switch on by themselves when it is ready.");
    expect(actions(view)).toEqual(["cancel"]);
    expect(view.button.ring).toEqual({ kind: "determinate", percent: 42 });
    expect(view.button.label).toBe("Language intelligence. Installing Java support (42%).");
    expect(view.statusBar.text).toBe("Java: installing 42%");
    expect(view.rows.find(row => row.server === "jdtls")!.stateText).toBe("Installing 42%");
  });
  it("installing with an unknown total is indeterminate everywhere", () => {
    const view = viewOf(makeServer("jdtls", { kind: "installing", server: "jdtls", phase: "downloading", overallReceived: 5 * MB, overallTotal: null }, { state: { kind: "installing" } }));
    expect(view.card!.progress).toMatchObject({ indeterminate: true });
    expect(view.card!.progress!.percent).toBeUndefined();
    expect(view.card!.headline).toBe("Downloading… 5 MB so far");
    expect(view.button.ring.kind).toBe("indeterminate");
    expect(view.statusBar.text).toBe("Java: installing");
  });
  it("later install phases use human words", () => {
    for (const [phase, line] of [["verifying", "Checking the download…"], ["extracting", "Unpacking…"], ["finalizing", "Finishing…"]]) expect(viewOf(javaInstalling(100, 320 * MB, 320 * MB, phase)).card!.headline).toBe(line);
  });
  it("starting and working (indexing)", () => {
    const starting = viewOf(makeServer("jdtls", { kind: "starting", server: "jdtls" }, { state: { kind: "starting" } }));
    expect(starting.card!.detail).toContain("The first start can take a minute");
    expect(starting.button.ring.kind).toBe("indeterminate");
    const working = viewOf(ready({}, [{ title: "Indexing project", message: "Reading dependencies", percentage: 35 }]));
    expect(working.card!.kind).toBe("working");
    expect(working.card!.headline).toBe("Indexing your project… 35%");
    expect(working.card!.detail).toBe("Reading dependencies");
    expect(working.button.ring).toEqual({ kind: "determinate", percent: 35 });
    expect(working.statusBar.text).toBe("Java: indexing 35%");
    expect(working.card!.progress!.percent).toBe(35);
  });
  it("ready: chips from the capability flags, check state, restart and settings", () => {
    const view = viewOf(ready());
    expect(view.card!.detail).toBe("Ready. Completions, errors, hover and go to definition are on for this file.");
    expect(view.card!.chips.map(chip => [chip.label, chip.on])).toEqual([["Completions", true], ["Errors", true], ["Hover", true], ["Go to definition", true], ["References", true], ["Rename", true], ["Format", true]]);
    expect(view.button.check).toBe(true);
    expect(view.button.tone).toBe("ok");
    expect(actions(view)).toEqual(["restart", "settings", "stopTrusting"]);
    const partial = viewOf(ready({ capabilities: { ...allCapabilities, completion: false, rename: false, formatting: false, rangeFormatting: true } }));
    expect(partial.card!.chips.filter(chip => !chip.on).map(chip => chip.label)).toEqual(["Completions", "Rename"]);
    expect(partial.card!.chips[0].tooltip).toContain("not available");
  });
  it("chips are all off with a waiting tooltip until the server is ready", () => {
    const chips = viewOf(makeServer("jdtls", { kind: "starting", server: "jdtls" }, { state: { kind: "starting" } })).card!.chips;
    expect(chips.every(chip => !chip.on)).toBe(true);
    expect(chips[0].tooltip).toBe("Available once Java support is ready.");
  });
  it("runtime missing: found and required versions, choose and check again", () => {
    const view = viewOf(makeServer("jdtls", { kind: "runtime-missing", server: "jdtls", runtime: "Java", requiredVersion: 25, found: ["21"] }, { state: { kind: "runtimeMissing", runtime: "Java", requiredVersion: 25, found: ["21"] }, hub: { runtime: { name: "JDK", requiredVersion: 25, foundVersion: "21", foundPath: "/jdks/21" } } }));
    expect(view.card!.detail).toBe("Java support needs JDK 25 or newer. Found: JDK 21 at /jdks/21. Install a newer JDK, or choose one.");
    expect(actions(view)).toEqual(["chooseRuntime", "checkAgain"]);
    expect(view.card!.actions[0].label).toBe("Choose JDK folder…");
    expect(view.button.badge).toBe("attention");
    expect(view.statusBar.text).toBe("Java: needs JDK");
    const old = viewOf(makeServer("jdtls", { kind: "runtime-missing", server: "jdtls", runtime: "Java", requiredVersion: 25, found: ["17"] }, { state: { kind: "runtimeMissing", runtime: "Java", requiredVersion: 25, found: ["17"] } }));
    expect(old.card!.detail).toContain("Found: JDK 17.");
  });
  it("failed install: plain reason, retry when retryable, technical details", () => {
    const state = { kind: "install-failed" as const, server: "jdtls" as const, reason: "os error 54", retryable: true };
    const view = viewOf(makeServer("jdtls", state, { state: { kind: "installFailed", reason: "os error 54", retryable: true }, hub: { failureReason: "Could not download Java support.", failureDetails: "GET https://x: os error 54" } }));
    expect(view.card!.detail).toBe("Could not download Java support.");
    expect(view.card!.failure).toEqual({ reason: "Could not download Java support.", details: "GET https://x: os error 54" });
    expect(actions(view)).toEqual(["retry"]);
    const hard = viewOf(makeServer("jdtls", { ...state, reason: "no space", retryable: false }, { state: { kind: "installFailed", reason: "no space", retryable: false } }));
    expect(actions(hard)).toEqual(["restart", "settings"]);
    expect(hard.card!.note).toContain("Retrying will not fix this");
    expect(hard.card!.failure!.details).toBe("no space");
  });
  it("failed start offers Restart, crashed says it stopped, disabled offers Turn on, status unavailable offers Retry", () => {
    expect(actions(viewOf(makeServer("jdtls", { kind: "start-failed", server: "jdtls", reason: "boom" }, { state: { kind: "startFailed", reason: "boom" } })))).toEqual(["restart", "settings"]);
    const crashed = viewOf(makeServer("jdtls", { kind: "crashed", server: "jdtls" }, { state: { kind: "crashed" } }));
    expect(crashed.card!.detail).toBe("Java support stopped unexpectedly.");
    expect(actions(crashed)).toEqual(["restart"]);
    const off = viewOf(makeServer("jdtls", { kind: "disabled", server: "jdtls" }, { state: { kind: "disabled" }, enabled: false }));
    expect(off.card!.detail).toBe("Java support is turned off.");
    expect(actions(off)).toEqual(["turnOn"]);
    expect(off.button.badge).toBeUndefined();
    const down = viewOf(makeServer("vtsls", { kind: "unknown", server: "vtsls" }), { statusError: "Could not read language server status: boom" });
    expect(down.card!.kind).toBe("unavailable");
    expect(actions(down)).toEqual(["refresh"]);
    expect(down.statusBar.text).toBe("TypeScript: status unavailable");
    expect(viewOf(makeServer("vtsls", { kind: "unknown", server: "vtsls" })).card!.kind).toBe("unknown");
  });
  it("lists every language once, with the current one marked and a switch state", () => {
    const view = viewOf(ready(), {});
    expect(view.rows.map(row => row.name)).toEqual(["Java", "TypeScript and JavaScript", "HTML", "CSS, SCSS and Less", "JSON", "Rust", "Python"]);
    expect(view.rows.filter(row => row.current).map(row => row.name)).toEqual(["Java"]);
    const off = buildHubView(makeSnapshot(ready(), { servers: [makeServer("html", { kind: "disabled", server: "html" }, { state: { kind: "disabled" }, enabled: false, installed: false }), ready()] }));
    expect(off.rows.find(row => row.server === "html")).toMatchObject({ enabled: false, stateText: "Off" });
    const sized = viewOf(makeServer("jdtls", { kind: "ready", server: "jdtls" }, { hub: { installedSizeBytes: 412 * MB } }));
    expect(sized.rows[0]).toMatchObject({ version: "1.62.0", size: "412 MB" });
  });
  it("keeps showing an install that runs for another language while the active file has none", () => {
    const view = buildHubView(makeSnapshot(undefined, { servers: [javaInstalling(30, 96 * MB, 320 * MB)] }));
    expect(view.card).toBeUndefined();
    expect(view.button.ring).toEqual({ kind: "determinate", percent: 30 });
    expect(view.statusBar.visible).toBe(false);
  });
});

describe("hub view: workspace trust", () => {
  const needs = (over: EntryOverrides = {}) => ready({ hub: { trust: { workspaceTrusted: false, needsTrust: true, reason: "pom.xml" } }, ...over });
  it("shows the banner, a restricted badge and a trust action when the folder needs trust", () => {
    const view = viewOf(needs());
    expect(view.banner).toMatchObject({ server: "jdtls", root: "/w", title: "Trust this folder to load project dependencies?" });
    expect(view.banner!.restarting).toBeUndefined();
    expect(view.button.badge).toBe("restricted");
    expect(view.button.check).toBe(false);
    expect(view.statusBar.text).toBe("Java: ready (restricted)");
    expect(view.card!.trust).toMatchObject({ needsTrust: true });
    expect(actions(view)[0]).toBe("trust");
    expect(view.card!.actions[0].label).toBe("Trust this folder");
  });
  it("hides the banner for a folder that was dismissed, but keeps the card and badge", () => {
    const view = viewOf(needs(), { dismissedTrust: new Set(["/w"]) });
    expect(view.banner).toBeUndefined();
    expect(view.button.badge).toBe("restricted");
    expect(actions(view)[0]).toBe("trust");
    expect(viewOf(needs(), { dismissedTrust: new Set(["/other"]) }).banner).toBeDefined();
  });
  it("shows the restarting message instead of the buttons while restarting, even when dismissed", () => {
    const view = viewOf(needs(), { trustRestarting: true, dismissedTrust: new Set(["/w"]) });
    expect(view.banner!.restarting).toBe("Restarting Java support with project dependencies…");
    expect(view.card!.trust!.restarting).toBe("Restarting Java support with project dependencies…");
    expect(actions(view)).not.toContain("trust");
  });
  it("offers Stop trusting once trusted, and never for servers without a build tool", () => {
    const trusted = viewOf(ready());
    expect(trusted.banner).toBeUndefined();
    expect(actions(trusted)).toContain("stopTrusting");
    expect(trusted.card!.trust).toMatchObject({ trusted: true });
    const ts = viewOf(makeServer("vtsls", { kind: "ready", server: "vtsls" }, { state: { kind: "ready" }, hub: { trust: { workspaceTrusted: false, needsTrust: true } } }));
    expect(ts.banner).toBeUndefined();
    expect(actions(ts)).not.toContain("stopTrusting");
  });
  it("does not offer trust before the server has started or when it is turned off", () => {
    expect(viewOf(makeServer("jdtls", { kind: "disabled", server: "jdtls" }, { state: { kind: "disabled" }, enabled: false, hub: { trust: { workspaceTrusted: false, needsTrust: true } } })).banner).toBeUndefined();
  });
});
