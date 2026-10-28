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
    expect(view.button.badge).toBeUndefined();
    expect(view.statusBar.visible).toBe(false);
    expect(viewOf(undefined, { hasFile: false }).noCardText).toContain("Open a file");
  });
  it("needs install: size, install action and an attention badge", () => {
    const view = viewOf(makeServer("jdtls", { kind: "needs-install", server: "jdtls", version: "1.62.0", sizeHint: 120 * MB }, { state: { kind: "needsInstall", version: "1.62.0" }, installed: false }));
    expect(view.card!.status).toBe("Install for completions and errors (about 120 MB)");
    expect(view.card!.stateWord).toBe("");
    expect(actions(view)).toEqual(["install"]);
    expect(view.card!.actions[0]).toMatchObject({ label: "Install", primary: true });
    expect(view.button.badge).toBe("attention");
    expect(view.statusBar.text).toBe("Java \u00b7 Install");
    expect(viewOf(makeServer("jdtls", { kind: "needs-install", server: "jdtls", version: "1" }), { autoInstall: false }).card!.statusTip).toContain("Automatic install is off");
  });
  it("installing: one bar from overall bytes, phase line, cancel, ring", () => {
    const view = viewOf(javaInstalling(42, 134 * MB, 320 * MB));
    expect(view.card!.status).toBe("Downloading 134 of 320 MB");
    expect(view.card!.stateWord).toBe("Installing");
    expect(view.card!.progress).toMatchObject({ percent: 42, indeterminate: false });
    expect(actions(view)).toEqual(["cancel"]);
    expect(view.button.ring).toEqual({ kind: "determinate", percent: 42 });
    expect(view.button.label).toBe("Language intelligence. Installing Java (42%).");
    expect(view.statusBar.text).toBe("Java 42%");
    expect(view.rows.find(row => row.server === "jdtls")!.stateText).toBe("Installing 42%");
  });
  it("installing with an unknown total is indeterminate everywhere", () => {
    const view = viewOf(makeServer("jdtls", { kind: "installing", server: "jdtls", phase: "downloading", overallReceived: 5 * MB, overallTotal: null }, { state: { kind: "installing" } }));
    expect(view.card!.progress).toMatchObject({ indeterminate: true });
    expect(view.card!.progress!.percent).toBeUndefined();
    expect(view.card!.status).toBe("Downloading 5 MB");
    expect(view.button.ring.kind).toBe("indeterminate");
    expect(view.statusBar.text).toBe("Java \u00b7 Installing");
  });
  it("later install phases use human words", () => {
    for (const [phase, line] of [["verifying", "Checking the download"], ["extracting", "Unpacking"], ["finalizing", "Finishing"]]) expect(viewOf(javaInstalling(100, 320 * MB, 320 * MB, phase)).card!.status).toBe(line);
  });
  it("starting and working (indexing)", () => {
    const starting = viewOf(makeServer("jdtls", { kind: "starting", server: "jdtls" }, { state: { kind: "starting" } }));
    expect(starting.card!.status).toBe("The first start can take a minute");
    expect(starting.card!.stateWord).toBe("Starting");
    expect(starting.button.ring.kind).toBe("indeterminate");
    const working = viewOf(ready({}, [{ title: "Indexing project", message: "Reading dependencies", percentage: 35 }]));
    expect(working.card!.kind).toBe("working");
    expect(working.card!.stateWord).toBe("Indexing");
    expect(working.card!.status).toBe("Reading dependencies");
    expect(working.button.ring).toEqual({ kind: "determinate", percent: 35 });
    expect(working.statusBar.text).toBe("Java 35%");
    expect(working.card!.progress!.percent).toBe(35);
  });
  it("ready: the status line lists only what is on, there is no header word and no check", () => {
    const view = viewOf(ready());
    expect(view.card!.status).toBe("Completions, errors, hover, go to definition, references, rename, format");
    expect(view.card!.stateWord).toBe("");
    expect(view.card!.stateLabel).toBe("Ready");
    expect(view.button.tone).toBe("ok");
    expect(view.button.badge).toBeUndefined();
    expect(view.statusBar.text).toBe("Java");
    expect(actions(view)).toEqual(["restart"]);
    const partial = viewOf(ready({ capabilities: { ...allCapabilities, completion: false, rename: false, formatting: false, rangeFormatting: true } }));
    expect(partial.card!.status).toBe("Errors, hover, go to definition, references, format");
  });
  it("lists no feature before the server is ready", () => {
    const starting = viewOf(makeServer("jdtls", { kind: "starting", server: "jdtls" }, { state: { kind: "starting" } })).card!;
    expect(starting.status).not.toMatch(/Completions/);
  });
  it("runtime missing: found and required versions, choose and check again", () => {
    const view = viewOf(makeServer("jdtls", { kind: "runtime-missing", server: "jdtls", runtime: "Java", requiredVersion: 25, found: ["21"] }, { state: { kind: "runtimeMissing", runtime: "Java", requiredVersion: 25, found: ["21"] }, hub: { runtime: { name: "JDK", requiredVersion: 25, foundVersion: "21", foundPath: "/jdks/21" } } }));
    expect(view.card!.status).toBe("Needs JDK 25 or newer. Found JDK 21");
    expect(view.card!.statusTip).toBe("Found at /jdks/21. Install a newer JDK, or choose one.");
    expect(actions(view)).toEqual(["chooseRuntime", "checkAgain"]);
    expect(view.card!.actions[0].label).toBe("Choose JDK");
    expect(view.button.badge).toBe("attention");
    expect(view.statusBar.text).toBe("Java \u00b7 JDK");
    const old = viewOf(makeServer("jdtls", { kind: "runtime-missing", server: "jdtls", runtime: "Java", requiredVersion: 25, found: ["17"] }, { state: { kind: "runtimeMissing", runtime: "Java", requiredVersion: 25, found: ["17"] } }));
    expect(old.card!.status).toBe("Needs JDK 25 or newer. Found JDK 17");
  });
  it("failed install: plain reason, retry when retryable, technical details", () => {
    const state = { kind: "install-failed" as const, server: "jdtls" as const, reason: "os error 54", retryable: true };
    const view = viewOf(makeServer("jdtls", state, { state: { kind: "installFailed", reason: "os error 54", retryable: true }, hub: { failureReason: "Could not download Java support.", failureDetails: "GET https://x: os error 54" } }));
    expect(view.card!.status).toBe("Couldn't install. Check your connection");
    expect(view.card!.statusTip).toBe("Could not download Java support. GET https://x: os error 54");
    expect(view.card!.failure).toEqual({ reason: "Could not download Java support.", details: "GET https://x: os error 54" });
    expect(actions(view)).toEqual(["retry", "copyDetails"]);
    expect(view.statusBar.text).toBe("Java \u00b7 Failed");
    const hard = viewOf(makeServer("jdtls", { ...state, reason: "no space", retryable: false }, { state: { kind: "installFailed", reason: "no space", retryable: false } }));
    expect(actions(hard)).toEqual(["restart", "settings"]);
    expect(hard.card!.statusTip).toContain("Retrying will not fix this");
    expect(hard.card!.failure!.details).toBe("no space");
  });
  it("failed start offers Restart, crashed says it stopped, disabled offers Turn on, status unavailable offers Retry", () => {
    expect(actions(viewOf(makeServer("jdtls", { kind: "start-failed", server: "jdtls", reason: "boom" }, { state: { kind: "startFailed", reason: "boom" } })))).toEqual(["restart", "settings"]);
    const crashed = viewOf(makeServer("jdtls", { kind: "crashed", server: "jdtls" }, { state: { kind: "crashed" } }));
    expect(crashed.card!.status).toBe("Stopped unexpectedly");
    expect(actions(crashed)).toEqual(["restart"]);
    const off = viewOf(makeServer("jdtls", { kind: "disabled", server: "jdtls" }, { state: { kind: "disabled" }, enabled: false }));
    expect(off.card!.status).toBe("Turn on for completions and errors");
    expect(off.card!.stateWord).toBe("Off");
    expect(actions(off)).toEqual(["turnOn"]);
    expect(off.button.badge).toBeUndefined();
    const down = viewOf(makeServer("vtsls", { kind: "unknown", server: "vtsls" }), { statusError: "Could not read language server status: boom" });
    expect(down.card!.kind).toBe("unavailable");
    expect(actions(down)).toEqual(["refresh"]);
    expect(down.card!.statusTip).toBe("Could not read language server status: boom");
    expect(down.statusBar.text).toBe("TypeScript \u00b7 Unavailable");
    expect(viewOf(makeServer("vtsls", { kind: "unknown", server: "vtsls" })).card!.kind).toBe("unknown");
  });
  it("lists every language once, with the current one marked and a switch state", () => {
    const view = viewOf(ready(), {});
    expect(view.rows.map(row => row.name)).toEqual(["Java", "TypeScript", "HTML", "CSS", "JSON", "Rust", "Python"]);
    expect(view.rows.filter(row => row.current).map(row => row.name)).toEqual(["Java"]);
    const off = buildHubView(makeSnapshot(ready(), { servers: [makeServer("html", { kind: "disabled", server: "html" }, { state: { kind: "disabled" }, enabled: false, installed: false }), ready()] }));
    expect(off.rows.find(row => row.server === "html")).toMatchObject({ enabled: false, stateText: "" });
    const sized = viewOf(makeServer("jdtls", { kind: "ready", server: "jdtls" }, { hub: { installedSizeBytes: 412 * MB } }));
    expect(sized.rows[0]).toMatchObject({ version: "1.62", size: "412 MB", stateText: "" });
    expect(view.rows.filter(row => row.action).map(row => row.server)).toEqual([]);
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
  it("shows the prompt, a restricted badge and a trust action when the folder needs trust", () => {
    const view = viewOf(needs());
    expect(view.banner).toMatchObject({ server: "jdtls", root: "/w", title: "Trust this folder to load its dependencies?" });
    expect(view.banner!.explain).toContain("Only trust folders from a source you trust.");
    expect(view.banner!.restarting).toBeUndefined();
    expect(view.button.badge).toBe("restricted");
    expect(view.statusBar.text).toBe("Java \u00b7 Trust");
    expect(view.card!.trust).toMatchObject({ needsTrust: true, label: "Untrusted folder" });
    expect(view.card!.trust!.tip).toBe(view.banner!.explain);
    expect(actions(view)).toEqual(["trust", "restart"]);
    expect(view.card!.actions[0]).toMatchObject({ label: "Trust folder", primary: true });
  });
  it("hides the prompt for a folder that was dismissed, but keeps the footer and badge", () => {
    const view = viewOf(needs(), { dismissedTrust: new Set(["/w"]) });
    expect(view.banner).toBeUndefined();
    expect(view.button.badge).toBe("restricted");
    expect(actions(view)[0]).toBe("trust");
    expect(viewOf(needs(), { dismissedTrust: new Set(["/other"]) }).banner).toBeDefined();
  });
  it("shows the restarting message instead of the buttons while restarting, even when dismissed", () => {
    const view = viewOf(needs(), { trustRestarting: true, dismissedTrust: new Set(["/w"]) });
    expect(view.banner!.restarting).toBe("Restarting Java with its dependencies");
    expect(view.card!.trust!.restarting).toBe("Restarting Java with its dependencies");
    expect(view.card!.status).toBe("Restarting Java with its dependencies");
    expect(actions(view)).toEqual([]);
  });
  it("says the folder is trusted once trusted, and shows no trust line for servers without a build tool", () => {
    const trusted = viewOf(ready());
    expect(trusted.banner).toBeUndefined();
    expect(trusted.card!.trust).toMatchObject({ trusted: true, needsTrust: false, label: "Trusted folder" });
    const ts = viewOf(makeServer("vtsls", { kind: "ready", server: "vtsls" }, { state: { kind: "ready" }, hub: { trust: { workspaceTrusted: false, needsTrust: true } } }));
    expect(ts.banner).toBeUndefined();
    expect(ts.card!.trust).toBeUndefined();
  });
  it("does not offer trust before the server has started or when it is turned off", () => {
    expect(viewOf(makeServer("jdtls", { kind: "disabled", server: "jdtls" }, { state: { kind: "disabled" }, enabled: false, hub: { trust: { workspaceTrusted: false, needsTrust: true } } })).banner).toBeUndefined();
  });
  it("never has more than two actions in any state", () => {
    const states: any[] = [
      makeServer("jdtls", { kind: "needs-install", server: "jdtls", version: "1" }), javaInstalling(10, MB, 10 * MB), ready(), needs(),
      makeServer("jdtls", { kind: "runtime-missing", server: "jdtls", runtime: "Java", requiredVersion: 25, found: [] }, { state: { kind: "runtimeMissing", runtime: "Java", requiredVersion: 25, found: [] } }),
      makeServer("jdtls", { kind: "install-failed", server: "jdtls", reason: "x", retryable: true }, { hub: { failureDetails: "d" } }),
      makeServer("jdtls", { kind: "crashed", server: "jdtls" }), makeServer("jdtls", { kind: "disabled", server: "jdtls" }), makeServer("jdtls", { kind: "idle", server: "jdtls" }),
    ];
    for (const state of states) expect(viewOf(state).card!.actions.length).toBeLessThanOrEqual(2);
  });
});
