import { createMemo, createSignal, onCleanup } from "solid-js";
import type { AgentPreset_Serialize, InstalledAgent, RegistryAgent } from "../../bindings";
import { agentPresets, api, isDesktop } from "../client";
import { buildAgentCatalog, curatedAgent, type CatalogRow } from "../acp-catalog";
import type { Failure } from "../agent-session";
import { sharedStore } from "./shared";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Reports a failure where the user is looking (the open chat's error card). */
export type ReportFailure = (failure: Failure) => void;

/**
 * Installed agents, the ACP registry, backend presets and installs in flight (app-wide, ADR 0011 phase 2). Installs
 * keep their own row state, so a result lands on its row whatever the chat does meanwhile.
 */
export function createAgentCatalog() {
  const [installed, setInstalled] = createSignal<InstalledAgent[]>([]);
  const [registry, setRegistry] = createSignal<RegistryAgent[]>([]);
  const [presets, setPresets] = createSignal<AgentPreset_Serialize[]>([]);
  const [registryBusy, setRegistryBusy] = createSignal(false);
  /** Registry ids being installed. Each install keeps its own row state, so other rows stay usable meanwhile. */
  const [installingIds, setInstallingIds] = createSignal<string[]>([]);
  const [installErrors, setInstallErrors] = createSignal<Record<string, string>>({});
  /** The first install in flight, for views that show one install at a time. */
  const installing = () => installingIds()[0];
  const [catalogSearch, setCatalogSearch] = createSignal("");
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  /**
   * An installed-agent read started before an install or removal finished must not overwrite that change, so reads
   * and mutations each carry a generation and a stale snapshot is dropped.
   */
  let installedReadGeneration = 0;
  let installedMutationGeneration = 0;

  function beginInstalledRead() {
    return { read: ++installedReadGeneration, mutation: installedMutationGeneration };
  }
  function applyInstalledSnapshot(token: ReturnType<typeof beginInstalledRead>, snapshot: InstalledAgent[]) {
    if (disposed || token.read !== installedReadGeneration || token.mutation !== installedMutationGeneration) return false;
    setInstalled(snapshot);
    return true;
  }
  function commitInstalledMutation(change: (current: InstalledAgent[]) => InstalledAgent[]) {
    installedMutationGeneration += 1;
    installedReadGeneration += 1;
    setInstalled(change(installed()));
  }
  function upsertInstalled(current: InstalledAgent[], incoming: InstalledAgent) {
    const index = current.findIndex((entry) => entry.id === incoming.id);
    if (index < 0) return [...current, incoming];
    return current.map((entry, currentIndex) => (currentIndex === index ? incoming : entry));
  }

  async function loadAgents(fail: ReportFailure) {
    if (!isDesktop || registryBusy()) return;
    setRegistryBusy(true);
    const installedRead = beginInstalledRead();
    const [local, remote, preset] = await Promise.allSettled([api.agentInstalled(), api.agentRegistry(), agentPresets()]);
    // A preset list that fails to load only hides the preset rows; the rest of the screen still works.
    if (preset.status === "fulfilled") setPresets(preset.value);
    if (local.status === "fulfilled") applyInstalledSnapshot(installedRead, local.value);
    else fail({ phase: "connect", message: `Could not read installed agents: ${errorText(local.reason)}` });
    if (remote.status === "fulfilled") setRegistry(remote.value);
    else fail({ phase: "connect", message: `Could not load the ACP registry: ${errorText(remote.reason)}` });
    setRegistryBusy(false);
  }
  const registryName = (id: string) => registry().find((agent) => agent.id === id)?.name;

  /**
   * Installs a registry agent. The result lands on its row even when the user connects another agent or changes view
   * meanwhile, and a second click on the same row while it installs does nothing.
   */
  async function install(id: string, fail: ReportFailure) {
    const entry = registry().find((agent) => agent.id === id);
    if (!entry || installingIds().includes(id)) return;
    setInstallingIds((previous) => [...previous, id]);
    setInstallErrors((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    try {
      const added = await api.agentInstall(id);
      if (disposed) return;
      commitInstalledMutation((current) => upsertInstalled(current, added));
    } catch (cause) {
      if (disposed) return;
      setInstallErrors((previous) => ({ ...previous, [id]: errorText(cause) }));
      fail({ phase: "connect", message: `Could not install ${curatedAgent(id)?.name || entry.name}: ${errorText(cause)}` });
    } finally {
      if (!disposed) setInstallingIds((previous) => previous.filter((installingId) => installingId !== id));
    }
  }
  const catalogRows = createMemo<CatalogRow[]>(() => buildAgentCatalog(registry(), installed(), catalogSearch()));
  /** Installed adapters outside the curated list. */
  const otherInstalled = createMemo(() => installed().filter((entry) => !curatedAgent(entry.id)));

  return {
    installed,
    registry,
    presets,
    registryBusy,
    installingIds,
    installErrors,
    installing,
    catalogSearch,
    setCatalogSearch,
    catalogRows,
    otherInstalled,
    registryName,
    loadAgents,
    install,
    beginInstalledRead,
    applyInstalledSnapshot,
    commitInstalledMutation,
  };
}

export type AgentCatalog = ReturnType<typeof createAgentCatalog>;

/** The app's one catalog. */
export const agentCatalog = sharedStore(createAgentCatalog);
