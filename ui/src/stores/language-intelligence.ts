/**
 * The view model of the language intelligence hub. `buildHubView` is a pure function of one snapshot,
 * so the top bar button, the status bar item, the panel, the banner and every tooltip read the same
 * numbers and words. `createLanguageIntelligence` builds the snapshot from the language server store
 * and memoizes the view.
 */
import { createMemo, createSignal, type Accessor } from "solid-js";
import type { CapabilitiesDto, LanguageServerId } from "../bindings";
import { serverForBuffer } from "../lib/lsp-client";
import * as copy from "../lib/language-intelligence-copy";
import type { HubActivity, HubPort } from "../lib/hub-port";
import { capabilityChips, capabilityOn, languageState, pillLabel, statusTooltip, withPercent, worstState, type CapabilityChip, type LanguageKind, type LanguageState } from "../lib/language-status";
import { deriveBufferState, type BufferLspState, type LanguageServers, type ServerEntry } from "./language-servers";

export type HubStateKind = LanguageKind;
export type HubTone = "ok" | "busy" | "warn" | "bad" | "off";
export type HubActionId = "install" | "cancel" | "restart" | "start" | "retry" | "settings" | "chooseRuntime" | "checkAgain" | "turnOn" | "trust" | "stopTrusting" | "refresh" | "copyDetails" | "stop";
/** At most two per state: the primary one first, then an optional quieter one. */
export interface HubAction { id: HubActionId; label: string; primary?: boolean }
export interface ProgressView { percent?: number; indeterminate: boolean; ariaLabel: string }

export interface CardView {
  server: LanguageServerId;
  language: string;
  /** "Eclipse JDT LS 1.62": the technical name, without a build number. */
  technical: string;
  kind: HubStateKind;
  tone: HubTone;
  /** One of the five visible states, for the pill and the dots. */
  state: LanguageState;
  /** The pill word, for example "Ready", "Installing 42%" or "Needs trust". */
  pill: string;
  /** All seven capabilities, the unsupported ones off. */
  chips: CapabilityChip[];
  /** The full state name, for the dot's label and tooltip. */
  stateLabel: string;
  /** One short word next to the dot, empty when the state adds nothing (for example Ready). */
  stateWord: string;
  /** The one status line (two lines at most on screen). Never repeats the header. */
  status: string;
  /** Longer text for the status tooltip. */
  statusTip?: string;
  progress?: ProgressView;
  actions: HubAction[];
  failure?: { reason: string; details?: string };
  trust?: { needsTrust: boolean; trusted: boolean; label: string; tip: string; restarting?: string };
}

export interface RowView {
  server: LanguageServerId;
  name: string;
  /** The server's technical name, for example "rust-analyzer". */
  technical: string;
  kind: HubStateKind;
  tone: HubTone;
  state: LanguageState;
  /** A word only when the row is not ready, for example "Not installed" or "Installing 40%". */
  stateText: string;
  version?: string;
  size?: string;
  enabled: boolean;
  current: boolean;
  action?: HubAction;
}

/** The prompt over the editor when the open folder needs trust. */
export interface BannerView { server: LanguageServerId; root: string; title: string; explain: string; restarting?: string }

export interface HubView {
  title: string;
  preview: boolean;
  hasFile: boolean;
  card?: CardView;
  /** Shown in the status zone instead of the card when the file has no language server. */
  noCardText: string;
  rows: RowView[];
  banner?: BannerView;
  button: {
    tone: HubTone;
    ring: { kind: "none" | "determinate" | "indeterminate"; percent?: number };
    /** The worst state anywhere: "attention" for an error or a missing install, "restricted" for an untrusted folder. */
    badge?: "attention" | "restricted";
    badgeState?: "error" | "needs-trust" | "warn";
    label: string;
    tooltip: string;
  };
  statusBar: { visible: boolean; text: string; tone: HubTone; label: string; state: LanguageState; pill: string; tooltip: string };
}

