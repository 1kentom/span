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
import { deriveBufferState, type BufferLspState, type LanguageServers, type ServerEntry } from "./language-servers";

export type HubStateKind =
  | "unknown" | "unavailable" | "disabled" | "idle" | "needs-install" | "installing" | "starting" | "working"
  | "ready" | "runtime-missing" | "install-failed" | "failed" | "crashed";
export type HubTone = "ok" | "busy" | "warn" | "bad" | "off";
export type HubActionId = "install" | "cancel" | "restart" | "start" | "retry" | "settings" | "chooseRuntime" | "checkAgain" | "turnOn" | "trust" | "stopTrusting" | "refresh";
export interface HubAction { id: HubActionId; label: string; primary?: boolean }
export interface FeatureChip { id: string; label: string; on: boolean; tooltip: string }
export interface ProgressView { percent?: number; indeterminate: boolean; ariaLabel: string }

export interface CardView {
  server: LanguageServerId;
  language: string;
  technical: string;
  kind: HubStateKind;
  tone: HubTone;
  /** One or two words, for example "Installing". */
  stateLabel: string;
  /** The line under the name: a phase while installing, otherwise the main sentence. */
  headline: string;
  detail?: string;
  note?: string;
  progress?: ProgressView;
  chips: FeatureChip[];
  actions: HubAction[];
  failure?: { reason: string; details?: string };
  trust?: { needsTrust: boolean; trusted: boolean; text: string; restarting?: string };
}

export interface RowView {
  server: LanguageServerId;
  name: string;
  kind: HubStateKind;
  tone: HubTone;
  stateText: string;
  version?: string;
  size?: string;
  enabled: boolean;
  current: boolean;
  action?: HubAction;
}

export interface BannerView { server: LanguageServerId; root: string; title: string; body: string; more: string; restarting?: string }

export interface HubView {
  title: string;
  subtitle: string;
  preview: boolean;
  hasFile: boolean;
  card?: CardView;
  /** Shown instead of the card when the file has no language server. */
  noCardText: string;
  rows: RowView[];
  banner?: BannerView;
  button: {
    tone: HubTone;
    ring: { kind: "none" | "determinate" | "indeterminate"; percent?: number };
    check: boolean;
    badge?: "attention" | "restricted";
    label: string;
    tooltip: string;
  };
  statusBar: { visible: boolean; text: string; tone: HubTone; label: string };
}

export interface HubServerSnapshot { id: LanguageServerId; state: BufferLspState; entry?: ServerEntry; activity: readonly HubActivity[]; error?: string }
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

function capabilityOn(id: string, caps: CapabilitiesDto | undefined | null): boolean {
  if (!caps) return false;
  switch (id) {
    case "completion": return caps.completion;
    case "diagnostics": return true;
    case "hover": return caps.hover;
    case "definition": return caps.definition;
    case "references": return caps.references;
    case "rename": return caps.rename;
    case "format": return caps.formatting || caps.rangeFormatting;
    default: return false;
  }
}

function chipsFor(id: LanguageServerId, kind: HubStateKind, caps: CapabilitiesDto | undefined | null): FeatureChip[] {
  const live = kind === "ready" || kind === "working";
  return copy.featureChipSpecs.map(spec => {
    const on = live && capabilityOn(spec.id, caps);
    return { id: spec.id, label: spec.label, on, tooltip: !live ? copy.chipsWaiting(id) : on ? spec.on : spec.off };
  });
}

const act = (id: HubActionId, label: string, primary = false): HubAction => ({ id, label, primary: primary || undefined });

