import { batch, createEffect, createSignal, on, onCleanup } from "solid-js";
import type { RunCatalog_Serialize as RunCatalog, RunConfiguration_Serialize as RunConfiguration, RunEvent_Deserialize as RunEvent, RunInfo_Serialize as RunInfo } from "../bindings";
import { api } from "../lib/client";

type RunTransport = Pick<typeof api, "runConfigurations" | "saveRunConfiguration" | "deleteRunConfiguration" | "duplicateRunConfiguration" | "startRun" | "stopRun" | "restartRun" | "listRuns" | "runOutput" | "acknowledgeRun" | "onRunEvent" | "runContext">;
export type RunOutputChunk = { stream: "stdout" | "stderr" | "history"; text: string };
export type RunOutputView = { chunks: RunOutputChunk[]; trimmed: boolean };
const emptyCatalog = (): RunCatalog => ({ workspaceRoot: "", configurations: [], detected: [] });
const active = (run: RunInfo) => run.status === "running" || run.status === "stopping";
export function createRunWorkbench(options: { generation: () => number; root: () => string | undefined; blocked: () => boolean; available: boolean; onReveal: () => void; transport?: RunTransport }) {
  const transport = options.transport ?? api;
  const [catalog, setCatalog] = createSignal<RunCatalog>(emptyCatalog());
  const [runs, setRuns] = createSignal<RunInfo[]>([]);
  const [selectedId, setSelectedId] = createSignal<string>();
  const remembered = () => { try { return localStorage.getItem(`span:run-selected:${options.root()}`) || undefined; } catch { return undefined; } };
  function selectConfiguration(id: string | undefined) { setSelectedId(id); if (options.root()) try { if (id) localStorage.setItem(`span:run-selected:${options.root()}`, id); else localStorage.removeItem(`span:run-selected:${options.root()}`); } catch { /* Selection remains usable when UI preference storage is unavailable. */ } }
  const [selectedRunId, setSelectedRunId] = createSignal<string>();
  const [outputs, setOutputs] = createSignal<Record<string, RunOutputView>>({});
  const [loading, setLoading] = createSignal(false);
  const [contextLoading, setContextLoading] = createSignal(false);
  let retryContext: () => Promise<void> = async () => {};
  const [contextEpoch, setContextEpoch] = createSignal<number>();
  let earlyGlobal: RunEvent[] = [];
  const [operation, setOperation] = createSignal<string>();
  const [error, setError] = createSignal("");
  const retired = new Set<string>();
  let epoch = 0; let loadRequest = 0; let disposed = false;
  const live = (token: number) => !disposed && token === epoch;
  const selectedConfiguration = () => catalog().configurations.find(value => value.id === selectedId()) || catalog().detected.find(value => value.configuration.id === selectedId())?.configuration;
  const selectedRun = () => runs().find(value => value.id === selectedRunId());
  const running = () => runs().some(active);
  const report = (cause: unknown, token = epoch) => { if (live(token)) setError(cause instanceof Error ? cause.message : String(cause)); };
  function assertReady(token: number) { if (!live(token) || options.blocked() || !options.root() || !options.available || contextEpoch() === undefined) throw new Error("Open a ready desktop workspace to manage or run configurations."); }
  function updateRun(run: RunInfo) {
    if (retired.has(run.id)) return;
    const previous = runs(); const current = previous.find(value => value.id === run.id);
    if (current && ((!active(current) && active(run)) || current.status === "stopping" && run.status === "running")) return;
    const next = [...previous.filter(value => value.id !== run.id), run]; const removed: string[] = [];
    while (next.length > 32) {
      const index = next.findIndex(value => !active(value) && value.id !== selectedRunId());
      if (index < 0) break;
      const [old] = next.splice(index, 1); removed.push(old.id); retired.add(old.id);
      if (retired.size > 64) retired.delete(retired.values().next().value!);
    }
    batch(() => { setRuns(next); if (removed.length) setOutputs(previous => { const result = { ...previous }; removed.forEach(id => delete result[id]); return result; }); });
  }
  function append(id: string, chunk: RunOutputChunk) {
    if (retired.has(id)) return;
    setOutputs(previous => {
      const before = previous[id] ?? { chunks: [], trimmed: false }; let chunks = [...before.chunks, chunk]; let size = chunks.reduce((total, value) => total + value.text.length, 0); let trimmed = before.trimmed;
      while (chunks.length > 2000 || size > 1_048_576) { const first = chunks[0]; const excess = Math.max(size - 1_048_576, 0); if (chunks.length === 1 && excess) { chunks = [{ ...first, text: first.text.slice(excess) }]; size = 1_048_576; } else { size -= first.text.length; chunks.shift(); } trimmed = true; }
      const result = { ...previous, [id]: { chunks, trimmed } };
      const orphaned = Object.keys(result).filter(key => key !== id && key !== selectedRunId() && !runs().some(run => run.id === key));
      while (Object.keys(result).length > 36 && orphaned.length) delete result[orphaned.shift()!];
      return result;
    });
  }
  function acknowledge(event: Extract<RunEvent, { kind: "output" }>, token: number) {
    queueMicrotask(() => { void transport.acknowledgeRun(event.id, event.sequence).catch(cause => { if (live(token)) report(cause, token); }); });
  }
  function events(token: number, external = false) {
    return (event: RunEvent) => {
      const eventEpoch = event.kind === "output" ? event.workspaceEpoch : event.run.workspaceEpoch;
      if (!live(token)) { if (event.kind === "output") acknowledge(event, token); return; }
      if (external && contextEpoch() === undefined) { if (earlyGlobal.length < 64) earlyGlobal.push(event); else if (event.kind === "output") acknowledge(event, token); return; }
      if (contextEpoch() !== eventEpoch) { if (event.kind === "output") acknowledge(event, -1); return; }
      if (event.kind === "output") { append(event.id, { stream: event.stream, text: event.text }); acknowledge(event, token); }
      else { if (retired.has(event.run.id)) return; const first = !runs().some(run => run.id === event.run.id); updateRun({ ...event.run, exitCode: event.run.exitCode ?? null, error: event.run.error ?? null }); if (external && first) { setSelectedRunId(event.run.id); options.onReveal(); } }
    };
  }
  async function reload() {
    const token = epoch; const request = ++loadRequest;
    if (!options.available || !options.root()) return;
    setLoading(true); setError("");
    try { const next = await transport.runConfigurations(); if (!live(token) || request !== loadRequest) return; if (next.workspaceRoot !== options.root()) throw new Error("Run configurations belong to a different workspace. Refresh after the folder finishes opening."); setCatalog(next); const ids = [...next.configurations, ...next.detected.map(value => value.configuration)].map(value => value.id); const preferred = selectedId() || remembered(); selectConfiguration(preferred && ids.includes(preferred) ? preferred : ids[0]); }
    catch (cause) { report(cause, token); }
    finally { if (live(token) && request === loadRequest) setLoading(false); }
  }
  async function mutation<T>(name: string, action: (root: string) => Promise<T>): Promise<T> {
    const token = epoch; assertReady(token);
    if (operation()) throw new Error("Wait for the current run action to finish.");
    setOperation(name); setError("");
    try { const value = await action(options.root()!); if (!live(token)) throw new Error("The workspace changed before this action completed."); await reload(); if (!live(token)) throw new Error("The workspace changed before this action completed."); return value; }
    catch (cause) { report(cause, token); throw cause; }
    finally { if (live(token)) setOperation(undefined); }
  }
  const save = (value: RunConfiguration) => mutation("save", root => transport.saveRunConfiguration(value, root));
  const duplicate = (id: string) => mutation("duplicate", root => transport.duplicateRunConfiguration(id, root));
  const remove = (id: string) => mutation("delete", root => transport.deleteRunConfiguration(id, root));
  async function launch(restart = false) {
    if (operation()) return;
    const token = epoch;
    try {
      assertReady(token);
      const configuration = selectedConfiguration(); const prior = selectedRun();
      if (restart && !prior) throw new Error("Select an existing run to restart.");
      if (!restart && !configuration) throw new Error("Select a run configuration first.");
      if (!restart && running()) throw new Error("Stop the current run before starting another configuration.");
      setOperation(restart ? "restart" : "start"); setError(""); if (!restart) setSelectedRunId(undefined); options.onReveal();
      const result = restart ? await transport.restartRun(prior!.id, events(token)) : await transport.startRun(configuration!, options.root()!, events(token));
      if (live(token)) { updateRun(result); if (runs().some(run => run.id === result.id)) setSelectedRunId(result.id); }
    } catch (cause) { report(cause, token); }
    finally { if (live(token)) setOperation(undefined); }
  }
  async function stop() {
    const run = selectedRun(); const token = epoch; if (!run || !active(run) || operation()) return;
    try { assertReady(token); setOperation("stop"); setError(""); const result = await transport.stopRun(run.id); if (live(token)) updateRun(result); }
    catch (cause) { report(cause, token); }
    finally { if (live(token)) setOperation(undefined); }
  }
  async function selectRun(id: string) {
    if (!runs().some(value => value.id === id)) return;
    setSelectedRunId(id); const token = epoch;
    if (outputs()[id]) return;
    try { const result = await transport.runOutput(id); if (live(token) && !outputs()[id]) setOutputs(previous => ({ ...previous, [id]: { chunks: [{ stream: "history", text: result.text }], trimmed: result.truncated } })); }
    catch (cause) { report(cause, token); }
  }
  createEffect(on(() => [options.generation(), options.root()] as const, () => {
    const token = ++epoch; loadRequest++; setCatalog(emptyCatalog()); setRuns([]); setContextEpoch(undefined); setContextLoading(false); earlyGlobal = []; retired.clear(); setOutputs({}); setSelectedId(undefined); setSelectedRunId(undefined); setOperation(undefined); setLoading(false); setError(""); retryContext = async () => {};
    let unsubscribe: (() => void) | undefined;
    onCleanup(() => unsubscribe?.());
    if (options.available && options.root()) {
      void reload();
      let contextLoad: Promise<void> | undefined;
      retryContext = () => {
        if (contextLoad) return contextLoad;
        setContextLoading(true);
        contextLoad = (async () => {
          if (!unsubscribe) { const stop = await transport.onRunEvent(events(token, true)); if (!live(token)) { stop(); return; } unsubscribe = stop; }
          const context = await transport.runContext();
          if (!live(token)) return;
          if (context.workspaceRoot !== options.root()) throw new Error("Run service belongs to a different workspace. Reopen Run after the folder finishes opening.");
          if (contextEpoch() !== undefined && contextEpoch() !== context.workspaceEpoch) { setRuns([]); setOutputs({}); setSelectedRunId(undefined); }
          setContextEpoch(context.workspaceEpoch);
          context.runs.forEach(updateRun);
          const pending = earlyGlobal; earlyGlobal = [];
          pending.forEach(events(token, true));
          const last = runs().at(-1); if (last && !selectedRunId()) void selectRun(last.id);
        })().catch(cause => report(cause, token)).finally(() => { contextLoad = undefined; if (live(token)) setContextLoading(false); });
        return contextLoad;
      };
      void retryContext();
    }
  }));
  onCleanup(() => { disposed = true; epoch++; });
  return { catalog, runs, selectedId, setSelectedId: selectConfiguration, selectedRunId, selectedRun, selectedConfiguration, selectRun, outputs, loading: () => loading() || contextLoading(), operation, error, setError, running, reload, retry: async () => { setError(""); await Promise.all([reload(), retryContext()]); }, save, duplicate, remove, launch, stop, clearOutput: () => { const id = selectedRunId(); if (id) setOutputs(previous => ({ ...previous, [id]: { chunks: [], trimmed: false } })); } };
}
export type RunWorkbench = ReturnType<typeof createRunWorkbench>;
