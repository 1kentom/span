// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { RunCatalog_Serialize as RunCatalog, RunConfiguration_Serialize as RunConfiguration, RunEvent_Deserialize as RunEvent, RunInfo_Serialize as RunInfo } from "../bindings";
import { createRunWorkbench } from "./runs";
import { RunOutput } from "../components/RunOutput";
const disposers: (() => void)[] = [];
beforeEach(() => { const values = new Map<string, string>(); vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear() }); });
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); localStorage.clear(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const configuration: RunConfiguration = { id: "saved", name: "Application", executable: "node", args: ["app.js"], cwd: ".", env: {} };
const info = (id: string, status: RunInfo["status"] = "running"): RunInfo => ({ id, workspaceEpoch: 7, configurationId: "saved", name: "Application", status, exitCode: status === "exited" ? 0 : null, error: null });
const settle = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
function setup() {
  const [root, setRoot] = createSignal("/workspace"); const [generation, setGeneration] = createSignal(1);
  let listener: ((event: RunEvent) => void) | undefined;
  let globalListener: ((event: RunEvent) => void) | undefined;
  const transport = {
    runConfigurations: vi.fn(async (): Promise<RunCatalog> => ({ workspaceRoot: root(), configurations: [configuration, { ...configuration, id: "second", name: "Second" }], detected: [] })),
    saveRunConfiguration: vi.fn(async (value: RunConfiguration, _root: string) => value), deleteRunConfiguration: vi.fn(async (_id: string, _root: string) => {}), duplicateRunConfiguration: vi.fn(async (_id: string, _root: string) => ({ ...configuration, id: "copy" })),
    startRun: vi.fn(async (_value: RunConfiguration, _root: string, callback: (event: RunEvent) => void) => { listener = callback; return info("run-1"); }),
    stopRun: vi.fn(async (id: string) => info(id, "stopped")), restartRun: vi.fn(async (_id: string, callback: (event: RunEvent) => void) => { listener = callback; return info("run-2"); }),
    onRunEvent: vi.fn(async (callback: (event: RunEvent) => void) => { globalListener = callback; return vi.fn(); }),
    runContext: vi.fn(async () => ({ workspaceRoot: root(), workspaceEpoch: generation() + 6, runs: [] as RunInfo[] })),
    listRuns: vi.fn(async (): Promise<RunInfo[]> => []), runOutput: vi.fn(async (id: string) => ({ id, text: "history", truncated: false })), acknowledgeRun: vi.fn(async (_id: string, _sequence: number) => {}),
  };
  const reveal = vi.fn(); const store = createRoot(dispose => { disposers.push(dispose); return createRunWorkbench({ generation, root, blocked: () => false, available: true, onReveal: reveal, transport }); });
  return { store, transport, reveal, root, switchWorkspace: () => { setRoot("/other"); setGeneration(2); }, event: (event: RunEvent) => listener?.(event), globalEvent: (event: RunEvent) => globalListener?.(event) };
}
describe("run workbench", () => {
  it("loads and selects without execution, persists selection by workspace, and sends exact root/argv only on Run", async () => {
    const view = setup(); await settle(); expect(view.transport.startRun).not.toHaveBeenCalled();
    view.store.setSelectedId("second"); expect(localStorage.getItem("span:run-selected:/workspace")).toBe("second");
    await view.store.launch(); expect(view.transport.startRun).toHaveBeenCalledWith(expect.objectContaining({ id: "second", args: ["app.js"] }), "/workspace", expect.any(Function)); expect(view.reveal).toHaveBeenCalledOnce();
    const second = setup(); await settle(); expect(second.store.selectedId()).toBe("second");
  });
  it("single-flights Start and preserves early output and terminal state before its response", async () => {
    const view = setup(); await settle(); let release!: (value: RunInfo) => void; let event!: (value: RunEvent) => void;
    view.transport.startRun.mockImplementationOnce(async (_value, _root, callback) => { event = callback; return new Promise(resolve => { release = resolve; }); });
    const first = view.store.launch(); await view.store.launch(); await view.store.launch(); expect(view.transport.startRun).toHaveBeenCalledOnce();
    event({ kind: "output", workspaceEpoch: 7, id: "early", sequence: 1, stream: "stderr", text: "real stderr" }); event({ kind: "state", run: info("early", "exited") });
    release(info("early")); await first; await settle();
    expect(view.store.selectedRun()?.status).toBe("exited"); expect(view.store.outputs().early.chunks[0]).toEqual({ stream: "stderr", text: "real stderr" }); expect(view.transport.acknowledgeRun).toHaveBeenCalledWith("early", 1);
  });
  it("surfaces launch errors, retries, and uses actual stop/restart responses", async () => {
    const view = setup(); await settle(); view.transport.startRun.mockRejectedValueOnce(new Error("Executable was not found")); await view.store.launch(); expect(view.store.error()).toContain("not found");
    await view.store.launch(); await view.store.stop(); expect(view.transport.stopRun).toHaveBeenCalledWith("run-1"); expect(view.store.selectedRun()?.status).toBe("stopped");
    await view.store.launch(true); expect(view.transport.restartRun).toHaveBeenCalledWith("run-1", expect.any(Function)); expect(view.store.selectedRun()?.id).toBe("run-2");
  });
  it("rejects wrong-workspace catalogs and ignores late launch events/results after switching", async () => {
    const view = setup(); await settle(); view.transport.runConfigurations.mockResolvedValueOnce({ workspaceRoot: "/unrelated", configurations: [configuration], detected: [] }); await view.store.reload(); expect(view.store.error()).toContain("different workspace");
    let release!: (value: RunInfo) => void; let event!: (value: RunEvent) => void;
    view.transport.startRun.mockImplementationOnce(async (_value, _root, callback) => { event = callback; return new Promise(resolve => { release = resolve; }); });
    const pending = view.store.launch(); view.switchWorkspace(); await settle(); event({ kind: "output", workspaceEpoch: 7, id: "old", sequence: 7, stream: "stdout", text: "old workspace output" }); release(info("old")); await pending; await settle();
    expect(view.store.runs()).toEqual([]); expect(view.store.outputs().old).toBeUndefined(); expect(view.transport.acknowledgeRun).toHaveBeenCalledWith("old", 7);
  });
  it("rejects stale mutation results without writing new-workspace selection", async () => {
    const view = setup(); await settle(); let release!: (value: RunConfiguration) => void;
    view.transport.saveRunConfiguration.mockImplementationOnce(async () => new Promise(resolve => { release = resolve; }));
    const save = view.store.save(configuration); view.switchWorkspace(); await settle(); release({ ...configuration, id: "old-copy" });
    await expect(save).rejects.toThrow("workspace changed"); expect(view.transport.saveRunConfiguration).toHaveBeenCalledWith(configuration, "/workspace"); expect(view.store.selectedId()).not.toBe("old-copy");
  });
  it("updates independent run IDs without treating a stopped run as active", async () => {
    const view = setup(); await settle(); await view.store.launch(); await view.store.launch(true); expect(view.store.runs().map(value => value.id)).toEqual(["run-1", "run-2"]);
    view.event({ kind: "state", run: info("run-2", "stopped") }); expect(view.store.running()).toBe(true);
    view.event({ kind: "state", run: info("run-1", "exited") }); expect(view.store.running()).toBe(false);
  });
  it("renders output as inert text, labels stderr/stopped state, and bounds display memory", async () => {
    const view = setup(); await settle(); await view.store.launch();
    const root = document.createElement("div"); document.body.append(root); disposers.push(render(() => <RunOutput workbench={view.store} available={true} />, root));
    view.event({ kind: "output", workspaceEpoch: 7, id: "run-1", sequence: 1, stream: "stderr", text: '<script>danger()</script>\x1b[31m' }); view.event({ kind: "state", run: info("run-1", "stopped") });
    expect(root.querySelector("script")).toBeNull(); expect(root.textContent).toContain('danger()</script>\\x1b[31m'); expect(root.querySelector(".run-output-stderr")).not.toBeNull(); expect(root.textContent).toContain("Stopped");
    view.event({ kind: "output", workspaceEpoch: 7, id: "run-1", sequence: 2, stream: "stdout", text: "x".repeat(1_048_580) + "end" }); expect(view.store.outputs()["run-1"].trimmed).toBe(true); expect(view.store.outputs()["run-1"].chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)).toBeLessThanOrEqual(1_048_576);
  });
  it("buffers agent output until coherent context arrives, then ACKs without accepting old epochs", async () => {
    const view = setup(); let release!: (context: { workspaceRoot: string; workspaceEpoch: number; runs: RunInfo[] }) => void;
    view.transport.runContext.mockImplementationOnce(async () => new Promise(resolve => { release = resolve; })); await settle();
    view.globalEvent({ kind: "state", run: info("agent-run") });
    view.globalEvent({ kind: "output", workspaceEpoch: 7, id: "agent-run", sequence: 1, stream: "stdout", text: "agent process output" });
    expect(view.store.runs()).toEqual([]); expect(view.transport.acknowledgeRun).not.toHaveBeenCalled();
    release({ workspaceRoot: "/workspace", workspaceEpoch: 7, runs: [] }); await settle();
    expect(view.store.selectedRun()?.id).toBe("agent-run"); expect(view.store.outputs()["agent-run"].chunks[0].text).toContain("agent process"); expect(view.transport.acknowledgeRun).toHaveBeenCalledWith("agent-run", 1);
    view.switchWorkspace(); await settle();
    view.globalEvent({ kind: "state", run: info("stale-agent") });
    view.globalEvent({ kind: "output", workspaceEpoch: 7, id: "stale-agent", sequence: 2, stream: "stderr", text: "old queued bus event" }); await settle();
    expect(view.store.runs()).toEqual([]); expect(view.store.outputs()["stale-agent"]).toBeUndefined(); expect(view.transport.acknowledgeRun).toHaveBeenCalledWith("stale-agent", 2);
  });

  it("caps forty completed runs and their output while preserving active sessions", async () => {
    const view = setup(); await settle(); view.globalEvent({ kind: "state", run: info("active") });
    view.globalEvent({ kind: "output", workspaceEpoch: 7, id: "active", sequence: 1, stream: "stdout", text: "kept active" });
    for (let index = 0; index < 40; index++) {
      const id = `complete-${index}`; view.globalEvent({ kind: "state", run: info(id, "exited") });
      view.globalEvent({ kind: "output", workspaceEpoch: 7, id, sequence: 1, stream: "stdout", text: `output ${index}` });
    }
    expect(view.store.runs()).toHaveLength(32); expect(view.store.runs().some(run => run.id === "active")).toBe(true);
    expect(view.store.outputs().active.chunks[0].text).toBe("kept active"); expect(Object.keys(view.store.outputs())).toHaveLength(32);
    expect(view.store.outputs()["complete-0"]).toBeUndefined();
    view.globalEvent({ kind: "output", workspaceEpoch: 7, id: "complete-0", sequence: 2, stream: "stdout", text: "late retired output" });
    expect(view.store.outputs()["complete-0"]).toBeUndefined();
    view.globalEvent({ kind: "state", run: info("complete-0", "exited") }); expect(view.store.selectedRun()?.id).toBe("complete-39");
  });

});