function actionsFor(id: LanguageServerId, kind: HubStateKind, entry: ServerEntry | undefined, state: BufferLspState): HubAction[] {
  switch (kind) {
    case "needs-install": return [act("install", copy.installLabel(id), true)];
    case "installing": return [act("cancel", "Cancel")];
    case "ready": case "working": return [act("restart", "Restart"), act("settings", "Settings")];
    case "runtime-missing": return [act("chooseRuntime", copy.chooseRuntimeLabel(id), true), act("checkAgain", "Check again")];
    case "install-failed": return state.kind === "install-failed" && state.retryable ? [act("retry", "Retry", true)] : [act("restart", "Restart", true), act("settings", "Settings")];
    case "failed": return [act("restart", "Restart", true), act("settings", "Settings")];
    case "crashed": return [act("restart", "Restart", true)];
    case "disabled": return [act("turnOn", "Turn on", true)];
    case "idle": return [act("start", "Start")];
    case "unavailable": return [act("refresh", "Retry", true)];
    default: return entry ? [] : [];
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
  const card: CardView = {
    server: id, language: copy.languageNames[id], technical: copy.technicalLabel(id, entry?.version), kind, tone: tones[kind],
    stateLabel: copy.rowStateText(kind, percent), headline: "", chips: chipsFor(id, kind, entry?.capabilities), actions: actionsFor(id, kind, entry, state),
  };
  switch (kind) {
    case "needs-install":
      card.headline = copy.rowStateText(kind);
      card.detail = copy.needsInstallDetail(id, state.kind === "needs-install" ? state.sizeHint : undefined, input.autoInstall);
      break;
    case "installing": {
      const s = state.kind === "installing" ? state : undefined;
      const overall = s?.overallReceived !== undefined;
      card.headline = copy.installPhaseLine(s?.phase, overall ? s?.overallReceived : s?.received, overall ? s?.overallTotal : s?.total);
      card.detail = copy.installingKeepEditing(id);
      card.progress = { percent, indeterminate: percent === undefined, ariaLabel: `Installing ${copy.supportName(id)}` };
      break;
    }
    case "starting": card.headline = "Starting…"; card.detail = copy.startingDetail(id); card.progress = { indeterminate: true, ariaLabel: `Starting ${copy.supportName(id)}` }; break;
    case "working": {
      const first = snapshot.activity.find(item => typeof item.percentage === "number") ?? snapshot.activity[0];
      card.headline = copy.workHeadline(first?.title, percent);
      card.detail = first?.message ?? copy.workDetail(id);
      card.note = first?.message ? copy.workDetail(id) : undefined;
      card.progress = { percent, indeterminate: percent === undefined, ariaLabel: "Indexing your project" };
      break;
    }
    case "ready": card.headline = "Ready"; card.detail = copy.readyDetail; break;
    case "runtime-missing": {
      const facts = runtimeFacts(snapshot);
      card.headline = "Needs a runtime";
      card.detail = facts ? copy.runtimeMissingDetail(id, facts) : `${copy.supportName(id)} needs a newer runtime.`;
      break;
    }
    case "install-failed": case "failed": {
      const raw = state.kind === "install-failed" || state.kind === "start-failed" ? state.reason : undefined;
      const reason = entry?.hub.failureReason ?? snapshot.error ?? (kind === "install-failed" ? copy.installFailedFallback(id) : copy.startFailedFallback(id));
      const details = entry?.hub.failureDetails ?? (raw && raw !== reason ? raw : undefined);
      card.headline = kind === "install-failed" ? "Install failed" : "Did not start";
      card.detail = reason;
      card.failure = { reason, details };
      if (state.kind === "install-failed" && !state.retryable) card.note = copy.nonRetryable;
      break;
    }
    case "crashed": card.headline = "Stopped"; card.detail = copy.crashedDetail(id); break;
    case "disabled": card.headline = "Off"; card.detail = copy.disabledDetail(id); break;
    case "idle": card.headline = "Not started"; card.detail = copy.idleDetail(id); break;
    case "unavailable": card.headline = copy.hubText.unavailableShort; card.detail = copy.hubText.unavailable; card.note = input.statusError; break;
    default: card.headline = "Checking…"; card.detail = copy.checkingDetail(id);
  }
  const trust = entry?.hub.trust;
  if (trust && copy.projectCodeServers.has(id) && (kind === "ready" || kind === "working" || kind === "starting" || kind === "idle")) {
    if (input.trustRestarting) card.trust = { needsTrust: false, trusted: true, text: copy.trustBanner.body, restarting: copy.hubText.restarting(copy.supportName(id)) };
    else if (trust.needsTrust) {
      card.trust = { needsTrust: true, trusted: false, text: `${copy.trustBanner.body}` };
      card.actions = [act("trust", copy.hubText.trustThisFolder, true), ...card.actions.filter(item => item.id !== "settings"), ...card.actions.filter(item => item.id === "settings")];
    } else if (trust.workspaceTrusted) {
      card.trust = { needsTrust: false, trusted: true, text: copy.hubText.trustedLine };
      card.actions = [...card.actions, act("stopTrusting", copy.hubText.stopTrusting)];
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
      case "ready": case "working": return act("restart", "Restart");
      default: return undefined;
    }
  })();
  return {
    server: snapshot.id, name: copy.languageNames[snapshot.id], kind, tone: tones[kind], stateText: copy.rowStateText(kind, percent),
    version: entry?.version ? entry.version.replace(/^v/i, "") : undefined,
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
  const button: HubView["button"] = {
    tone: focusKind ? tones[focusKind] : "off",
    ring: busy ? (focusKind === "starting" || percent === undefined ? { kind: "indeterminate" } : { kind: "determinate", percent }) : { kind: "none" },
    check: focusKind === "ready" && !restricted,
    badge: focusKind && attention.has(focusKind) ? "attention" : restricted ? "restricted" : undefined,
    label: `${copy.hubText.title}. ${summary}.`,
    tooltip: summary,
  };
  if (!focus) button.tone = "off";

  const entry = file?.entry;
  const root = trustKey(entry);
  let banner: BannerView | undefined;
  if (file && entry && copy.projectCodeServers.has(file.id) && (fileKind === "ready" || fileKind === "working" || fileKind === "starting")) {
    if (input.trustRestarting) banner = { server: file.id, root, title: copy.trustBanner.title, body: copy.trustBanner.body, more: copy.trustBanner.more, restarting: copy.hubText.restarting(copy.supportName(file.id)) };
    else if (entry.hub.trust.needsTrust && !input.dismissedTrust.has(root)) banner = { server: file.id, root, title: copy.trustBanner.title, body: copy.trustBanner.body, more: copy.trustBanner.more };
  }

  return {
    title: copy.hubText.title, subtitle: copy.hubText.subtitle, preview: input.preview, hasFile: input.hasFile, card,
    noCardText: input.hasFile ? copy.hubText.noServer : copy.hubText.noFile,
    rows, banner, button,
    statusBar: file && fileKind
      ? { visible: true, text: copy.statusBarText(file.id, fileKind, percent, restricted), tone: tones[fileKind], label: button.label }
      : { visible: false, text: "", tone: "off", label: "" },
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
  const absolute = (path: string) => { const root = options.workspaceRoot(); return root && !/^([A-Za-z]:)?[\\/]/.test(path) ? `${normalize(root)}/${path}` : path; };
  const fileServer = () => { const path = options.activePath(); return path ? serverForBuffer(path) : undefined; };
  const entryOf = (id: LanguageServerId) => servers.entryFor(id, options.activePath() ? absolute(options.activePath()!) : options.workspaceRoot());

  const snapshot = createMemo<HubSnapshot>(() => {
    const path = options.activePath();
    const current = fileServer();
    const list: HubServerSnapshot[] = copy.serverOrder.map(id => {
      const entry = entryOf(id);
      const state = id === current && path ? servers.bufferState(path, options.workspaceRoot()) : deriveBufferState(id, entry, servers.progress(id));
      return { id, state, entry, activity: servers.work(id, entry?.root), error: servers.errorFor(id) || undefined };
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

  async function perform(action: HubActionId, server: LanguageServerId) {
    switch (action) {
      case "install": return servers.install(server);
      case "cancel": return servers.cancelInstall(server);
      case "restart": case "start": case "checkAgain": return servers.restart(server);
      case "retry": return servers.retry(server);
      case "refresh": return servers.refresh();
      case "settings": return options.openSettings();
      case "turnOn": return options.setUserSetting(`languageServers.enabled.${server}`, true).then(() => servers.refresh());
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
    view, perform,
    setEnabled: (server, enabled) => options.setUserSetting(`languageServers.enabled.${server}`, enabled).then(() => servers.refresh()),
    dismissBanner: root => setDismissed(new Set([...dismissed(), root])),
    hoverHint: path => {
      const id = serverForBuffer(path);
      const entry = id ? servers.entryFor(id, absolute(path)) : undefined;
      if (!id || !entry || !entry.hub.trust.needsTrust || !copy.projectCodeServers.has(id) || view().banner?.restarting) return undefined;
      return { text: copy.hubText.hoverTrustHint, actionLabel: copy.hubText.trustFolder, onAction: () => { void perform("trust", id); } };
    },
  };
}
