import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import type { RunApprovalRequest } from "../bindings";
import { api } from "../lib/client";

export function createRunApprovals(options: { available: boolean; generation: () => number; blocked: () => boolean }) {
  const [pending, setPending] = createSignal<RunApprovalRequest[]>([]);
  const [enabled, setEnabled] = createSignal(false);
  const [loaded, setLoaded] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [resolving, setResolving] = createSignal<string>();
  let disposed = false; let version = 0; let snapshotVersion = 0; let unlisten: (() => void) | undefined;
  const fail = (cause: unknown) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); };
  async function refresh() {
    if (!options.available) return;
    const token = version; const before = snapshotVersion;
    try { const requests = await api.pendingRunApprovals(); if (!disposed && token === version && before === snapshotVersion) setPending(requests); } catch (cause) { if (token === version) fail(cause); }
  }
  async function setAllowed(value: boolean) {
    if (busy() || !options.available) return;
    setBusy(true); setError("");
    try { await api.runToolsSetEnabled(value); if (!disposed) setEnabled(value); }
    catch (cause) { fail(cause); }
    finally { if (!disposed) setBusy(false); }
  }
  async function resolve(id: string, allow: boolean) {
    if (resolving() || options.blocked() || !pending().some(request => request.id === id)) return;
    const token = version; setResolving(id); setError("");
    try { await api.resolveRunApproval(id, allow); if (!disposed && token === version) { snapshotVersion++; setPending(values => values.filter(value => value.id !== id)); } }
    catch (cause) { if (token === version && pending().some(request => request.id === id)) fail(cause); }
    finally { if (!disposed && token === version) setResolving(undefined); }
  }
  onMount(() => {
    if (!options.available) return;
    void api.runToolsEnabled().then(value => { if (!disposed) { setEnabled(value); setLoaded(true); } }).catch(fail);
    void api.onRunApprovalsChanged(requests => { snapshotVersion++; if (!disposed) setPending(requests); }).then(stop => { if (disposed) stop(); else { unlisten = stop; void refresh(); } }).catch(fail);
  });
  createEffect(on(options.generation, () => { version++; snapshotVersion++; setPending([]); setResolving(undefined); setError(""); void refresh(); }, { defer: true }));
  onCleanup(() => { disposed = true; version++; unlisten?.(); });
  return { pending, enabled, loaded, busy, error, resolving, setAllowed, resolve };
}
export type RunApprovals = ReturnType<typeof createRunApprovals>;
