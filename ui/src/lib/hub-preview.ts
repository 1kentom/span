/**
 * PREVIEW ONLY. A scripted stand-in for the language server backend so the language intelligence hub can
 * be exercised in the browser: an install that runs over time, a missing runtime, a failure with retry
 * and a folder that needs trust. The sizes, versions and timings are made up, nothing here is a real
 * server, and the native app never loads this module's output. Pick a scenario with `?hub=<name>` in the
 * address or `window.__spanHubPreview.set("<name>")`. Without a scenario there are no status rows.
 */
import type { LanguageServerId, LanguageServerInstallProgress_Deserialize, LanguageServerStateChanged_Deserialize, ServerStatusDto_Serialize } from "../bindings";
import type { HubPort, WorkProgressEvent } from "./hub-port";
import { previewHoverCapabilities } from "./hover-preview";

export type HubScenario = "off" | "needs-install" | "installing" | "runtime-missing" | "install-failed" | "crashed" | "needs-trust" | "ready" | "disabled" | "starting"
  | "installing-0" | "installing-100" | "verifying" | "extracting" | "indexing" | "trusted";
const MB = 1024 * 1024;
const caps = { ...previewHoverCapabilities, completion: true, formatting: true, typeHierarchy: true };
const artifacts = [40 * MB, 180 * MB, 100 * MB];
const total = artifacts.reduce((sum, size) => sum + size, 0);
const states = ["off", "needs-install", "installing", "runtime-missing", "install-failed", "crashed", "needs-trust", "ready", "disabled", "starting", "installing-0", "installing-100", "verifying", "extracting", "indexing", "trusted"] as const;

interface Api {
  scenario: () => HubScenario;
  set: (name: HubScenario) => void;
  /** Milliseconds one simulated step takes. Lower is faster. */
  stepMs: number;
}
declare global { interface Window { __spanHubPreview?: Api } }

