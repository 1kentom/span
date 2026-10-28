import { describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import type { LspPort } from "../lib/lsp-client";
import { createLanguageServers, deriveBufferState, deriveFromError } from "./language-servers";

// Fixture tests: the port is a fake. They exercise store logic only, not real servers.
const row = (over: any = {}) => ({ server: "vtsls", root: "/w", state: { kind: "ready" }, installed: true, enabled: true, version: "1", epoch: 0, capabilities: null, ...over });
function setup(rows: any[]) {
  const l: Record<string, (e: any) => void> = {}; const stops = { n: 0 };
  const listen = (name: string) => async (fn: (e: any) => void) => { l[name] = fn; return () => { stops.n++; }; };
  const port: LspPort = {
    completion: vi.fn(), hover: vi.fn(), definition: vi.fn(), format: vi.fn(), cancel: vi.fn(), install: vi.fn(async () => null), restart: vi.fn(async () => null),
    status: vi.fn(async () => rows), onDiagnostics: listen("diag"), onState: listen("state"), onInstallProgress: listen("progress"), onError: listen("error"),
  } as any;
  return { port, l, stops };
}
const make = (port: LspPort) => createRoot(dispose => ({ store: createLanguageServers(port), dispose }));

describe("fixture: state derivation", () => {
  const e = (state: any) => ({ state, enabled: true, capabilities: null });
  it("derives each server state", () => {
    expect(deriveBufferState("vtsls", undefined).kind).toBe("unknown");
    expect(deriveBufferState("vtsls", { ...e({ kind: "ready" }), enabled: false }).kind).toBe("disabled");
    expect(deriveBufferState("vtsls", e({ kind: "starting" })).kind).toBe("starting");
    expect(deriveBufferState("vtsls", e({ kind: "installing" }), { phase: "downloading", received: 1, total: 4 })).toMatchObject({ kind: "installing", received: 1, total: 4 });
    expect(deriveBufferState("vtsls", e({ kind: "needsInstall", version: "1", sizeHint: 5 }))).toMatchObject({ kind: "needs-install", sizeHint: 5 });
    expect(deriveBufferState("vtsls", e({ kind: "installFailed", reason: "r", retryable: true }))).toMatchObject({ kind: "install-failed", retryable: true });
    expect(deriveBufferState("vtsls", e({ kind: "startFailed", reason: "r" })).kind).toBe("start-failed");
    expect(deriveBufferState("jdtls", e({ kind: "runtimeMissing", runtime: "Java", requiredVersion: 25, found: ["17"] }))).toMatchObject({ kind: "runtime-missing", found: ["17"] });
    expect(deriveBufferState("vtsls", e({ kind: "crashed" })).kind).toBe("crashed");
  });
  it("derives state from each error variant", () => {
    expect(deriveFromError({ kind: "unsupported", message: "" })).toEqual({ kind: "unsupported" });
    expect(deriveFromError({ kind: "notReady", message: "being installed" }, "vtsls")?.kind).toBe("installing");
    expect(deriveFromError({ kind: "notReady", message: "x" }, "vtsls")?.kind).toBe("starting");
    expect(deriveFromError({ kind: "needsInstall", server: "vtsls", version: "1", sizeHint: null })?.kind).toBe("needs-install");
    expect(deriveFromError({ kind: "installFailed", server: "vtsls", reason: "r", retryable: false })).toMatchObject({ kind: "install-failed", retryable: false });
    expect(deriveFromError({ kind: "startFailed", server: "vtsls", reason: "r" })?.kind).toBe("start-failed");
    expect(deriveFromError({ kind: "runtimeMissing", server: "jdtls", runtime: "Java", requiredVersion: 25, found: [] })?.kind).toBe("runtime-missing");
    expect(deriveFromError({ kind: "serverCrashed", message: "" }, "vtsls")?.kind).toBe("crashed");
    for (const kind of ["cancelled", "stale"] as const) expect(deriveFromError({ kind }, "vtsls")).toBeUndefined();
    expect(deriveFromError({ kind: "other", message: "" }, "vtsls")).toBeUndefined();
  });
});

describe("fixture: store events", () => {
  it("loads status, applies events, resets on restart and cleans up listeners", async () => {
    const { port, l, stops } = setup([row()]);
    const { store, dispose } = make(port);
    await store.init();
    expect(store.bufferState("src/a.ts", "/w").kind).toBe("ready");
    const reset = vi.fn(); store.onReset("vtsls", reset);
    (port.status as any).mockResolvedValue([row({ epoch: 1, state: { kind: "starting" } })]);
    l.state({ server: "vtsls", root: "/w", state: { kind: "starting" } });
    expect(store.bufferState("src/a.ts", "/w").kind).toBe("starting");
    expect(reset).toHaveBeenCalled();
    await store.refresh();
    expect(store.entryFor("vtsls")!.epoch).toBe(1);
    l.progress({ server: "vtsls", version: "1", phase: "downloading", received: 1, total: 2 });
    expect(store.progress("vtsls")).toMatchObject({ received: 1 });
    l.progress({ server: "vtsls", version: "1", phase: "finished" });
    expect(store.progress("vtsls")).toBeUndefined();
    l.error({ server: "vtsls", message: "oops" });
    expect(store.error()).toContain("oops");
    const seen = vi.fn(); store.onDiagnostics(seen); l.diag({ path: "a.ts" });
    expect(seen).toHaveBeenCalledOnce();
    dispose(); store.dispose();
    expect(stops.n).toBe(4);
    l.diag({ path: "a.ts" });
    expect(seen).toHaveBeenCalledOnce();
  });
  it("subscribes once and picks retry by state", async () => {
    const { port } = setup([row({ state: { kind: "installFailed", reason: "r", retryable: true } })]);
    const { store } = make(port);
    await Promise.all([store.init(), store.init()]);
    expect(port.status).toHaveBeenCalledTimes(1);
    await store.retry("vtsls");
    expect(port.install).toHaveBeenCalledWith("vtsls");
    await store.restart("vtsls");
    expect(port.restart).toHaveBeenCalledWith("vtsls");
    expect(store.bufferState("notes.md").kind).toBe("unsupported");
  });
  it("exposes epoch and capabilities only while ready", async () => {
    const caps = { completion: true, hover: true, definition: true, formatting: false, rangeFormatting: false, rename: false, references: false };
    const { port } = setup([row({ epoch: 3, capabilities: caps })]);
    const { store } = make(port); await store.init();
    const ctx = { workspaceRoot: () => "/w", getRevision: () => 0, isSynchronized: () => true, isActive: () => true, getWorkspaceGeneration: () => 0, openLocation: vi.fn(), notify: vi.fn() };
    const b = store.binding("src/a.ts", ctx)!;
    expect(b.getEpoch()).toBe(3);
    expect(b.getCapabilities()).toEqual(caps);
    expect(store.binding("a.md", ctx)).toBeUndefined();
  });
});

describe("fixture: background failures and hints", () => {
  it("shows a failed status read, forwards it to the toast hook and recovers on retry", async () => {
    const { port } = setup([row()]);
    (port.status as any).mockRejectedValueOnce(new Error("boom"));
    const onError = vi.fn();
    const store = createRoot(() => createLanguageServers(port, { onError }));
    await store.init();
    expect(store.statusError()).toContain("boom");
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(store.bufferState("src/a.ts", "/w").kind).toBe("unknown");
    await store.refresh();
    expect(store.statusError()).toBe("");
    expect(store.error()).toBe("");
    expect(store.bufferState("src/a.ts", "/w").kind).toBe("ready");
  });
  it("surfaces error events and failed commands with the server named", async () => {
    const { port, l } = setup([row()]);
    const onError = vi.fn();
    const store = createRoot(() => createLanguageServers(port, { onError }));
    await store.init();
    l.error({ server: "html", message: "oops" });
    expect(onError).toHaveBeenLastCalledWith("HTML language server: oops");
    expect(store.errorFor("html")).toContain("oops");
    expect(store.errorFor("vtsls")).toBe("");
    (port.restart as any).mockRejectedValueOnce({ kind: "startFailed", server: "vtsls", reason: "no node" });
    await store.restart("vtsls");
    expect(onError).toHaveBeenLastCalledWith(expect.stringContaining("Restarting vtsls failed: vtsls did not start: no node"));
    (port.install as any).mockRejectedValueOnce("denied");
    await store.install("vtsls");
    expect(store.errorFor("vtsls")).toContain("Installing vtsls failed: denied");
  });
  it("lets a request failure hint win over a healthy state until a success or a restart", async () => {
    const { port } = setup([row({ state: { kind: "notStarted" } })]);
    const store = createRoot(() => createLanguageServers(port));
    await store.init();
    const ctx = { workspaceRoot: () => "/w", getRevision: () => 0, isSynchronized: () => true, isActive: () => true, getWorkspaceGeneration: () => 0, openLocation: vi.fn(), notify: vi.fn() };
    const b = store.binding("src/a.ts", ctx)!;
    expect(store.bufferState("src/a.ts", "/w").kind).toBe("idle");
    b.reportError!({ kind: "startFailed", server: "vtsls", reason: "bad" });
    expect(store.bufferState("src/a.ts", "/w")).toMatchObject({ kind: "start-failed", reason: "bad" });
    await store.refresh();
    expect(store.bufferState("src/a.ts", "/w").kind).toBe("start-failed");
    b.reportOk!();
    expect(store.bufferState("src/a.ts", "/w").kind).toBe("idle");
    b.reportError!({ kind: "serverCrashed", message: "x" });
    expect(store.bufferState("src/a.ts", "/w").kind).toBe("crashed");
    (port.status as any).mockResolvedValue([row({ state: { kind: "notStarted" }, epoch: 1 })]);
    await store.refresh();
    expect(store.bufferState("src/a.ts", "/w").kind).toBe("idle");
  });
  it("lets a state the server reports as failed beat a hint", async () => {
    const { port } = setup([row({ state: { kind: "crashed" } })]);
    const store = createRoot(() => createLanguageServers(port));
    await store.init();
    store.noteError("src/a.ts", { kind: "startFailed", server: "vtsls", reason: "old" });
    expect(store.bufferState("src/a.ts", "/w").kind).toBe("crashed");
  });
});

describe("fixture: per folder resets", () => {
  const two = () => [row({ root: "/a" }), row({ root: "/b" })];
  it("resets only the views of the folder that changed", async () => {
    const { port, l } = setup(two());
    const store = createRoot(() => createLanguageServers(port));
    await store.init();
    const a = vi.fn(); const b = vi.fn(); const unknown = vi.fn();
    store.onReset("vtsls", a, () => "/a"); store.onReset("vtsls", b, () => "/b"); store.onReset("vtsls", unknown, () => null);
    l.state({ server: "vtsls", root: "/a", state: { kind: "starting" } });
    expect(a).toHaveBeenCalledOnce(); expect(unknown).toHaveBeenCalledOnce(); expect(b).not.toHaveBeenCalled();
    // A restart seen only through a new epoch of one folder behaves the same.
    (port.status as any).mockResolvedValue([row({ root: "/a" }), row({ root: "/b", epoch: 5 })]);
    await store.refresh();
    expect(b).toHaveBeenCalledOnce(); expect(a).toHaveBeenCalledOnce();
  });
  it("applies an event for an unseen folder only to a row without a folder", async () => {
    const { port, l } = setup([row({ root: "/a" }), row({ root: "/b", state: { kind: "starting" } })]);
    const store = createRoot(() => createLanguageServers(port));
    await store.init();
    l.state({ server: "vtsls", root: "/new", state: { kind: "needsInstall", version: "1" } });
    expect(store.entries.vtsls.map(r => r.state.kind)).toEqual(["ready", "starting"]);
    const { port: p2, l: l2 } = setup([row({ root: null })]);
    const s2 = createRoot(() => createLanguageServers(p2));
    await s2.init();
    l2.state({ server: "vtsls", root: "/new", state: { kind: "starting" } });
    expect(s2.entries.vtsls[0].state.kind).toBe("starting");
  });
});

describe("fixture: diagnostics replay cache", () => {
  const published = (path: string, revision = 1) => ({ path, revision, diagnostics: [{ message: "m", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] });
  it("keeps the latest set per path and drops it on restart, prune and dispose", async () => {
    const { port, l } = setup([row()]);
    const store = createRoot(() => createLanguageServers(port));
    await store.init();
    l.diag(published("a.ts", 1)); l.diag(published("a.ts", 2)); l.diag(published("b.ts"));
    expect(store.latestDiagnostics("a.ts")!.revision).toBe(2);
    const ctx = { workspaceRoot: () => "/w", getRevision: () => 0, isSynchronized: () => true, isActive: () => true, getWorkspaceGeneration: () => 0, openLocation: vi.fn(), notify: vi.fn() };
    expect(store.binding("a.ts", ctx)!.getLatestDiagnostics!()!.revision).toBe(2);
    l.diag({ path: "a.ts", revision: 3, diagnostics: [] });
    expect(store.latestDiagnostics("a.ts")).toBeUndefined();
    store.pruneDiagnostics(path => path !== "b.ts");
    expect(store.latestDiagnostics("b.ts")).toBeUndefined();
    l.diag(published("a.ts")); l.diag(published("m.rs"));
    l.state({ server: "vtsls", root: "/w", state: { kind: "crashed" } });
    expect(store.latestDiagnostics("a.ts")).toBeUndefined();
    expect(store.latestDiagnostics("m.rs")).toBeDefined();
    store.pruneDiagnostics();
    expect(store.latestDiagnostics("m.rs")).toBeUndefined();
  });
  it("bounds the cache", async () => {
    const { port, l } = setup([row()]);
    const store = createRoot(() => createLanguageServers(port));
    await store.init();
    for (let i = 0; i < 300; i++) l.diag(published(`f${i}.ts`));
    expect(store.latestDiagnostics("f0.ts")).toBeUndefined();
    expect(store.latestDiagnostics("f299.ts")).toBeDefined();
  });
});
