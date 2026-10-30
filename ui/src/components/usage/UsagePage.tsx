import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { SessionUsageRow_Serialize as SessionUsageRow, UsageImportStatus_Serialize as ImportStatus, UsageRange_Deserialize as UsageRange, UsageSummary_Serialize as UsageSummary } from "../../bindings";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";
import { ModelIcon } from "../agent/ModelPopover";
import { UsageChart, UsageChartTable, UsageShare, seriesVar, type ChartMetric, type SeriesInfo } from "./UsageChart";
import { ModelList, Panel, ProviderList, SessionTable, SourceList, brandId, type ProviderRow } from "./UsageTables";
import { RANGES, SOURCES, assignSlots, chartColumns, compactTokens, costShort, costText, sumCosts, csvFileName, deltaText, fullNumber, money, percentChange, previousRangeFor, providerKey, providerName, rangeFor, relativeTime, shareText, sparkline, sumTotals, usageCsv, type RangeKey, type SourceKey } from "../../lib/usage";
import "../../styles/usage.css";

export type UsageApi = {
  summary: (range: UsageRange) => Promise<UsageSummary | undefined>;
  sessions: (range: UsageRange) => Promise<SessionUsageRow[]>;
  /** The local log importer (ADR 0012, source B). */
  importScan?: () => Promise<ImportStatus | undefined>;
  importStatus?: () => Promise<ImportStatus | undefined>;
};

const NOTICE_KEY = "span.usage.importNotice.v1";
const KIND_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", openCode: "OpenCode" };
/** Series slots for the by-model view: the five largest models in view, the rest folded into Other. */
const MODEL_SLOTS = 5;

type Loaded = { summary?: UsageSummary; previous?: UsageSummary; sessions: SessionUsageRow[]; at: number };

/**
 * The Usage page (ADR 0012): tokens and API-equivalent cost estimates per agent, model, session and day. Every dollar
 * figure is labelled an estimate, and an unknown price shows "No price", never $0.
 */