export function createHubPreview(root: string) {
  let scenario: HubScenario = "off";
  let epoch = 1;
  let run = 0;
  let jdkChosen = false;
  let jdtls: Partial<ServerStatusDto_Serialize> = {};
  const stateListeners = new Set<(event: LanguageServerStateChanged_Deserialize) => void>();
  const installListeners = new Set<(event: LanguageServerInstallProgress_Deserialize) => void>();
  const workListeners = new Set<(event: WorkProgressEvent) => void>();
  const api: Api = { scenario: () => scenario, set: name => setScenario(name), stepMs: 60 };
  const sleep = (steps: number) => new Promise<void>(resolve => setTimeout(resolve, steps * api.stepMs));

  const base = (server: LanguageServerId, extra: Partial<ServerStatusDto_Serialize> = {}): ServerStatusDto_Serialize => ({
    server, root, state: { kind: "notStarted" }, installed: false, enabled: true, version: "1.0.0", epoch, capabilities: null,
    displayName: server, languages: [], installedSizeBytes: null, runtime: null, failureReason: null, failureDetails: null,
    trust: { workspaceTrusted: true, needsTrust: false, reason: null }, activity: [], install: null, ...extra,
  } as ServerStatusDto_Serialize);

  function scenarioRow(name: HubScenario): Partial<ServerStatusDto_Serialize> {
    const trusted = { workspaceTrusted: true, needsTrust: false, reason: null };
    const ready = { state: { kind: "ready" as const }, installed: true, capabilities: caps, installedSizeBytes: 412 * MB, trust: trusted };
    switch (name) {
      case "needs-install": return { state: { kind: "needsInstall", version: "1.62.0", sizeHint: 120 * MB } };
      case "installing": return { state: { kind: "installing" }, install: { phase: "downloading", overallReceived: 128 * MB, overallTotal: total, artifactIndex: 1, artifactCount: 3 } };
      case "installing-0": return { state: { kind: "installing" }, install: { phase: "downloading", overallReceived: 0, overallTotal: total, artifactIndex: 0, artifactCount: 3 } };
      case "installing-100": return { state: { kind: "installing" }, install: { phase: "downloading", overallReceived: total, overallTotal: total, artifactIndex: 2, artifactCount: 3 } };
      case "verifying": return { state: { kind: "installing" }, install: { phase: "verifying", overallReceived: total, overallTotal: total, artifactIndex: 2, artifactCount: 3 } };
      case "extracting": return { state: { kind: "installing" }, install: { phase: "extracting", overallReceived: total, overallTotal: total, artifactIndex: 2, artifactCount: 3 } };
      case "indexing": return { ...ready, activity: [{ token: "import", title: "Indexing project", message: "Reading classes and dependencies", percentage: 35 }] };
      case "trusted": return ready;
      case "runtime-missing": return { state: { kind: "runtimeMissing", runtime: "JDK", requiredVersion: 25, found: ["21"] }, runtime: { name: "JDK", requiredVersion: 25, foundVersion: "21", foundPath: "/Library/Java/JavaVirtualMachines/jdk-21.jdk" }, installed: true };
      case "install-failed": return { state: { kind: "installFailed", reason: "GET https://download.eclipse.org/jdtls: connection reset by peer (os error 54)", retryable: true }, failureReason: "Java support could not be downloaded. Check your internet connection and try again.", failureDetails: "GET https://download.eclipse.org/jdtls: connection reset by peer (os error 54)" };
      case "crashed": return { state: { kind: "crashed" }, installed: true };
      case "needs-trust": return { ...ready, trust: { workspaceTrusted: false, needsTrust: true, reason: "pom.xml" } };
      case "ready": return ready;
      case "disabled": return { state: { kind: "disabled" }, enabled: false, installed: true };
      case "starting": return { state: { kind: "starting" }, installed: true };
      default: return {};
    }
  }

  const rows = (): ServerStatusDto_Serialize[] => scenario === "off" ? [] : [
    base("jdtls", { version: "1.62.0", displayName: "Java (Eclipse JDT LS)", languages: ["Java"], ...jdtls, epoch }),
    base("vtsls", { state: { kind: "ready" }, installed: true, capabilities: caps, version: "0.3.0", installedSizeBytes: 88 * MB, displayName: "TypeScript and JavaScript (vtsls)" }),
    base("html", { state: { kind: "needsInstall", version: "1.0.0", sizeHint: 9 * MB } }),
    base("css", { state: { kind: "ready" }, installed: true, capabilities: caps, version: "1.0.0", installedSizeBytes: 31 * MB }),
    base("json", { state: { kind: "disabled" }, enabled: false, installed: true, version: "1.0.0", installedSizeBytes: 12 * MB }),
    base("basedpyright", { state: { kind: "needsInstall", version: "1.31.0", sizeHint: 64 * MB } }),
    base("rust-analyzer", { state: { kind: "needsInstall", version: "2026-10-12", sizeHint: 41 * MB } }),
  ];
  const emitState = () => { const row = rows().find(item => item.server === "jdtls"); if (row) for (const listener of [...stateListeners]) listener({ server: "jdtls", root, state: row.state as never }); };
  const emitInstall = (phase: string, overallReceived: number, index: number, received: number, size: number) => {
    for (const listener of [...installListeners]) listener({ server: "jdtls", version: "1.62.0", phase, received, total: size, message: null, overallReceived, overallTotal: total, artifactIndex: index, artifactCount: 3 } as LanguageServerInstallProgress_Deserialize);
  };
  const emitWork = (event: Omit<WorkProgressEvent, "server" | "root">) => { for (const listener of [...workListeners]) listener({ server: "jdtls", root, ...event }); };

  function setScenario(name: HubScenario) {
    if (!states.includes(name)) return;
    run++; scenario = name; epoch++; jdtls = scenarioRow(name); jdkChosen = false;
    emitWork({ token: "import", kind: "end" });
    emitState();
    // A fixed install state also reports its progress, the way the backend event would, so a repeat visit shows the new numbers.
    const shown = jdtls.install;
    if (shown) emitInstall(shown.phase, shown.overallReceived ?? 0, shown.artifactIndex ?? 0, 0, 0);
  }
  const update = (patch: Partial<ServerStatusDto_Serialize>) => { jdtls = { ...jdtls, ...patch }; emitState(); };

  async function install(): Promise<null> {
    const mine = ++run;
    const live = () => run === mine;
    update({ state: { kind: "installing" }, failureReason: null, failureDetails: null, install: { phase: "downloading", overallReceived: 0, overallTotal: total, artifactIndex: 0, artifactCount: 3 } });
    let overall = 0;
    for (let index = 0; index < artifacts.length; index++) {
      const size = artifacts[index];
      for (let tick = 1; tick <= 6; tick++) {
        await sleep(2); if (!live()) return null;
        const received = Math.round((size * tick) / 6);
        emitInstall("downloading", overall + received, index, received, size);
      }
      overall += size;
    }
    for (const phase of ["verifying", "extracting", "finalizing"]) { emitInstall(phase, total, 2, 0, 0); await sleep(8); if (!live()) return null; }
    update({ state: { kind: "starting" }, installed: true, installedSizeBytes: 412 * MB, install: null });
    for (const listener of [...installListeners]) listener({ server: "jdtls", version: "1.62.0", phase: "finished", overallReceived: total, overallTotal: total, artifactIndex: 2, artifactCount: 3 } as LanguageServerInstallProgress_Deserialize);
    await sleep(10); if (!live()) return null;
    await finishStart(mine);
    return null;
  }

  /** Shows indexing at 35 percent, then 80, then ready. */
  async function finishStart(mine: number, trust?: Partial<ServerStatusDto_Serialize>) {
    const live = () => run === mine;
    const work = (percentage: number) => ({ token: "import", title: "Indexing project", message: "Reading classes and dependencies", percentage });
    emitWork({ ...work(0), kind: "begin" }); epoch++; update({ state: { kind: "ready" }, capabilities: caps, activity: [work(0)], epoch, ...trust } as never);
    await sleep(10); if (!live()) return;
    emitWork({ ...work(35), kind: "report" }); update({ activity: [work(35)] } as never);
    await sleep(10); if (!live()) return;
    emitWork({ ...work(80), kind: "report" }); update({ activity: [work(80)] } as never);
    await sleep(6); if (!live()) return;
    emitWork({ token: "import", kind: "end" }); update({ activity: [] } as never);
  }

  async function restart(): Promise<null> {
    const mine = ++run;
    if (scenario === "runtime-missing" && !jdkChosen) { update({ state: { kind: "runtimeMissing", runtime: "JDK", requiredVersion: 25, found: ["21"] } }); return null; }
    epoch++; update({ state: { kind: "starting" }, runtime: null, epoch } as never);
    await sleep(8);
    if (run === mine) await finishStart(mine);
    return null;
  }

  async function trustWorkspace(trusted: boolean): Promise<null> {
    const mine = ++run;
    epoch++; update({ state: { kind: "starting" }, epoch, trust: trusted ? { workspaceTrusted: true, needsTrust: false, reason: null } : { workspaceTrusted: false, needsTrust: true, reason: "pom.xml" } } as never);
    await sleep(14);
    if (run === mine) await finishStart(mine);
    return null;
  }

  const hub: HubPort = {
    cancelInstall: async () => {
      run++;
      update({ state: { kind: "needsInstall", version: "1.62.0", sizeHint: 120 * MB }, install: null });
      for (const listener of [...installListeners]) listener({ server: "jdtls", version: "1.62.0", phase: "cancelled", overallReceived: 0, artifactIndex: 0, artifactCount: 3 } as LanguageServerInstallProgress_Deserialize);
    },
    trustWorkspace,
    onWorkProgress: async listener => { workListeners.add(listener); return () => { workListeners.delete(listener); }; },
    pickPath: async kind => { jdkChosen = true; return kind === "folder" ? "/preview/jdks/jdk-25" : "/preview/node/bin/node"; },
  };

  if (typeof window !== "undefined") {
    window.__spanHubPreview = api;
    const wanted = new URLSearchParams(window.location.search).get("hub");
    if (wanted && (states as readonly string[]).includes(wanted)) { scenario = wanted as HubScenario; jdtls = scenarioRow(scenario); }
  }

  return {
    hub, rows, active: () => scenario !== "off",
    install: (server: LanguageServerId) => server === "jdtls" ? install() : Promise.resolve(null),
    restart: (server: LanguageServerId) => server === "jdtls" ? restart() : Promise.resolve(null),
    onState: async (listener: (event: LanguageServerStateChanged_Deserialize) => void) => { stateListeners.add(listener); return () => { stateListeners.delete(listener); }; },
    onInstallProgress: async (listener: (event: LanguageServerInstallProgress_Deserialize) => void) => { installListeners.add(listener); return () => { installListeners.delete(listener); }; },
  };
}
