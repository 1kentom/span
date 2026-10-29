import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { SessionUsageRow_Serialize as SessionUsageRow, UsageRange_Deserialize as UsageRange, UsageSummary_Serialize as UsageSummary } from "../../bindings";
import { Icon } from "../Icon";
import { ModelIcon } from "../agent/ModelPopover";
import { UsageChart, UsageChartTable, type ChartMetric, type SeriesInfo } from "./UsageChart";
import { AgentTable, ModelTable, SessionTable } from "./UsageTables";
import { RANGES, assignSlots, compactTokens, costText, csvFileName, fullNumber, money, rangeFor, usageCsv, usd, type RangeKey } from "../../lib/usage";
import "../../styles/usage.css";

export type UsageApi = {
  summary: (range: UsageRange) => Promise<UsageSummary | undefined>;
  sessions: (range: UsageRange) => Promise<SessionUsageRow[]>;
};

type Loaded = { summary?: UsageSummary; sessions: SessionUsageRow[] };

/**
 * The Usage page (ADR 0012): tokens and API-equivalent cost estimates per agent, model, session and day, from what
 * agents reported to Span over ACP. Every dollar figure is labelled an estimate; an unknown price shows no amount.
 */
export function UsagePage(props: {
  api: UsageApi;
  desktop: boolean;
  onClose: () => void;
  /** Saves the CSV. Absent when export is unavailable, with `exportUnavailable` saying why. */
  onExport?: (fileName: string, text: string) => Promise<void>;
  exportUnavailable?: string;
  onOpenExternal?: (url: string) => void;
}) {
  const [range, setRange] = createSignal<RangeKey>("30d");
  const [metric, setMetric] = createSignal<ChartMetric>("tokens");
  const [showTable, setShowTable] = createSignal(false);
  const [data, setData] = createSignal<Loaded>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [exporting, setExporting] = createSignal(false);
  const [exportNote, setExportNote] = createSignal("");
  let heading: HTMLHeadingElement | undefined;
  let request = 0;
  const restore = document.activeElement as HTMLElement | null;

  async function load() {
    const id = ++request;
    setLoading(true);
    setError("");
    try {
      const target = rangeFor(range());
      const [summary, sessions] = await Promise.all([props.api.summary(target), props.api.sessions(target)]);
      if (id === request) setData({ summary, sessions });
    } catch (cause) {
      if (id === request) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (id === request) setLoading(false);
    }
  }
  createEffect(on(range, () => void load()));
  onMount(() => heading?.focus());
  onCleanup(() => { request += 1; if (restore?.isConnected) restore.focus(); });
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); props.onClose(); } };

  const summary = () => data()?.summary;
  const series = createMemo<SeriesInfo[]>(() => {
    const agents = summary()?.agents ?? [];
    const slots = assignSlots(agents.map((agent) => agent.agentId));
    return agents
      .map((agent) => ({ id: agent.agentId, name: agent.name, slot: slots.get(agent.agentId) ?? ("other" as const) }))
      .sort((a, b) => (a.slot === "other" ? 99 : a.slot) - (b.slot === "other" ? 99 : b.slot));
  });
  const totalTokens = () => summary()?.totals.tokens.total ?? 0;
  const share = (id: string) => {
    const agent = summary()?.agents.find((entry) => entry.agentId === id);
    return totalTokens() > 0 && agent ? Math.round((agent.totals.tokens.total / totalTokens()) * 100) : 0;
  };
  const agentName = (id: string) => summary()?.agents.find((entry) => entry.agentId === id)?.name ?? id;
  const topModel = createMemo(() => summary()?.models.find((model) => model.model === summary()?.topModel));
  const hasUsage = () => (summary()?.totals.turns ?? 0) > 0 || (summary()?.totals.tokens.total ?? 0) > 0;
  const rangeLabel = () => RANGES.find((entry) => entry.key === range())?.label ?? "";
  const asOf = () => summary()?.prices.asOf;

  async function exportCsv() {
    if (!props.onExport) return;
    setExporting(true);
    setExportNote("");
    try {
      const target = rangeFor(range());
      const rows = await props.api.sessions(target);
      const name = csvFileName();
      await props.onExport(name, usageCsv(rows));
      setExportNote(`Saved ${name}`);
    } catch (cause) {
      setExportNote(`Export failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div class="usage-page" role="region" aria-labelledby="usage-title" onKeyDown={onKey}>
      <header class="usage-toolbar">
        <div class="usage-title">
          <span class="usage-title-icon"><Icon name="Usage" size={18} /></span>
          <div>
            <h1 id="usage-title" tabindex="-1" ref={heading}>Usage</h1>
            <p>Tokens and cost estimates for every agent session Span tracked</p>
          </div>
        </div>
        <span class="usage-spacer" />
        <div class="usage-segmented" role="group" aria-label="Date range">
          <For each={RANGES}>{(entry) => <button type="button" aria-pressed={range() === entry.key} onClick={() => setRange(entry.key)}>{entry.label}</button>}</For>
        </div>
        <button type="button" class="usage-icon-button" aria-label="Refresh usage" title="Refresh" disabled={loading()} onClick={() => void load()}><Icon name="Refresh2" size={15} /></button>
        <button type="button" class="usage-button" disabled={!props.onExport || exporting() || !data()?.sessions.length} title={props.onExport ? "Export the sessions of this range as CSV into the open folder" : props.exportUnavailable} onClick={() => void exportCsv()}><Icon name="ExportSquare" size={14} />Export CSV</button>
        <button type="button" class="usage-icon-button" aria-label="Close usage" title="Close (Escape)" onClick={() => props.onClose()}><span class="cross" /></button>
      </header>
      <div class="usage-scroll">
        <div class="usage-content">
          <div class="usage-notice" role="note">
            <Icon name="InfoCircle" size={15} />
            <p>
              <strong>Cost figures are estimates.</strong> They are API-equivalent cost at list prices, not your subscription bill: Claude and ChatGPT plans have usage limits, not per-token charges. Where an agent reported its own cost, that figure is used.
              <Show when={asOf()}> Prices as of {asOf()} from the <For each={summary()?.prices.sources ?? []}>{(source, index) => <>{index() > 0 ? (index() === (summary()?.prices.sources.length ?? 0) - 1 ? " and " : ", ") : ""}<a href={source.url} onClick={(event) => { if (props.onOpenExternal) { event.preventDefault(); props.onOpenExternal(source.url); } }} target="_blank" rel="noreferrer noopener">{source.provider}</a></>}</For> pricing pages. Set your own in <code>agents.usage.prices</code>.</Show>
            </p>
            <span class="usage-source-chip" title="Counted from what agents reported to Span over the Agent Client Protocol. Sessions run outside Span are not included.">Tracked by Span</span>
          </div>
          <Show when={exportNote()}><p class="usage-export-note" role="status">{exportNote()}</p></Show>
          <Switch>
            <Match when={!props.desktop}>
              <div class="usage-empty"><Icon name="Usage" size={28} /><h2>Usage is recorded in the desktop app</h2><p>The browser preview does not run agents, so it has no usage to show.</p></div>
            </Match>
            <Match when={error()}>
              <div class="usage-empty usage-error" role="alert"><Icon name="Warning2" size={28} /><h2>Usage could not be read</h2><p>{error()}</p><button type="button" class="usage-button" onClick={() => void load()}><Icon name="Refresh2" size={14} />Try again</button></div>
            </Match>
            <Match when={!data()}>
              <div class="usage-loading" aria-busy="true" aria-label="Loading usage"><div class="usage-tiles"><For each={[0, 1, 2, 3]}>{() => <div class="usage-tile skeleton" />}</For></div><div class="usage-card skeleton tall" /></div>
            </Match>
            <Match when={!hasUsage()}>
              <div class="usage-empty">
                <Icon name="Usage" size={28} />
                <h2>{(summary()?.trackedSessions ?? 0) > 0 ? `No usage in ${range() === "today" ? "today's sessions" : `the last ${rangeLabel().toLowerCase()}`}` : "No usage recorded yet"}</h2>
                <p>{(summary()?.trackedSessions ?? 0) > 0 ? "Pick a longer range to see earlier sessions." : "Span counts tokens and cost as agents report them at the end of each turn. Chat with an agent and its usage appears here."}</p>
                <Show when={(summary()?.trackedSessions ?? 0) > 0 && range() !== "all"}><button type="button" class="usage-button" onClick={() => setRange("all")}>Show all time</button></Show>
              </div>
            </Match>
            <Match when={summary()}>
              {(current) => <>
                <div class="usage-tiles" aria-busy={loading()}>
                  <div class="usage-tile">
                    <span class="usage-tile-label">Cost estimate</span>
                    <strong class="usage-hero" classList={{ "usage-unknown": !current().totals.cost.known }} title={costText(current().totals.cost).title}>{costText(current().totals.cost).text}</strong>
                    <span class="usage-tile-foot">API-equivalent · {rangeLabel()}<Show when={money(current().totals.cost.reportedUsd) > 0}> · {usd(money(current().totals.cost.reportedUsd))} agent reported</Show></span>
                  </div>
                  <div class="usage-tile">
                    <span class="usage-tile-label">Tokens</span>
                    <strong class="usage-hero" title={`${fullNumber(current().totals.tokens.total)} tokens`}>{compactTokens(current().totals.tokens.total)}</strong>
                    <span class="usage-tile-split">
                      <span title={`${fullNumber(current().totals.tokens.input)} input tokens`}><em>In</em>{compactTokens(current().totals.tokens.input)}</span>
                      <span title={`${fullNumber(current().totals.tokens.output)} output tokens`}><em>Out</em>{compactTokens(current().totals.tokens.output)}</span>
                      <span title={`${fullNumber(current().totals.tokens.cacheRead)} cache read, ${fullNumber(current().totals.tokens.cacheWrite)} cache write tokens`}><em>Cache</em>{compactTokens(current().totals.tokens.cacheRead + current().totals.tokens.cacheWrite)}</span>
                    </span>
                  </div>
                  <div class="usage-tile">
                    <span class="usage-tile-label">Sessions</span>
                    <strong class="usage-hero">{fullNumber(current().totals.sessions)}</strong>
                    <span class="usage-tile-foot">{fullNumber(current().totals.turns)} turns<Show when={current().totals.turns > current().totals.turnsWithTokens}> · {fullNumber(current().totals.turns - current().totals.turnsWithTokens)} without token counts</Show></span>
                  </div>
                  <div class="usage-tile">
                    <span class="usage-tile-label">Most used model</span>
                    <Show when={topModel()} fallback={<strong class="usage-hero usage-unknown">Not named</strong>}>
                      {(model) => <strong class="usage-hero usage-model-hero" title={model().model}><ModelIcon id={model().agentIds[0]} name={agentName(model().agentIds[0] ?? "")} traits={[]} size={18} model={{ value: model().model, name: model().model }} /><span>{model().price?.label ?? model().model}</span></strong>}
                    </Show>
                    <span class="usage-tile-foot"><Show when={topModel()}>{(model) => <>{totalTokens() > 0 ? `${Math.round((model().totals.tokens.total / totalTokens()) * 100)}% of tokens` : `${fullNumber(model().totals.turns)} turns`} · {fullNumber(current().models.length)} models</>}</Show></span>
                  </div>
                </div>
                <section class="usage-card" aria-label="Usage over time">
                  <header class="usage-card-head">
                    <h2>{`${metric() === "tokens" ? "Tokens" : "Cost estimate"} ${current().days.length === 1 ? "today" : "per day"}`}</h2>
                    <span class="usage-card-sub">by agent</span>
                    <span class="usage-spacer" />
                    <div class="usage-segmented small" role="group" aria-label="Chart measure">
                      <button type="button" aria-pressed={metric() === "tokens"} onClick={() => setMetric("tokens")}>Tokens</button>
                      <button type="button" aria-pressed={metric() === "cost"} onClick={() => setMetric("cost")}>Cost</button>
                    </div>
                    <button type="button" class="usage-text-button" aria-pressed={showTable()} onClick={() => setShowTable(!showTable())}>{showTable() ? "Show chart" : "Show table"}</button>
                  </header>
                  <Show when={showTable()} fallback={<UsageChart days={current().days} series={series()} metric={metric()} />}>
                    <UsageChartTable days={current().days} series={series()} />
                  </Show>
                </section>
                <div class="usage-split">
                  <AgentTable rows={current().agents} share={share} />
                  <ModelTable rows={current().models} agentName={agentName} />
                </div>
                <SessionTable rows={data()?.sessions ?? []} />
              </>}
            </Match>
          </Switch>
        </div>
      </div>
    </div>
  );
}