export interface HubServerSnapshot {
  id: LanguageServerId; state: BufferLspState; entry?: ServerEntry; activity: readonly HubActivity[]; error?: string;
  /** "Refreshing TypeScript server" while the server catches up on file changes it missed. */
  watch?: string;
}
export interface HubSnapshot {
  hasFile: boolean;
  fileServer?: LanguageServerId;
  servers: readonly HubServerSnapshot[];
  statusError?: string;
  autoInstall: boolean;
  dismissedTrust: ReadonlySet<string>;
  trustRestarting: boolean;
  preview: boolean;
}

const tones: Record<HubStateKind, HubTone> = {
  unknown: "busy", unavailable: "bad", disabled: "off", idle: "off", "needs-install": "warn", installing: "busy", starting: "busy",
  working: "busy", ready: "ok", "runtime-missing": "warn", "install-failed": "bad", failed: "bad", crashed: "bad",
};
const attention: ReadonlySet<HubStateKind> = new Set(["needs-install", "runtime-missing", "install-failed", "failed", "crashed", "unavailable"]);

export function kindOf(snapshot: HubServerSnapshot, statusError?: string): HubStateKind {
  switch (snapshot.state.kind) {
    case "unsupported": return "unknown";
    case "unknown": return statusError ? "unavailable" : "unknown";
    case "disabled": return "disabled";
    case "idle": return "idle";
    case "starting": return "starting";
    case "installing": return "installing";
    case "ready": return snapshot.activity.length ? "working" : "ready";
    case "needs-install": return "needs-install";
    case "install-failed": return "install-failed";
    case "start-failed": return "failed";
    case "runtime-missing": return "runtime-missing";
    case "crashed": return "crashed";
  }
}

/** The one percent every surface shows: install bytes, or the lowest percentage the server reports while it works. */
export function percentFor(snapshot: HubServerSnapshot, kind: HubStateKind): number | undefined {
  if (kind === "installing" && snapshot.state.kind === "installing") return snapshot.state.percent;
  if (kind === "working") {
    const values = snapshot.activity.map(item => item.percentage).filter((value): value is number => typeof value === "number");
    return values.length ? Math.round(Math.min(...values)) : undefined;
  }
  return undefined;
}

function featuresOn(kind: HubStateKind, caps: CapabilitiesDto | undefined | null): string[] {
  if (kind !== "ready" && kind !== "working") return [];
  return copy.featureSpecs.filter(spec => capabilityOn(spec.id, caps)).map(spec => spec.id);
}

const act = (id: HubActionId, label: string, primary = false): HubAction => ({ id, label, primary: primary || undefined });

function actionsFor(id: LanguageServerId, kind: HubStateKind, state: BufferLspState, hasDetails: boolean): HubAction[] {
  switch (kind) {
    case "needs-install": return [act("install", "Install", true)];
    case "installing": return [act("cancel", "Cancel")];
    case "ready": case "working": return [act("restart", "Restart")];
    case "runtime-missing": return [act("chooseRuntime", copy.chooseRuntimeLabel(id), true), act("checkAgain", "Check again")];
    case "install-failed":
      return state.kind === "install-failed" && state.retryable
        ? [act("retry", "Retry", true), ...(hasDetails ? [act("copyDetails", copy.hubText.copyDetails)] : [])]
        : [act("restart", "Restart", true), act("settings", "Settings")];
    case "failed": return [act("restart", "Restart", true), act("settings", "Settings")];
    case "crashed": return [act("restart", "Restart", true)];
    case "disabled": return [act("turnOn", "Turn on", true)];
    case "idle": return [act("start", "Start")];
    case "unavailable": return [act("refresh", "Retry", true)];
    default: return [];
  }
}

function runtimeFacts(snapshot: HubServerSnapshot): copy.RuntimeFacts | undefined {
  const fromRow = snapshot.entry?.hub.runtime;
  if (fromRow) return { name: fromRow.name, requiredVersion: fromRow.requiredVersion, foundVersion: fromRow.foundVersion, foundPath: fromRow.foundPath };
  return snapshot.state.kind === "runtime-missing" ? { requiredVersion: snapshot.state.requiredVersion, foundList: snapshot.state.found } : undefined;
}

