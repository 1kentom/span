import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { UsageCost } from "../../bindings";
import { compactTokens, costShort, fullNumber, longDay, money, shortDay, sumCosts, usd, usdShort, type ChartColumn } from "../../lib/usage";

export type ChartMetric = "tokens" | "cost";
/** A chart series: a provider (or a model). `slot` picks the colour token, so colour follows the entity, never its rank. */
export type SeriesInfo = { key: string; name: string; slot: number | "other" };

export const seriesVar = (slot: number | "other") => (slot === "other" ? "var(--viz-other)" : `var(--viz-${slot})`);

/** A round axis maximum and three to five ticks for `max`. */
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0];
  const rough = max / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((candidate) => candidate >= rough) ?? 10 * power;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(value);
  return ticks;
}

/** "$0", "$12", "$1.2k": axis labels only; exact amounts are in the tooltip and the table. */
export function compactUsd(value: number): string {
  if (!(value > 0)) return "$0";
  if (value < 10) return `$${value.toFixed(value < 1 ? 2 : 1).replace(/\.0+$/, "")}`;
  if (value < 1000) return `$${Math.round(value)}`;
  return `$${compactTokens(value)}`;
}

type Segment = { series: SeriesInfo; tokens: number; cost: UsageCost; value: number };
type Column = { start: string; end: string; total: number; segments: Segment[]; unpriced: number };

const AXIS = 52;
const BOTTOM = 26;
const TOP = 10;
const GAP = 2;
const MAX_BAR = 24;

/**
 * Daily stacked columns by series, drawn as inline SVG at the measured width. Thin bars with a 2px surface gap between
 * segments and a 4px rounded data end; hairline gridlines; hover or the arrow keys show a tooltip with exact numbers.
 * The legend names every series, so identity is never colour alone, and the page offers the same numbers as a table.
 */