export function UsagePage(props: {
  api: UsageApi;
  desktop: boolean;
  onClose: () => void;
  /** Saves the CSV. Absent when export is unavailable, with `exportUnavailable` saying why. */
  onExport?: (fileName: string, text: string) => Promise<void>;
  exportUnavailable?: string;
  onOpenExternal?: (url: string) => void;
  /** Opens a session Span ran. `canOpenSession` says which rows can open (the connected agent's own). */
  onOpenSession?: (row: SessionUsageRow) => void;
  canOpenSession?: (row: SessionUsageRow) => boolean;
  /** `agents.usage.importLocalLogs` from the user settings (on by default). */
  importEnabled?: boolean;
  /** Opens Settings, where the importer can be turned off. */
  onOpenSettings?: () => void;
  /** Turns the importer on or off in the user settings. */
  onImportChange?: (enabled: boolean) => Promise<void>;
}) {
  const [range, setRange] = createSignal<RangeKey>("30d");
  const [source, setSource] = createSignal<SourceKey>("all");
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set());
  const [importState, setImportState] = createSignal<ImportStatus>();
  const [importBusy, setImportBusy] = createSignal(false);
  const [metric, setMetric] = createSignal<ChartMetric>("tokens");
  const [groupBy, setGroupBy] = createSignal<"agent" | "model">("agent");
  const [notice, setNotice] = createSignal(false);
  const [showTable, setShowTable] = createSignal(false);
  const [data, setData] = createSignal<Loaded>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [exporting, setExporting] = createSignal(false);
  const [exportNote, setExportNote] = createSignal("");
  const [now, setNow] = createSignal(Date.now());
  let heading: HTMLHeadingElement | undefined;
  let request = 0;
  const restore = document.activeElement as HTMLElement | null;
  const clock = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(clock));

  const effectiveSource = () => (props.importEnabled ? source() : "tracked");
  async function load() {
    const id = ++request;
    setLoading(true);
    setError("");
    try {
      const target = rangeFor(range(), new Date(), effectiveSource());
      const before = previousRangeFor(range(), new Date(), effectiveSource());
      const [summary, sessions, previous] = await Promise.all([props.api.summary(target), props.api.sessions(target), before ? props.api.summary(before).catch(() => undefined) : Promise.resolve(undefined)]);
      if (id === request) { setData({ summary, sessions, previous, at: Date.now() }); setNow(Date.now()); }
    } catch (cause) {
      if (id === request) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (id === request) setLoading(false);
    }
  }
  createEffect(on([range, source, () => props.importEnabled], () => void load()));
  let poll: ReturnType<typeof setTimeout> | undefined;
  /** Scans the local logs in the background, shows progress, and reloads once the scan is done. */
  async function followImport(start: boolean) {
    if (!props.importEnabled || !props.api.importScan || !props.api.importStatus) return;
    clearTimeout(poll);
    try {
      const state = start ? await props.api.importScan() : await props.api.importStatus();
      setImportState(state);
      if (state?.running) poll = setTimeout(() => void followImport(false), 600);
      else if (!start) void load();
    } catch (cause) {
      setImportState((current) => ({ enabled: true, running: false, report: current?.report ?? null, scannedMs: current?.scannedMs ?? null, error: cause instanceof Error ? cause.message : String(cause) }));
    }
  }
  createEffect(on(() => props.importEnabled, (enabled) => { if (enabled) void followImport(true); else { clearTimeout(poll); setImportState(undefined); setSource("all"); } }));
  onCleanup(() => clearTimeout(poll));
  async function toggleImport(enabled: boolean) {
    if (!props.onImportChange) return;
    setImportBusy(true);
    try { await props.onImportChange(enabled); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setImportBusy(false); }
  }
  const refresh = () => { if (props.importEnabled && props.api.importScan) void followImport(true); else void load(); };
  // A one-time quiet notice that the local logs are read (ADR 0012 amendment): shown on the first visit only.
  createEffect(on(() => Boolean(props.importEnabled && props.desktop), (shown) => {
    if (!shown) return;
    let seen = false;
    try { seen = localStorage.getItem(NOTICE_KEY) === "1"; localStorage.setItem(NOTICE_KEY, "1"); } catch { /* storage unavailable: show it */ }
    if (!seen) setNotice(true);
  }));
  onMount(() => heading?.focus());
  onCleanup(() => { request += 1; if (restore?.isConnected) restore.focus(); });
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !(event.target instanceof HTMLInputElement && event.target.value)) { event.preventDefault(); props.onClose(); } };

  const summary = () => data()?.summary;
  /** Providers present in the range, with fixed colour slots (colour follows the provider, never its rank). */
  const providers = createMemo(() => {
    const byKey = new Map<string, string>();
    for (const agent of summary()?.agents ?? []) { const key = providerKey(agent.agentId); if (!byKey.has(key)) byKey.set(key, providerName(key, agent.name)); }
    const slots = assignSlots([...byKey.keys()]);
    return [...byKey.entries()].map(([key, name]) => ({ key, name, slot: slots.get(key) ?? ("other" as const) })).sort((a, b) => (a.slot === "other" ? 99 : a.slot) - (b.slot === "other" ? 99 : b.slot));
  });
  const include = createMemo(() => (picked().size ? picked() : undefined));
  const shown = (agentId: string) => !include() || include()!.has(providerKey(agentId));
  const togglePick = (key: string) => setPicked((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next.size === providers().length ? new Set<string>() : next; });
  createEffect(on(providers, (list) => setPicked((current) => new Set([...current].filter((key) => list.some((p) => p.key === key))))));

  const totalsOf = (value: UsageSummary | undefined) => (value ? (include() ? sumTotals(value.agents.filter((agent) => shown(agent.agentId)).map((agent) => agent.totals)) : value.totals) : undefined);
  const totals = createMemo(() => totalsOf(summary()));
  const previousTotals = createMemo(() => totalsOf(data()?.previous));
  const models = createMemo(() => (summary()?.models ?? []).filter((model) => !include() || model.agentIds.some(shown)));
  const sessions = createMemo(() => (data()?.sessions ?? []).filter((row) => shown(row.agentId)));
  const series = createMemo<SeriesInfo[]>(() => providers().filter((p) => !include() || include()!.has(p.key)).map((p) => ({ key: p.key, name: p.name, slot: p.slot })));
  const chart = createMemo(() => chartColumns(summary()?.days ?? [], providerKey, include()));
  /** The five largest models in view keep a slot each; colour follows the model while the view is unchanged. */
  const modelSeries = createMemo<SeriesInfo[]>(() => {
    const top = [...models()].sort((a, b) => b.totals.tokens.total - a.totals.tokens.total).slice(0, MODEL_SLOTS);
    const list: SeriesInfo[] = top.map((model, index) => ({ key: model.model || "unnamed", name: model.price?.label ?? (model.model || "Model not named"), slot: index + 1 }));
    return models().length > MODEL_SLOTS ? [...list, { key: "other", name: "Other models", slot: "other" }] : list;
  });
  const modelChart = createMemo(() => {
    const named = new Set(modelSeries().filter((entry) => entry.slot !== "other").map((entry) => entry.key));
    const days = (summary()?.days ?? []).map((day) => ({ day: day.day, agents: (day.models ?? []).filter((slice) => shown(slice.agentId)).map((slice) => ({ agentId: slice.model || "unnamed", tokens: slice.tokens, cost: slice.cost })) }));
    return chartColumns(days, (key) => (named.has(key) ? key : "other"));
  });
  const view = createMemo(() => (groupBy() === "model" ? { chart: modelChart(), series: modelSeries() } : { chart: chart(), series: series() }));
  const legendRows = createMemo(() => view().series.map((entry) => {
    const values = view().chart.columns.map((column) => column.values.get(entry.key)).filter((value) => value !== undefined);
    return { ...entry, tokens: values.reduce((sum, value) => sum + value!.tokens, 0), cost: sumCosts(values.map((value) => value!.cost)) };
  }).filter((row) => row.tokens > 0));
  const providerRows = createMemo<ProviderRow[]>(() => series().map((entry) => {
    const agents = (summary()?.agents ?? []).filter((agent) => providerKey(agent.agentId) === entry.key);
    const daily = chart().columns.map((column) => column.values.get(entry.key)?.tokens ?? 0);
    return { ...entry, totals: sumTotals(agents.map((agent) => agent.totals)), spark: sparkline(daily, 30), imported: agents.filter((agent) => agent.imported).reduce((sum, agent) => sum + agent.totals.sessions, 0) };
  }));
  const totalTokens = () => totals()?.tokens.total ?? 0;
  const sourceSplit = createMemo(() => {
    const agents = (summary()?.agents ?? []).filter((agent) => shown(agent.agentId));
    return { tracked: sumTotals(agents.filter((agent) => !agent.imported).map((agent) => agent.totals)), imported: sumTotals(agents.filter((agent) => agent.imported).map((agent) => agent.totals)) };
  });
  const agentName = (id: string) => summary()?.agents.find((entry) => entry.agentId === id)?.name ?? providerName(providerKey(id), id);
  const topModel = createMemo(() => [...models()].sort((a, b) => b.totals.tokens.total - a.totals.tokens.total)[0]);
  const unpriced = createMemo(() => models().filter((model) => !model.price && model.totals.tokens.total > 0 && !model.totals.cost.known));
  const skippedSources = () => { const report = importState()?.report; return report ? report.compressedSkipped + report.skipped + report.notes.length : 0; };
  const hasUsage = () => (summary()?.totals.turns ?? 0) > 0 || (summary()?.totals.tokens.total ?? 0) > 0;
  const rangeLabel = () => RANGES.find((entry) => entry.key === range())?.label ?? "";
  const previousLabel = () => (range() === "today" ? "yesterday" : `previous ${rangeLabel().toLowerCase()}`);
  const scanning = () => Boolean(importState()?.running);
  const progress = () => { const report = importState()?.report; return report?.filesTotal ? Math.min(100, Math.round((report.filesDone / report.filesTotal) * 100)) : 0; };
  const status = createMemo(() => {
    const state = importState();
    if (state?.running) return state.report?.filesTotal ? `Scanning ${fullNumber(state.report.filesTotal)} files, ${progress()}%` : "Looking for local logs";
    if (state?.error) return "Local logs could not be read";
    const scanned = state?.scannedMs ?? data()?.at;
    return scanned ? `${state?.scannedMs ? "Scanned" : "Updated"} ${relativeTime(scanned, now())}` : "";
  });

  async function exportCsv() {
    if (!props.onExport) return;
    setExporting(true);
    setExportNote("");
    try {
      const rows = (await props.api.sessions(rangeFor(range(), new Date(), effectiveSource()))).filter((row) => shown(row.agentId));
      const name = csvFileName();
      await props.onExport(name, usageCsv(rows));
      setExportNote(`Saved ${name}`);
    } catch (cause) {
      setExportNote(`Export failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setExporting(false);
    }
  }
  const openExternal = (event: MouseEvent, url: string) => { if (props.onOpenExternal) { event.preventDefault(); props.onOpenExternal(url); } };

  const Delta = (delta: { current: number; previous?: number }) => {
    const change = () => (delta.previous === undefined ? undefined : percentChange(delta.current, delta.previous));
    return (
      <Show when={change() !== undefined}>
        <span class="usage-delta" title={`Compared with the ${previousLabel()}`}>
          <Show when={change() !== 0}><Icon name={change()! > 0 ? "arrow-up3" : "arrow-down4"} size={10} /></Show>
          {deltaText(change()!).replace(/^[+−]/, "")}<span class="usage-delta-vs">vs {previousLabel()}</span>
        </span>
      </Show>
    );
  };

  return (
    <div class="usage-page" role="region" aria-labelledby="usage-title" onKeyDown={onKey}>
      <div class="usage-scroll">
        <div class="usage-content">
          <header class="usage-head">
            <div class="usage-head-row">
              <div class="usage-title">
                <h1 id="usage-title" tabindex="-1" ref={heading}>Usage</h1>
                <p>Tokens and estimated API cost across your agents</p>
              </div>
              <span class="usage-spacer" />
              <Show when={props.importEnabled}>
                <div class="usage-segmented small usage-source" role="group" aria-label="Source">
                  <For each={SOURCES}>{(entry) => <button type="button" aria-pressed={source() === entry.key} title={entry.label} onClick={() => setSource(entry.key)}>{entry.short}</button>}</For>
                </div>
              </Show>
              <Show when={props.desktop && status()}>
                <span class="usage-status" role="status" aria-live="polite" classList={{ busy: scanning() }}>
                  <Show when={scanning()} fallback={<Icon name="Clock" size={13} />}><span class="usage-spinner" aria-hidden="true" /></Show>
                  {status()}
                </span>
              </Show>
              <button type="button" class="usage-icon-button" aria-label={props.importEnabled ? "Scan local logs again and refresh" : "Refresh usage"} title="Refresh" disabled={loading() || scanning() || !props.desktop} onClick={refresh}><Icon name="Refresh2" size={15} /></button>
              <button type="button" class="usage-icon-button" aria-label="Close usage" title="Close (Escape)" onClick={() => props.onClose()}><span class="cross" /></button>
            </div>
            <Show when={notice()}>
              <p class="usage-notice" role="note">
                <Icon name="InfoCircle" size={13} />
                <span class="usage-notice-text">Reading local usage from Claude Code, Codex, Gemini CLI and OpenCode logs. Turn off in <Show when={props.onOpenSettings} fallback="Settings">{(open) => <button type="button" class="usage-link" onClick={() => open()()}>Settings</button>}</Show>.</span>
                <button type="button" class="usage-icon-button small" aria-label="Dismiss" title="Dismiss" onClick={() => setNotice(false)}><span class="cross" /></button>
              </p>
            </Show>
            <Show when={scanning()}>
              <div class="usage-progress" role="progressbar" aria-label="Scanning local logs" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress()}><i style={{ width: `${Math.max(3, progress())}%` }} /></div>
            </Show>
            <div class="usage-controls">
              <div class="usage-segmented" role="group" aria-label="Date range">
                <For each={RANGES}>{(entry) => <button type="button" aria-pressed={range() === entry.key} title={entry.label} onClick={() => setRange(entry.key)}>{entry.short}</button>}</For>
              </div>
              <Show when={providers().length > 1}>
                <div class="usage-chips" role="group" aria-label="Agents">
                  <button type="button" class="usage-chip" aria-pressed={!include()} onClick={() => setPicked(new Set())}>All agents</button>
                  <For each={providers()}>{(provider) => (
                    <button type="button" class="usage-chip" aria-pressed={Boolean(include()?.has(provider.key))} onClick={() => togglePick(provider.key)}>
                      <BrandIcon id={provider.key} name={provider.name} size={13} />{provider.name}
                    </button>
                  )}</For>
                </div>
              </Show>
            </div>
          </header>
          <Show when={exportNote()}><p class="usage-note" role="status">{exportNote()}</p></Show>
          <Show when={importState()?.error}><p class="usage-note warn" role="alert"><Icon name="Warning2" size={13} />Local logs could not be read: {importState()!.error}</p></Show>
          <Switch>
            <Match when={!props.desktop}>
              <div class="usage-state"><span class="usage-state-mark"><Icon name="Usage" size={20} /></span><h2>Usage is recorded in the desktop app</h2><p>The browser preview does not run agents, so it has no usage to show.</p></div>
            </Match>
            <Match when={error()}>
              <div class="usage-state" role="alert"><span class="usage-state-mark"><Icon name="Warning2" size={20} /></span><h2>Usage could not be read</h2><p>{error()}</p><button type="button" class="usage-button" onClick={() => void load()}><Icon name="Refresh2" size={13} />Try again</button></div>
            </Match>
            <Match when={!data()}>
              <div class="usage-loading" aria-busy="true" aria-label="Loading usage"><div class="usage-tiles"><For each={[0, 1, 2, 3]}>{() => <div class="usage-tile skeleton" />}</For></div><div class="usage-panel skeleton tall" /></div>
            </Match>
            <Match when={!hasUsage()}>
              <div class="usage-state">
                <Show when={scanning()} fallback={<span class="usage-state-mark"><Icon name="Usage" size={20} /></span>}><span class="usage-spinner large" aria-hidden="true" /></Show>
                <h2>{scanning() ? "Reading your local logs" : (summary()?.trackedSessions ?? 0) > 0 ? `Nothing in ${range() === "today" ? "today's sessions" : `the last ${rangeLabel().toLowerCase()}`}` : "No usage yet"}</h2>
                <p>{scanning() ? "Usage appears here as files are read. This runs in the background, so you can keep working." : (summary()?.trackedSessions ?? 0) > 0 ? "Pick a longer range to see earlier sessions." : props.importEnabled ? "Span found no usage in Claude Code's, Codex's, Gemini CLI's or OpenCode's local logs, and has not tracked any sessions yet. Chat with an agent and its usage appears here." : "Span counts tokens and cost as agents report them at the end of each turn. Chat with an agent and its usage appears here."}</p>
                <Show when={!scanning() && (summary()?.trackedSessions ?? 0) > 0 && range() !== "all"}><button type="button" class="usage-button" onClick={() => setRange("all")}>Show all time</button></Show>
                <Show when={!scanning() && props.onImportChange && !props.importEnabled}><button type="button" class="usage-button" disabled={importBusy()} onClick={() => void toggleImport(true)}><Icon name="Import" size={13} />Read local logs</button></Show>
              </div>
            </Match>
            <Match when={totals()}>
              {(current) => <>
                <Show when={scanning()}><p class="usage-note" role="status"><Icon name="InfoCircle" size={13} />Partial results: figures grow as the scan reads more files.</p></Show>
                <div class="usage-tiles" aria-busy={loading()}>
                  <div class="usage-tile">
                    <span class="usage-tile-label">Estimated cost<Delta current={money(current().cost.usd)} previous={previousTotals()?.cost.known ? money(previousTotals()!.cost.usd) : undefined} /></span>
                    <strong class="usage-hero" classList={{ "usage-unknown": !current().cost.known }} title={costText(current().cost).title}>{costText(current().cost).text}</strong>
                    <span class="usage-tile-foot" title="API-equivalent cost at list prices, not your subscription bill">API-equivalent estimate</span>
                  </div>
                  <div class="usage-tile">
                    <span class="usage-tile-label">Total tokens<Delta current={current().tokens.total} previous={previousTotals()?.tokens.total} /></span>
                    <strong class="usage-hero" title={`${fullNumber(current().tokens.total)} tokens`}>{compactTokens(current().tokens.total)}</strong>
                    <TokenMix tokens={current().tokens} />
                  </div>
                  <div class="usage-tile">
                    <span class="usage-tile-label">Sessions<Delta current={current().sessions} previous={previousTotals()?.sessions} /></span>
                    <strong class="usage-hero">{fullNumber(current().sessions)}</strong>
                    <span class="usage-tile-foot">{fullNumber(current().turns)} turns<Show when={current().turns > current().turnsWithTokens}> · {fullNumber(current().turns - current().turnsWithTokens)} without token counts</Show></span>
                  </div>
                  <div class="usage-tile">
                    <span class="usage-tile-label">Top model</span>
                    <Show when={topModel()} fallback={<strong class="usage-hero usage-unknown">Not named</strong>}>
                      {(model) => <strong class="usage-hero usage-model-hero" title={model().model}><ModelIcon id={brandId(model().agentIds[0] ?? "")} name={agentName(model().agentIds[0] ?? "")} traits={[]} size={18} model={{ value: model().model, name: model().model }} /><span>{model().price?.label ?? model().model}</span></strong>}
                    </Show>
                    <span class="usage-tile-foot"><Show when={topModel()}>{(model) => <>{shareText(model().totals.tokens.total, totalTokens())} of tokens · {fullNumber(models().length)} {models().length === 1 ? "model" : "models"}</>}</Show></span>
                  </div>
                </div>
                <Panel title={metric() === "tokens" ? "Tokens over time" : "Estimated cost over time"} class="usage-chart-panel" actions={<>
                  <div class="usage-segmented small" role="group" aria-label="Group chart by">
                    <button type="button" aria-pressed={groupBy() === "agent"} onClick={() => setGroupBy("agent")}>By agent</button>
                    <button type="button" aria-pressed={groupBy() === "model"} onClick={() => setGroupBy("model")}>By model</button>
                  </div>
                  <div class="usage-segmented small" role="group" aria-label="Chart measure">
                    <button type="button" aria-pressed={metric() === "tokens"} onClick={() => setMetric("tokens")}>Tokens</button>
                    <button type="button" aria-pressed={metric() === "cost"} onClick={() => setMetric("cost")}>Cost</button>
                  </div>
                  <button type="button" class="usage-text-button" aria-pressed={showTable()} onClick={() => setShowTable(!showTable())}>{showTable() ? "Chart" : "Table"}</button>
                </>}>
                  <div class="usage-legend" aria-label="Legend">
                    <For each={legendRows()}>{(row) => <span><i style={{ background: seriesVar(row.slot) }} />{row.name}<b>{metric() === "tokens" ? compactTokens(row.tokens) : costShort(row.cost).text}</b></span>}</For>
                    <Show when={view().chart.weekly}><span class="usage-legend-note">Weekly totals</span></Show>
                  </div>
                  <Switch>
                    <Match when={showTable()}><UsageChartTable columns={view().chart.columns} series={view().series} weekly={view().chart.weekly} /></Match>
                    <Match when={view().chart.columns.length === 1 ? view().chart.columns[0] : undefined}>{(column) => <UsageShare column={column()} series={view().series} metric={metric()} />}</Match>
                    <Match when={true}><UsageChart columns={view().chart.columns} series={view().series} metric={metric()} weekly={view().chart.weekly} /></Match>
                  </Switch>
                </Panel>
                <div class="usage-split">
                  <ModelList rows={models()} totalTokens={totalTokens()} agentName={agentName} />
                  <div class="usage-stack">
                    <ProviderList rows={providerRows()} totalTokens={totalTokens()} />
                    <Show when={props.importEnabled && source() === "all" && sourceSplit().imported.sessions > 0}><SourceList tracked={sourceSplit().tracked} imported={sourceSplit().imported} /></Show>
                  </div>
                </div>
                <SessionTable rows={sessions()} onOpen={props.onOpenSession ? (row) => props.onOpenSession!(row) : undefined} canOpen={props.canOpenSession} actions={
                  <button type="button" class="usage-button" disabled={!props.onExport || exporting() || !sessions().length} title={props.onExport ? "Export these sessions as CSV into the open folder" : props.exportUnavailable} onClick={() => void exportCsv()}><Icon name="ExportSquare" size={13} />Export CSV</button>
                } />
                <details class="usage-footnote">
                  <summary><Icon name="InfoCircle" size={13} />Pricing and estimates<Show when={unpriced().length}><span class="usage-footnote-count">{unpriced().length} {unpriced().length === 1 ? "model" : "models"} without a price</span></Show><Show when={skippedSources() > 0}><span class="usage-footnote-count">{fullNumber(skippedSources())} {skippedSources() === 1 ? "source" : "sources"} not read</span></Show><Icon name="arrow-down4" size={11} class="usage-footnote-chevron" /></summary>
                  <div class="usage-footnote-body">
                    <p>Dollar figures are API-equivalent estimates at list prices, not your subscription bill: Claude and ChatGPT plans have usage limits, not per-token charges. Where an agent reported its own cost, that figure is used.</p>
                    <Show when={summary()?.prices}>{(prices) => <p>Prices as of {prices().asOf} from the <For each={prices().sources}>{(entry, index) => <>{index() > 0 ? (index() === prices().sources.length - 1 ? " and " : ", ") : ""}<a href={entry.url} target="_blank" rel="noreferrer noopener" onClick={(event) => openExternal(event, entry.url)}>{entry.provider}</a></>}</For> pricing pages, standard tier. Set your own in <code>agents.usage.prices</code>.</p>}</Show>
                    <Show when={props.importEnabled && importState()?.report}>{(report) => <>
                      <p>Local logs: read only, counters only, nothing uploaded. {report().kinds.length ? `Found ${report().kinds.map((kind) => KIND_NAMES[kind] ?? kind).join(", ")} logs` : "No agent logs found"}, {fullNumber(report().filesTotal)} files{report().compressedRead ? `, ${fullNumber(report().compressedRead)} compressed` : ""}. Messages repeated across files (resumed sessions, subagents) count once.</p>
                      <ul class="usage-skips">
                        <Show when={report().compressedSkipped > 0}><li><Icon name="Warning2" size={12} />{fullNumber(report().compressedSkipped)} compressed Codex {report().compressedSkipped === 1 ? "log" : "logs"} (.zst) skipped: Span has no zstd reader yet.</li></Show>
                        <Show when={report().skipped > 0}><li><Icon name="Warning2" size={12} />{fullNumber(report().skipped)} {report().skipped === 1 ? "file" : "files"} skipped for a size cap or a read error.</li></Show>
                        <Show when={report().truncated}><li><Icon name="Warning2" size={12} />The file cap was reached, so the oldest logs may be missing.</li></Show>
                        <For each={report().notes}>{(note) => <li><Icon name="Warning2" size={12} />{note}</li>}</For>
                      </ul>
                    </>}</Show>
                    <Show when={unpriced().length}>
                      <div class="usage-chip-row"><For each={unpriced()}>{(model) => <span class="usage-noprice-chip" title={`${fullNumber(model.totals.tokens.total)} tokens are counted but not priced`}>No price for <span class="usage-mono">{model.model || "unnamed model"}</span></span>}</For></div>
                    </Show>
                  </div>
                </details>
              </>}
            </Match>
          </Switch>
        </div>
      </div>
    </div>
  );
}

/** Input, output and cache as one thin bar in neutral steps, with exact numbers in the labels' tooltips. */
function TokenMix(props: { tokens: UsageSummary["totals"]["tokens"] }) {
  const parts = () => [
    { key: "in", label: "Input", value: props.tokens.input },
    { key: "out", label: "Output", value: props.tokens.output },
    { key: "read", label: "Cache read", value: props.tokens.cacheRead },
    { key: "write", label: "Cache write", value: props.tokens.cacheWrite },
  ];
  /** Labels name input, output and cache (read plus write); the bar keeps the four parts apart. */
  const labels = () => [parts()[0], parts()[1], { key: "read", label: "Cache", value: props.tokens.cacheRead + props.tokens.cacheWrite, title: `${fullNumber(props.tokens.cacheRead)} cache read and ${fullNumber(props.tokens.cacheWrite)} cache write tokens` }];
  const sum = () => parts().reduce((total, part) => total + part.value, 0) || 1;
  return (
    <span class="usage-mix">
      <span class="usage-mix-bar" aria-hidden="true"><For each={parts().filter((part) => part.value > 0)}>{(part) => <i class={`mix-${part.key}`} style={{ "flex-grow": part.value / sum() }} />}</For></span>
      <span class="usage-mix-labels"><For each={labels().filter((part) => part.value > 0)}>{(part) => <span title={"title" in part ? part.title : `${fullNumber(part.value)} ${part.label.toLowerCase()} tokens`}><i class={`mix-${part.key}`} />{part.label}<b>{compactTokens(part.value)}</b></span>}</For></span>
    </span>
  );
}