function buildCard(snapshot: HubServerSnapshot, input: HubSnapshot, kind: HubStateKind): CardView {
  const id = snapshot.id;
  const entry = snapshot.entry;
  const percent = percentFor(snapshot, kind);
  const state = snapshot.state;
  const failureRaw = state.kind === "install-failed" || state.kind === "start-failed" ? state.reason : undefined;
  const failureReason = entry?.hub.failureReason ?? snapshot.error ?? (kind === "install-failed" ? copy.installFailedLine(true) : copy.startFailedLine);
  const failureDetails = entry?.hub.failureDetails ?? (failureRaw && failureRaw !== failureReason ? failureRaw : undefined);
  const needsTrust = Boolean(entry?.hub.trust.needsTrust) && copy.projectCodeServers.has(id) && !input.trustRestarting;
  const card: CardView = {
    server: id, language: copy.languageNames[id], technical: copy.technicalLabel(id, entry?.version), kind, tone: tones[kind],
    state: languageState(kind, needsTrust), pill: pillLabel(kind, needsTrust), chips: capabilityChips(kind, entry?.capabilities),
    stateLabel: copy.stateName(kind), stateWord: copy.headerWord(kind), status: "", actions: actionsFor(id, kind, state, Boolean(failureDetails)),
  };
  switch (kind) {
    case "needs-install":
      card.status = copy.needsInstallLine(state.kind === "needs-install" ? state.sizeHint : undefined);
      card.statusTip = copy.needsInstallTip(input.autoInstall);
      break;
    case "installing": {
      const s = state.kind === "installing" ? state : undefined;
      const overall = s?.overallReceived !== undefined;
      card.status = copy.installPhaseLine(s?.phase, overall ? s?.overallReceived : s?.received, overall ? s?.overallTotal : s?.total);
      card.statusTip = copy.startingTip;
      card.progress = { percent, indeterminate: percent === undefined, ariaLabel: `Installing ${copy.shortLanguageNames[id]}` };
      break;
    }
    case "starting": card.status = copy.startingLine; card.statusTip = copy.startingTip; card.progress = { indeterminate: true, ariaLabel: `Starting ${copy.shortLanguageNames[id]}` }; break;
    case "working": {
      const first = snapshot.activity.find(item => typeof item.percentage === "number") ?? snapshot.activity[0];
      card.status = first?.message ?? copy.workLine;
      card.statusTip = copy.workTip;
      card.progress = { percent, indeterminate: percent === undefined, ariaLabel: "Indexing your project" };
      break;
    }
    case "ready": card.status = copy.featuresLine(featuresOn(kind, entry?.capabilities)); break;
    case "runtime-missing": {
      const facts = runtimeFacts(snapshot);
      card.status = facts ? copy.runtimeMissingLine(id, facts) : `Needs a newer ${id === "jdtls" ? "JDK" : "Node.js"}`;
      card.statusTip = facts ? copy.runtimeMissingTip(id, facts) : undefined;
      break;
    }
    case "install-failed": case "failed": {
      const retryable = state.kind === "install-failed" ? state.retryable : true;
      card.status = kind === "install-failed" ? copy.installFailedLine(retryable) : copy.startFailedLine;
      card.statusTip = [failureReason !== card.status ? failureReason : "", failureDetails ?? "", state.kind === "install-failed" && !state.retryable ? copy.nonRetryable : ""].filter(Boolean).join(" ");
      card.failure = { reason: failureReason, details: failureDetails };
      break;
    }
    case "crashed": card.status = copy.crashedLine; break;
    case "disabled": card.status = copy.disabledLine; break;
    case "idle": card.status = copy.idleLine; break;
    case "unavailable": card.status = copy.hubText.unavailable; card.statusTip = input.statusError; break;
    default: card.status = copy.checkingLine;
  }
  // Catching up on missed file changes is quiet: one status line, no toast, no extra action.
  if (snapshot.watch && (kind === "ready" || kind === "working" || kind === "starting")) { card.status = snapshot.watch; card.statusTip = copy.watchRecoveryTip; }
  const trust = entry?.hub.trust;
  if (trust && copy.projectCodeServers.has(id) && (kind === "ready" || kind === "working" || kind === "starting" || kind === "idle")) {
    if (input.trustRestarting) {
      const text = copy.hubText.restarting(copy.shortLanguageNames[id]);
      card.trust = { needsTrust: false, trusted: true, label: copy.hubText.trustedFolder, tip: copy.trustPrompt.explain, restarting: text };
      card.status = text;
      card.statusTip = undefined;
      card.actions = [];
    } else if (trust.needsTrust) {
      card.trust = { needsTrust: true, trusted: false, label: copy.hubText.untrustedFolder, tip: copy.trustPrompt.explain };
      card.actions = [act("trust", copy.hubText.trustFolder, true), ...card.actions.filter(item => item.id === "restart").map(item => ({ ...item, primary: undefined }))].slice(0, 2);
    } else if (trust.workspaceTrusted) {
      card.trust = { needsTrust: false, trusted: true, label: copy.hubText.trustedFolder, tip: copy.trustPrompt.explain };
    }
  }
  return card;
}

