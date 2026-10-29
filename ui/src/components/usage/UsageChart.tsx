import { For, Show, createMemo, createSignal } from "solid-js";
import type { DayUsage } from "../../bindings";
import { compactTokens, costText, fullNumber, longDay, money, shortDay, usd } from "../../lib/usage";

export type ChartMetric = "tokens" | "cost";
export type SeriesInfo = { id: string; name: string; slot: number | "other" };

const seriesVar = (slot: number | "other") => (slot === "other" ? "var(--viz-other)" : `var(--viz-${slot})`);

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

type Column = { day: string; total: number; segments: { series: SeriesInfo; value: number }[] };

/**
 * Daily stacked bars by agent. Hover or arrow keys pick a day and show its tooltip; the legend names every series so
 * identity is never colour alone, and the page offers the same numbers as a table. One day renders as a single
 * horizontal share bar.
 */
export function UsageChart(props: { days: readonly DayUsage[]; series: readonly SeriesInfo[]; metric: ChartMetric }) {
  const [active, setActive] = createSignal<number>();
  const value = (slice: DayUsage["agents"][number]) => (props.metric === "tokens" ? slice.tokens : slice.cost.known ? money(slice.cost.usd) : 0);
  const format = (amount: number) => (props.metric === "tokens" ? compactTokens(amount) : usd(amount));
  const exact = (amount: number) => (props.metric === "tokens" ? `${fullNumber(amount)} tokens` : usd(amount));
  const columns = createMemo<Column[]>(() =>
    props.days.map((day) => {
      const bySlot = new Map<string, { series: SeriesInfo; value: number }>();
      for (const slice of day.agents) {
        const series = props.series.find((entry) => entry.id === slice.agentId) ?? { id: "other", name: "Other", slot: "other" as const };
        const key = series.slot === "other" ? "other" : series.id;
        const existing = bySlot.get(key);
        const named = series.slot === "other" ? { id: "other", name: "Other agents", slot: "other" as const } : series;
        bySlot.set(key, { series: named, value: (existing?.value ?? 0) + value(slice) });
      }
      const order = (entry: { series: SeriesInfo }) => (entry.series.slot === "other" ? 99 : entry.series.slot);
      const segments = [...bySlot.values()].filter((entry) => entry.value > 0).sort((a, b) => order(a) - order(b));
      return { day: day.day, total: segments.reduce((sum, entry) => sum + entry.value, 0), segments };
    }),
  );
  const legend = createMemo(() => {
    const named = props.series.filter((series) => series.slot !== "other");
    return props.series.some((series) => series.slot === "other") ? [...named, { id: "other", name: "Other agents", slot: "other" as const }] : named;
  });
  const ticks = createMemo(() => niceTicks(Math.max(0, ...columns().map((column) => column.total))));
  const top = () => ticks()[ticks().length - 1] || 1;
  const labelEvery = createMemo(() => Math.max(1, Math.ceil(columns().length / 10)));
  const summary = createMemo(() => {
    const total = columns().reduce((sum, column) => sum + column.total, 0);
    const busiest = columns().reduce<Column | undefined>((best, column) => (!best || column.total > best.total ? column : best), undefined);
    const metric = props.metric === "tokens" ? "Tokens" : "Estimated cost";
    return `${metric} per day by agent, ${columns().length} days, ${exact(total)} in total${busiest && busiest.total > 0 ? `, highest on ${longDay(busiest.day)} with ${exact(busiest.total)}` : ""}. Use the left and right arrow keys to read each day, or show the table.`;
  });
  const move = (event: KeyboardEvent) => {
    const count = columns().length;
    if (!count) return;
    const current = active();
    const next = event.key === "ArrowRight" ? Math.min(count - 1, (current ?? -1) + 1) : event.key === "ArrowLeft" ? Math.max(0, (current ?? count) - 1) : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : event.key === "Escape" ? undefined : current;
    if (next !== current || event.key === "Escape") { event.preventDefault(); setActive(next); }
  };
  const Tooltip = (tooltip: { column: Column; align: "start" | "middle" | "end" }) => (
    <div class="usage-tooltip" data-align={tooltip.align} role="status">
      <strong>{longDay(tooltip.column.day)}</strong>
      <Show when={tooltip.column.segments.length} fallback={<span class="usage-tooltip-empty">No usage</span>}>
        <For each={[...tooltip.column.segments].reverse()}>{(segment) => (
          <span class="usage-tooltip-row"><i style={{ background: seriesVar(segment.series.slot) }} /><span>{segment.series.name}</span><b>{exact(segment.value)}</b></span>
        )}</For>
        <Show when={tooltip.column.segments.length > 1}><span class="usage-tooltip-row total"><i /><span>Total</span><b>{exact(tooltip.column.total)}</b></span></Show>
      </Show>
    </div>
  );
  return (
    <div class="usage-chart">
      <div class="usage-legend" aria-label="Legend">
        <For each={legend()}>{(series) => <span><i style={{ background: seriesVar(series.slot) }} />{series.name}</span>}</For>
      </div>
      <Show when={columns().length === 1 ? columns()[0] : undefined} fallback={
        <div class="usage-plot" tabindex="0" role="img" aria-label={summary()} onKeyDown={move} onBlur={() => setActive(undefined)} onMouseLeave={() => setActive(undefined)}>
          <div class="usage-axis" aria-hidden="true">
            <For each={[...ticks()].reverse()}>{(tick) => <span>{format(tick)}</span>}</For>
          </div>
          <div class="usage-grid-area">
            <div class="usage-gridlines" aria-hidden="true"><For each={ticks()}>{() => <i />}</For></div>
            <div class="usage-columns" style={{ "--usage-columns": columns().length }}>
              <For each={columns()}>{(column, index) => (
                <div class="usage-column" classList={{ active: active() === index() }} onMouseEnter={() => setActive(index())}>
                  <div class="usage-stack" style={{ height: `${(column.total / top()) * 100}%` }}>
                    <For each={column.segments}>{(segment) => <span class="usage-segment" style={{ "flex-grow": segment.value, background: seriesVar(segment.series.slot) }} />}</For>
                  </div>
                  <span class="usage-x" aria-hidden="true">{index() % labelEvery() === 0 || index() === columns().length - 1 ? shortDay(column.day) : ""}</span>
                  <Show when={active() === index()}><Tooltip column={column} align={index() >= columns().length / 2 ? "end" : "start"} /></Show>
                </div>
              )}</For>
            </div>
          </div>
        </div>
      }>
        {(column) => (
          <div class="usage-share" role="img" aria-label={`${props.metric === "tokens" ? "Tokens" : "Estimated cost"} today by agent: ${column().segments.map((s) => `${s.series.name} ${exact(s.value)}`).join(", ") || "no usage"}`}>
            <div class="usage-share-bar">
              <Show when={column().total > 0} fallback={<span class="usage-share-empty" />}>
                <For each={column().segments}>{(segment) => <span style={{ "flex-grow": segment.value, background: seriesVar(segment.series.slot) }} title={`${segment.series.name}: ${exact(segment.value)}`} />}</For>
              </Show>
            </div>
            <div class="usage-share-labels">
              <For each={column().segments}>{(segment) => <span><i style={{ background: seriesVar(segment.series.slot) }} />{segment.series.name}<b>{format(segment.value)}</b><small>{Math.round((segment.value / (column().total || 1)) * 100)}%</small></span>}</For>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}

/** The chart's numbers as a table (the accessible and exact fallback). */
export function UsageChartTable(props: { days: readonly DayUsage[]; series: readonly SeriesInfo[] }) {
  const cell = (day: DayUsage, id: string) => day.agents.find((slice) => slice.agentId === id);
  return (
    <div class="usage-table-wrap">
      <table class="usage-table compact">
        <caption class="usage-visually-hidden">Tokens and estimated cost per day by agent</caption>
        <thead><tr><th scope="col">Day</th><For each={props.series}>{(series) => <th scope="col" class="num">{series.name}</th>}</For><th scope="col" class="num">Total tokens</th><th scope="col" class="num">Cost estimate</th></tr></thead>
        <tbody>
          <For each={[...props.days].reverse()}>{(day) => {
            const tokens = day.agents.reduce((sum, slice) => sum + slice.tokens, 0);
            const known = day.agents.some((slice) => slice.cost.known);
            const cost = day.agents.reduce((sum, slice) => sum + (slice.cost.known ? money(slice.cost.usd) : 0), 0);
            const complete = day.agents.every((slice) => slice.cost.complete);
            return <tr><th scope="row">{longDay(day.day)}</th><For each={props.series}>{(series) => <td class="num">{cell(day, series.id) ? fullNumber(cell(day, series.id)!.tokens) : "–"}</td>}</For><td class="num">{fullNumber(tokens)}</td><td class="num">{known ? costText({ usd: cost, reportedUsd: 0, estimatedUsd: cost, unpricedTokens: 0, known, complete }).text : tokens > 0 ? "No price" : "–"}</td></tr>;
          }}</For>
        </tbody>
      </table>
    </div>
  );
}
