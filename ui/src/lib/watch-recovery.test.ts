import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import type { LspPort } from "./lsp-client";
import { createLanguageServers, WATCH_REFRESHED_MS } from "../stores/language-servers";
import { buildHubView, type HubSnapshot } from "../stores/language-intelligence";
import { isSilenced, RESTART_LABEL, SILENCE_LABEL, watchWarningNotification } from "./watch-recovery";

// Fixture tests: the port is a fake. They cover the store, the popover line and the toast, not a real vtsls.
function setup() {
  const l: Record<string, (e: any) => void> = {};
  const listen = (name: string) => async (fn: (e: any) => void) => { l[name] = fn; return () => undefined; };
  const port = {
    completion: vi.fn(), hover: vi.fn(), definition: vi.fn(), format: vi.fn(), cancel: vi.fn(), install: vi.fn(async () => null), restart: vi.fn(async () => null),
    status: vi.fn(async () => [{ server: "vtsls", root: "/w", state: { kind: "ready" }, installed: true, enabled: true, version: "1", epoch: 0, capabilities: null }]),
    onDiagnostics: listen("diag"), onState: listen("state"), onInstallProgress: listen("progress"), onError: listen("error"), onWatchRecovery: listen("watch"),
  } as unknown as LspPort;
  return { port, l };
}

afterEach(() => { vi.useRealTimers(); });

describe("fixture: watch recovery", () => {
  it("shows refresh lines quietly and forwards only the exhausted warning", async () => {
    vi.useFakeTimers();
    const { port, l } = setup();
    const onWatchWarning = vi.fn();
    const onError = vi.fn();
    const store = createRoot(() => createLanguageServers(port, { onWatchWarning, onError }));
    await store.init();
    l.watch({ server: "vtsls", phase: "refreshing", message: "Refreshing TypeScript server" });
    expect(store.watchStatus("vtsls")).toBe("Refreshing TypeScript server");
    l.watch({ server: "vtsls", phase: "refreshed", message: "TypeScript (vtsls) fell behind on file changes and was refreshed." });
    expect(store.watchStatus("vtsls")).toContain("was refreshed");
    vi.advanceTimersByTime(WATCH_REFRESHED_MS);
    expect(store.watchStatus("vtsls")).toBeUndefined();
    expect(onWatchWarning).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(store.error()).toBe("");
    l.watch({ server: "vtsls", phase: "exhausted", message: "TypeScript keeps falling behind on file changes." });
    expect(onWatchWarning).toHaveBeenCalledWith({ server: "vtsls", message: "TypeScript keeps falling behind on file changes." });
    expect(store.watchStatus("vtsls")).toBeUndefined();
    // A manual restart drops a stale refresh line.
    l.watch({ server: "vtsls", phase: "refreshing", message: "Refreshing TypeScript server" });
    await store.restart("vtsls");
    expect(store.watchStatus("vtsls")).toBeUndefined();
    store.dispose();
  });

  it("puts the refresh line in the popover status for a running server", () => {
    const snapshot: HubSnapshot = {
      hasFile: true, fileServer: "vtsls", autoInstall: true, dismissedTrust: new Set(), trustRestarting: false, preview: false,
      servers: [{ id: "vtsls", state: { kind: "ready", server: "vtsls" }, activity: [], watch: "Refreshing TypeScript server" }],
    };
    const card = buildHubView(snapshot).card!;
    expect(card.status).toBe("Refreshing TypeScript server");
    expect(card.actions.map(action => action.id)).toEqual(["restart"]);
    const failed = buildHubView({ ...snapshot, servers: [{ ...snapshot.servers[0], state: { kind: "crashed", server: "vtsls" } }] }).card!;
    expect(failed.status).not.toBe("Refreshing TypeScript server");
  });

  it("offers a one-click restart and a per-server opt-out in user settings", async () => {
    const restart = vi.fn(async () => undefined);
    const saveSilenced = vi.fn(async () => undefined);
    let silenced: string[] = ["css"];
    const toast = watchWarningNotification({ server: "vtsls", message: "m" }, { restart, silenced: () => silenced, saveSilenced, onError: vi.fn() });
    expect(toast).toMatchObject({ level: "warning", sticky: true, key: "lsp-watch:vtsls", message: "m" });
    expect(toast.actions!.map(action => action.label)).toEqual([RESTART_LABEL, SILENCE_LABEL]);
    toast.actions![0].run();
    expect(restart).toHaveBeenCalledWith("vtsls");
    toast.actions![1].run();
    expect(saveSilenced).toHaveBeenCalledWith(["css", "vtsls"]);
    silenced = ["css", "vtsls"];
    expect(isSilenced("vtsls", silenced)).toBe(true);
    toast.actions![1].run();
    expect(saveSilenced).toHaveBeenCalledOnce();
  });
});
