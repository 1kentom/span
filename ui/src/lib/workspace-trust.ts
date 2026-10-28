/**
 * Workspace trust, decided once when a folder is opened and stored by the backend outside the settings file
 * (`trusted-workspaces.json`). This module owns the current decision, the open time prompt queue and the port to
 * the generated commands. Browser preview uses a labelled in-memory fixture (see `createTrustPreview`).
 */
import { createRoot, createSignal } from "solid-js";
import { commands, events } from "../bindings";
import type { TrustChoice, TrustScope, WorkspaceTrustStateDto } from "../bindings";
import { isDesktop } from "./client";

export type TrustState = WorkspaceTrustStateDto;
export type TrustDecision = TrustState["decision"];

/** Commands and events of workspace trust. */
export interface TrustPort {
  state(): Promise<TrustState>;
  decide(decision: TrustChoice, scope: TrustScope): Promise<TrustState>;
  /** The backend stored a decision for the open folder. Returns the unsubscribe function. */
  onChanged(listener: () => void): Promise<() => void>;
}

const undecided: TrustState = { decision: "undecided", inherited: false, source: null, needsPrompt: false, reason: null, buildFiles: [] };

/**
 * PREVIEW FIXTURE: not the backend. Holds one decision in memory for the sample workspace so the browser
 * preview and the e2e tests can drive the dialog. It asks only with `?trust=prompt` in the URL.
 */
export function createTrustPreview(search = typeof location === "undefined" ? "" : location.search): TrustPort {
  const prompts = new URLSearchParams(search).get("trust") === "prompt";
  let state: TrustState = prompts
    ? { ...undecided, needsPrompt: true, reason: "This Maven project's dependencies can only be loaded by running Maven.", buildFiles: ["pom.xml"] }
    : { ...undecided };
  const listeners = new Set<() => void>();
  return {
    state: async () => ({ ...state }),
    async decide(decision, scope) {
      state = { ...undecided, decision, inherited: false, source: scope === "parent" ? "/preview" : "/preview/intellij", buildFiles: state.buildFiles, reason: state.reason };
      (window as unknown as { __trustPreviewCalls?: unknown[] }).__trustPreviewCalls?.push({ decision, scope });
      listeners.forEach(listener => listener());
      return { ...state };
    },
    async onChanged(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

const nativePort: TrustPort = {
  state: () => commands.workspaceTrustState(),
  decide: (decision, scope) => commands.workspaceTrustDecide(decision, scope),
  onChanged: listener => events.workspaceTrustChanged.listen(() => listener()),
};

/** Folder names of the parent of `root`, or null when a parent decision would be too broad (fewer than two components). */
export function parentFolderName(root: string): string | null {
  const parts = root.replace(/^\\\\\?\\/, "").split(/[\\/]+/).filter(Boolean).filter(part => !/^[A-Za-z]:$/.test(part));
  return parts.length >= 3 ? parts[parts.length - 2] : null;
}

export interface WorkspaceTrust {
  state: () => TrustState;
  decision: () => TrustDecision;
  inherited: () => boolean;
  source: () => string | null;
  /** The state the open time dialog is asking about, if one is waiting. */
  pending: () => TrustState | undefined;
  error: () => string;
  /** Looks the folder up. Queues the prompt when it is undecided with build files and was not asked in this session. */
  check: (root: string) => Promise<void>;
  /** Stores a decision (`scope` folder by default) and closes the prompt. */
  decide: (decision: TrustChoice, scope?: TrustScope) => Promise<void>;
  /** Escape or closing: stays undecided and is not shown again in this session. */
  dismiss: () => void;
  /** Forgets the open folder, for example when no workspace is open. */
  reset: () => void;
}

export function createWorkspaceTrust(port: TrustPort): WorkspaceTrust {
  const [state, setState] = createSignal<TrustState>({ ...undecided });
  const [pending, setPending] = createSignal<TrustState>();
  const [error, setError] = createSignal("");
  const asked = new Set<string>();
  let currentRoot: string | undefined;
  let generation = 0;
  let subscribed = false;

  async function refresh() {
    const mine = generation;
    const next = await port.state();
    if (mine === generation) setState(next);
    return next;
  }
  function listen() {
    if (subscribed) return;
    subscribed = true;
    void port.onChanged(() => { void refresh().catch(() => undefined); }).catch(() => { subscribed = false; });
  }
  return {
    state, decision: () => state().decision, inherited: () => state().inherited, source: () => state().source ?? null, pending, error,
    async check(root) {
      listen();
      generation += 1; currentRoot = root; setPending(undefined); setError("");
      let next: TrustState;
      try { next = await refresh(); } catch { return; }
      // The folder changed while the lookup ran.
      if (currentRoot !== root) return;
      if (next.needsPrompt && !asked.has(root)) { asked.add(root); setPending(next); }
    },
    async decide(decision, scope = "folder") {
      setError("");
      try {
        const next = await port.decide(decision, scope);
        setState(next); setPending(undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      }
    },
    dismiss() { setPending(undefined); setError(""); },
    reset() { generation += 1; currentRoot = undefined; setPending(undefined); setState({ ...undecided }); },
  };
}

let shared: WorkspaceTrust | undefined;
/** The app wide trust store: accessors for the current decision (the hub footer) and `decide`. */
export function useWorkspaceTrust(): WorkspaceTrust {
  shared ??= createRoot(() => createWorkspaceTrust(isDesktop ? nativePort : createTrustPreview()));
  return shared;
}