export function UsageChart(props: { columns: readonly ChartColumn[]; series: readonly SeriesInfo[]; metric: ChartMetric; weekly?: boolean }) {
  const [width, setWidth] = createSignal(960);
  const [active, setActive] = createSignal<number>();
  let host: HTMLDivElement | undefined;
  onMount(() => {
    if (!host) return;
    if (host.clientWidth > 0) setWidth(host.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => { const next = entries[0]?.contentRect.width; if (next && next > 0) setWidth(Math.round(next)); });
    observer.observe(host);
    onCleanup(() => observer.disconnect());
  });
  const order = (series: SeriesInfo) => (series.slot === "other" ? 99 : series.slot);
  const columns = createMemo<Column[]>(() =>
    props.columns.map((column) => {
      const segments: Segment[] = [];
      let unpriced = 0;
      for (const series of props.series) {
        const entry = column.values.get(series.key);
        if (!entry) continue;
        if (!entry.cost.known || !entry.cost.complete) unpriced += entry.cost.known ? entry.cost.unpricedTokens : entry.tokens;
        const value = props.metric === "tokens" ? entry.tokens : entry.cost.known ? money(entry.cost.usd) : 0;
        segments.push({ series, tokens: entry.tokens, cost: entry.cost, value });
      }
      segments.sort((a, b) => order(a.series) - order(b.series));
      return { start: column.start, end: column.end, total: segments.reduce((sum, segment) => sum + segment.value, 0), segments, unpriced };
    }),
  );
  const ticks = createMemo(() => niceTicks(Math.max(0, ...columns().map((column) => column.total))));
  const top = () => ticks()[ticks().length - 1] || 1;
  const plotWidth = () => Math.max(120, width() - AXIS - 4);
  /** Taller on wide windows so the bars keep a calm aspect ratio. */
  const height = () => Math.round(Math.min(380, Math.max(240, width() * 0.2)));
  const plotHeight = () => height() - TOP - BOTTOM;
  const band = () => plotWidth() / Math.max(1, columns().length);
  const bar = () => Math.max(2, Math.min(MAX_BAR, band() * 0.64));
  const x = (index: number) => AXIS + index * band() + (band() - bar()) / 2;
  const y = (value: number) => TOP + plotHeight() - (value / top()) * plotHeight();
  const axisLabel = (value: number) => (props.metric === "tokens" ? compactTokens(value) : compactUsd(value));
  const exact = (value: number) => (props.metric === "tokens" ? `${fullNumber(value)} tokens` : usd(value));
  const labelEvery = createMemo(() => Math.max(1, Math.ceil(columns().length / Math.max(3, Math.floor(plotWidth() / 92)))));
  const label = (column: Column) => (props.weekly ? `Week of ${longDay(column.start)}` : longDay(column.start));
  const description = createMemo(() => {
    const total = columns().reduce((sum, column) => sum + column.total, 0);
    const busiest = columns().reduce<Column | undefined>((best, column) => (!best || column.total > best.total ? column : best), undefined);
    const what = props.metric === "tokens" ? "Tokens" : "Estimated cost";
    return `${what} per ${props.weekly ? "week" : "day"}, ${columns().length} ${props.weekly ? "weeks" : "days"}, ${exact(total)} in total${busiest && busiest.total > 0 ? `, highest ${props.weekly ? "in the week of" : "on"} ${longDay(busiest.start)} with ${exact(busiest.total)}` : ""}. Use the left and right arrow keys to read each ${props.weekly ? "week" : "day"}.`;
  });
  const move = (event: KeyboardEvent) => {
    const count = columns().length;
    if (!count) return;
    const current = active();
    const next = event.key === "ArrowRight" ? Math.min(count - 1, (current ?? -1) + 1) : event.key === "ArrowLeft" ? Math.max(0, (current ?? count) - 1) : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : event.key === "Escape" ? undefined : current;
    if (next !== current || event.key === "Escape") { event.preventDefault(); setActive(next); }
  };
  /** A stacked segment: square at the bottom, rounded 4px only on the column's top end. */
  const segmentPath = (left: number, bottom: number, height: number, w: number, rounded: boolean) => {
    const r = rounded ? Math.min(4, w / 2, height) : 0;
    const t = bottom - height;
    return `M${left},${bottom}V${t + r}${r ? `Q${left},${t} ${left + r},${t}` : ""}H${left + w - r}${r ? `Q${left + w},${t} ${left + w},${t + r}` : ""}V${bottom}Z`;
  };
  const stacks = createMemo(() =>
    columns().map((column, index) => {
      const pieces: { d: string; slot: number | "other" }[] = [];
      let base = TOP + plotHeight();
      const visible = column.segments.filter((segment) => segment.value > 0);
      visible.forEach((segment, position) => {
        const full = (segment.value / top()) * plotHeight();
        const gap = position > 0 && full > GAP + 1 ? GAP : 0;
        const height = Math.max(position === 0 ? 1 : 0, full - gap);
        const bottom = base - gap;
        if (height > 0) pieces.push({ d: segmentPath(x(index), bottom, height, bar(), position === visible.length - 1), slot: segment.series.slot });
        base = bottom - height;
      });
      return pieces;
    }),
  );
  const tooltip = createMemo(() => {
    const index = active();
    if (index === undefined) return undefined;
    const column = columns()[index];
    if (!column) return undefined;
    const center = x(index) + bar() / 2;
    return { column, left: center, align: center > width() * 0.62 ? "end" : center < width() * 0.3 ? "start" : "middle" };
  });
  return (
    <div class="usage-chart" ref={host}>
      <div class="usage-plot" tabindex="0" role="img" aria-label={description()} onKeyDown={move} onBlur={() => setActive(undefined)} onMouseLeave={() => setActive(undefined)}>
        <svg width={width()} height={height()} viewBox={`0 0 ${width()} ${height()}`} aria-hidden="true">
          <For each={ticks()}>{(tick) => <>
            <line class="usage-grid" x1={AXIS} x2={width()} y1={Math.round(y(tick)) + 0.5} y2={Math.round(y(tick)) + 0.5} />
            <text class="usage-axis-label" x={AXIS - 10} y={y(tick) + 3.5} text-anchor="end">{axisLabel(tick)}</text>
          </>}</For>
          <Show when={active() !== undefined}>
            <rect class="usage-hover-band" x={AXIS + (active() ?? 0) * band()} y={TOP} width={band()} height={plotHeight()} rx="3" />
          </Show>
          <For each={stacks()}>{(pieces) => <For each={pieces}>{(piece) => <path d={piece.d} fill={seriesVar(piece.slot)} />}</For>}</For>
          <For each={columns()}>{(column, index) => (
            <Show when={index() % labelEvery() === 0}>
              <text class="usage-axis-label" x={x(index()) + bar() / 2} y={height() - 8} text-anchor="middle">{shortDay(column.start)}</text>
            </Show>
          )}</For>
          <For each={columns()}>{(_, index) => <rect class="usage-hit" x={AXIS + index() * band()} y={TOP} width={band()} height={plotHeight() + BOTTOM} onMouseEnter={() => setActive(index())} />}</For>
        </svg>
        <Show when={tooltip()}>
          {(tip) => (
            <div class="usage-tooltip" data-align={tip().align} style={{ left: `${tip().left}px` }} role="status">
              <strong>{label(tip().column)}</strong>
              <Show when={tip().column.segments.length} fallback={<span class="usage-tooltip-empty">No usage</span>}>
                <For each={[...tip().column.segments].reverse()}>{(segment) => (
                  <span class="usage-tooltip-row">
                    <i style={{ background: seriesVar(segment.series.slot) }} />
                    <span>{segment.series.name}</span>
                    <b>{props.metric === "tokens" ? fullNumber(segment.tokens) : segment.cost.known ? usdShort(money(segment.cost.usd)) : "No price"}</b>
                    <small>{props.metric === "tokens" ? (segment.cost.known ? usdShort(money(segment.cost.usd)) : "No price") : compactTokens(segment.tokens)}</small>
                  </span>
                )}</For>
                <Show when={tip().column.segments.length > 1}>
                  <span class="usage-tooltip-row total"><i /><span>Total</span><b>{props.metric === "tokens" ? fullNumber(tip().column.segments.reduce((sum, s) => sum + s.tokens, 0)) : usdShort(tip().column.total)}</b><small>{props.metric === "tokens" ? costLabel(sumCosts(tip().column.segments.map((s) => s.cost))) : compactTokens(tip().column.segments.reduce((sum, s) => sum + s.tokens, 0))}</small></span>
                </Show>
                <Show when={tip().column.unpriced > 0}><span class="usage-tooltip-note">{compactTokens(tip().column.unpriced)} tokens have no price</span></Show>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}

const costLabel = (cost: UsageCost) => costShort(cost).text;

/** One day: a single share bar, because one column on a time axis says nothing. */
export function UsageShare(props: { column: ChartColumn; series: readonly SeriesInfo[]; metric: ChartMetric }) {
  const segments = createMemo(() => props.series.map((series) => {
    const entry = props.column.values.get(series.key);
    return { series, value: entry ? (props.metric === "tokens" ? entry.tokens : entry.cost.known ? money(entry.cost.usd) : 0) : 0 };
  }).filter((segment) => segment.value > 0));
  const total = () => segments().reduce((sum, segment) => sum + segment.value, 0);
  const format = (value: number) => (props.metric === "tokens" ? compactTokens(value) : usd(value));
  return (
    <div class="usage-share" role="img" aria-label={`${props.metric === "tokens" ? "Tokens" : "Estimated cost"} today: ${segments().map((s) => `${s.series.name} ${format(s.value)}`).join(", ") || "no usage"}`}>
      <div class="usage-share-bar">
        <Show when={total() > 0} fallback={<span class="usage-share-empty" />}>
          <For each={segments()}>{(segment) => <span style={{ "flex-grow": segment.value, background: seriesVar(segment.series.slot) }} />}</For>
        </Show>
      </div>
      <div class="usage-share-labels">
        <For each={segments()}>{(segment) => <span><i style={{ background: seriesVar(segment.series.slot) }} />{segment.series.name}<b>{format(segment.value)}</b><small>{Math.round((segment.value / (total() || 1)) * 100)}%</small></span>}</For>
      </div>
    </div>
  );
}

/** The chart's numbers as a table: the exact and accessible fallback. */
export function UsageChartTable(props: { columns: readonly ChartColumn[]; series: readonly SeriesInfo[]; weekly?: boolean }) {
  return (
    <div class="usage-table-wrap usage-chart-table">
      <table class="usage-table">
        <caption class="usage-visually-hidden">Tokens and estimated cost per {props.weekly ? "week" : "day"}</caption>
        <thead><tr><th scope="col">{props.weekly ? "Week of" : "Day"}</th><For each={props.series}>{(series) => <th scope="col" class="num">{series.name}</th>}</For><th scope="col" class="num">Total tokens</th><th scope="col" class="num">Cost estimate</th></tr></thead>
        <tbody>
          <For each={[...props.columns].reverse()}>{(column) => {
            const entries = [...column.values.values()];
            const tokens = entries.reduce((sum, entry) => sum + entry.tokens, 0);
            return <tr><th scope="row">{longDay(column.start)}</th><For each={props.series}>{(series) => <td class="num">{column.values.get(series.key) ? fullNumber(column.values.get(series.key)!.tokens) : "–"}</td>}</For><td class="num">{tokens ? fullNumber(tokens) : "–"}</td><td class="num">{tokens ? costLabel(sumCosts(entries.map((entry) => entry.cost))) : "–"}</td></tr>;
          }}</For>
        </tbody>
      </table>
    </div>
  );
}