function buildRow(snapshot: HubServerSnapshot, input: HubSnapshot): RowView {
  const kind = kindOf(snapshot, input.statusError);
  const percent = percentFor(snapshot, kind);
  const entry = snapshot.entry;
  const action: HubAction | undefined = (() => {
    switch (kind) {
      case "needs-install": return act("install", "Install");
      case "install-failed": return snapshot.state.kind === "install-failed" && snapshot.state.retryable ? act("retry", "Retry") : act("restart", "Restart");
      case "failed": case "crashed": return act("restart", "Restart");
      default: return undefined;
    }
  })();
  const needsTrust = Boolean(entry?.hub.trust.needsTrust) && copy.projectCodeServers.has(snapshot.id) && !input.trustRestarting && input.fileServer === snapshot.id;
  return {
    server: snapshot.id, name: copy.shortLanguageNames[snapshot.id], technical: copy.technicalNames[snapshot.id], kind, tone: tones[kind], state: languageState(kind, needsTrust), stateText: copy.rowWord(kind, percent),
    version: entry?.version ? copy.shortVersion(entry.version) : undefined,
    size: entry?.installed && entry.hub.installedSizeBytes ? copy.formatBytes(entry.hub.installedSizeBytes) : undefined,
    enabled: entry ? entry.enabled : true, current: input.fileServer === snapshot.id, action,
  };
}

export const trustKey = (entry: ServerEntry | undefined, fallbackRoot?: string) => entry?.root ?? fallbackRoot ?? "";

export function buildHubView(input: HubSnapshot): HubView {
  const file = input.fileServer ? input.servers.find(item => item.id === input.fileServer) : undefined;
  const fileKind = file ? kindOf(file, input.statusError) : undefined;
  const card = file && fileKind ? buildCard(file, input, fileKind) : undefined;
  const rows = copy.serverOrder.map(id => input.servers.find(item => item.id === id)).filter((item): item is HubServerSnapshot => Boolean(item)).map(item => buildRow(item, input));

  // The button follows the active file. Without one it still shows an install that runs for another language.
  const background = card ? undefined : input.servers.find(item => { const kind = kindOf(item, input.statusError); return kind === "installing" || kind === "working"; });
  const focus = file ?? background;
  const focusKind = focus ? kindOf(focus, input.statusError) : undefined;
  const percent = focus && focusKind ? percentFor(focus, focusKind) : undefined;
  const restricted = Boolean(card?.trust?.needsTrust) && (focusKind === "ready" || focusKind === "working");
  const summary = copy.buttonSummary(focus?.id, focusKind ?? "unknown", percent, restricted);
  const busy = focusKind === "installing" || focusKind === "working" || focusKind === "starting";
  // The badge shows the worst state of every enabled server, not only the one behind the active file.
  const worst = worstState(rows, Boolean(card?.trust?.needsTrust));
  const focusAttention = Boolean(focusKind && attention.has(focusKind));
  const badgeState: HubView["button"]["badgeState"] = worst === "error" || (focusAttention && focusKind && tones[focusKind] === "bad") ? "error" : focusAttention ? "warn" : worst;
  const button: HubView["button"] = {
    tone: focusKind ? tones[focusKind] : "off",
    ring: busy ? (focusKind === "starting" || percent === undefined ? { kind: "indeterminate" } : { kind: "determinate", percent }) : { kind: "none" },
    badge: badgeState === "error" || badgeState === "warn" ? "attention" : badgeState === "needs-trust" ? "restricted" : undefined,
    badgeState,
    label: `${copy.hubText.title}. ${summary}.`,
    tooltip: summary,
  };
  if (!focus) button.tone = "off";

  const entry = file?.entry;
  const root = trustKey(entry);
  let banner: BannerView | undefined;
  if (file && entry && copy.projectCodeServers.has(file.id) && (fileKind === "ready" || fileKind === "working" || fileKind === "starting")) {
    if (input.trustRestarting) banner = { server: file.id, root, title: copy.trustPrompt.question, explain: copy.trustPrompt.explain, restarting: copy.hubText.restarting(copy.shortLanguageNames[file.id]) };
    else if (entry.hub.trust.needsTrust && !input.dismissedTrust.has(root)) banner = { server: file.id, root, title: copy.trustPrompt.question, explain: copy.trustPrompt.explain };
  }

  return {
    title: copy.hubText.title, preview: input.preview, hasFile: input.hasFile, card,
    noCardText: input.hasFile ? copy.hubText.noServer : copy.hubText.noFile,
    rows, banner, button,
    statusBar: file && fileKind && card
      ? { visible: true, text: copy.statusBarText(file.id, fileKind, percent, restricted), tone: tones[fileKind], label: button.label, state: card.state, pill: withPercent(card.pill, percent),
        tooltip: statusTooltip(copy.shortLanguageNames[file.id], card.technical, withPercent(card.pill, percent)) }
      : { visible: false, text: "", tone: "off", label: "", state: "off", pill: "", tooltip: "" },
  };
}

// ---- controller

export interface LanguageIntelligenceOptions {
  servers: LanguageServers;
  /** Active file, relative to the workspace root (or absolute). */
  activePath: Accessor<string | undefined>;
  workspaceRoot: Accessor<string | undefined>;
  autoInstall: Accessor<boolean>;
  preview?: boolean;
  /** Writes one USER setting, for example `languageServers.javaHome`. A null value removes the key. */
  setUserSetting: (key: string, value: unknown) => Promise<void>;
  pickPath: HubPort["pickPath"];
  openSettings: () => void;
}

export interface LanguageIntelligence {
  view: Accessor<HubView>;
  perform: (action: HubActionId, server: LanguageServerId) => Promise<void>;
  setEnabled: (server: LanguageServerId, enabled: boolean) => Promise<void>;
  /** "Not now": hides the banner for this folder until the next app start. */
  dismissBanner: (root: string) => void;
  /** Text and action for a hover that found nothing, when the folder is not trusted. */
  hoverHint: (path: string) => { text: string; actionLabel: string; onAction: () => void } | undefined;
}

const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");

export function createLanguageIntelligence(options: LanguageIntelligenceOptions): LanguageIntelligence {
  const { servers } = options;
  const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set());
  const [restarting, setRestarting] = createSignal<Record<string, number>>({});
  // A switch flips the row, the dot and the status bar at once. The override drops when the store agrees or the write fails.
  const [pending, setPending] = createSignal<Partial<Record<LanguageServerId, boolean>>>({});
  const absolute = (path: string) => { const root = options.workspaceRoot(); return root && !/^([A-Za-z]:)?[\\/]/.test(path) ? `${normalize(root)}/${path}` : path; };
  const fileServer = () => { const path = options.activePath(); return path ? serverForBuffer(path) : undefined; };
  const entryOf = (id: LanguageServerId) => servers.entryFor(id, options.activePath() ? absolute(options.activePath()!) : options.workspaceRoot());

  const snapshot = createMemo<HubSnapshot>(() => {
    const path = options.activePath();
    const current = fileServer();
    const overrides = pending();
    const list: HubServerSnapshot[] = copy.serverOrder.map(id => {
      let entry = entryOf(id);
      let state = id === current && path ? servers.bufferState(path, options.workspaceRoot()) : deriveBufferState(id, entry, servers.progress(id));
      const want = overrides[id];
      if (want !== undefined && entry && entry.enabled !== want) {
        entry = { ...entry, enabled: want };
        state = want ? { kind: "starting", server: id } : { kind: "disabled", server: id };
      }
      return { id, state, entry, activity: want === false ? [] : servers.work(id, entry?.root), error: servers.errorFor(id) || undefined, watch: servers.watchStatus(id) };
    });
    const entry = current ? list.find(item => item.id === current)?.entry : undefined;
    const mark = restarting()[trustKey(entry, options.workspaceRoot())];
    const stillRestarting = mark !== undefined && Boolean(entry) && !(entry!.epoch > mark && entry!.state.kind === "ready");
    return {
      hasFile: Boolean(path), fileServer: current, servers: list, statusError: servers.statusError() || undefined, autoInstall: options.autoInstall(),
      dismissedTrust: dismissed(), trustRestarting: stillRestarting, preview: Boolean(options.preview),
    };
  });
  const view = createMemo(() => buildHubView(snapshot()));

  async function setEnabled(server: LanguageServerId, enabled: boolean) {
    setPending({ ...pending(), [server]: enabled });
    try {
      await options.setUserSetting(`languageServers.enabled.${server}`, enabled);
      await servers.refresh();
    } finally {
      const { [server]: _done, ...rest } = pending();
      setPending(rest);
    }
  }

  async function perform(action: HubActionId, server: LanguageServerId) {
    switch (action) {
      case "stop": return setEnabled(server, false);
      case "install": return servers.install(server);
      case "cancel": return servers.cancelInstall(server);
      case "restart": case "start": case "checkAgain": return servers.restart(server);
      case "retry": return servers.retry(server);
      case "refresh": return servers.refresh();
      case "settings": return options.openSettings();
      case "turnOn": return setEnabled(server, true);
      case "chooseRuntime": {
        const picked = await options.pickPath(server === "jdtls" ? "folder" : "file", copy.chooseRuntimeTitle(server));
        if (!picked) return;
        await options.setUserSetting(server === "jdtls" ? "languageServers.javaHome" : "languageServers.nodePath", picked);
        return servers.restart(server);
      }
      case "trust": {
        const entry = entryOf(server);
        const key = trustKey(entry, options.workspaceRoot());
        const epoch = entry?.epoch ?? 0;
        setRestarting({ ...restarting(), [key]: epoch });
        await servers.trustWorkspace(true);
        const after = entryOf(server);
        // The command failed, or nothing restarted: do not leave the "restarting" message up.
        if (after && after.epoch === epoch && after.hub.trust.needsTrust) setRestarting(Object.fromEntries(Object.entries(restarting()).filter(([name]) => name !== key)));
        return;
      }
      case "stopTrusting": return servers.trustWorkspace(false);
    }
  }

  return {
    view, perform, setEnabled,
    dismissBanner: root => setDismissed(new Set([...dismissed(), root])),
    hoverHint: path => {
      const id = serverForBuffer(path);
      const entry = id ? servers.entryFor(id, absolute(path)) : undefined;
      if (!id || !entry || !entry.hub.trust.needsTrust || !copy.projectCodeServers.has(id) || view().banner?.restarting) return undefined;
      return { text: copy.hubText.hoverTrustHint, actionLabel: copy.hubText.trustFolder, onAction: () => { void perform("trust", id); } };
    },
  };
}
