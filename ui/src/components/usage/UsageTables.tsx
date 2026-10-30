import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import type { ModelUsage_Serialize as ModelUsage, SessionUsageRow_Serialize as SessionUsageRow, UsageTotals_Serialize as UsageTotals } from "../../bindings";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";
import { ModelIcon } from "../agent/ModelPopover";
import { compactTokens, costShort, fullNumber, matchesSearch, money, providerKey, providerName, shareText, sortRows, type SortState } from "../../lib/usage";
import { seriesVar } from "./UsageChart";

/** The brand mark id for an agent id: imported sessions carry their own agent ids but wear the agent's mark. */
export const brandId = (agentId: string) => providerKey(agentId);

/** Where a model's price came from, for the row's tooltip. */
export function priceNote(row: ModelUsage): string {
  const price = row.price;
  if (!price) return "No price in the table: tokens only. Set one in agents.usage.prices.";
  const how = price.kind === "exact" ? "Priced as" : price.kind === "alias" ? "Alias, priced as the current" : price.kind === "family" ? "Variant, priced as" : "Your price for";
  return `${how} ${price.label}${price.note ? `. ${price.note}` : ""}`;
}

function Cost(props: { totals: UsageTotals }) {
  const info = () => costShort(props.totals.cost);
  return <Show when={info().known} fallback={<span class="usage-noprice" title={info().title}>No price</span>}><span class="usage-cost" title={info().title}>{info().text}</span></Show>;
}

export function Panel(props: { title: string; count?: number; actions?: JSX.Element; children: JSX.Element; class?: string }) {
  return (
    <section class={`usage-panel ${props.class ?? ""}`} aria-label={props.title}>
      <header class="usage-panel-head">
        <h2>{props.title}</h2>
        <Show when={props.count !== undefined}><span class="usage-count">{props.count}</span></Show>
        <span class="usage-spacer" />
        {props.actions}
      </header>
      {props.children}
    </section>
  );
}

const MODEL_LIMIT = 8;
const slug = (text: string) => text.toLowerCase().replace(/[.\s_]+/g, "-");
/** Models by tokens with a horizontal share bar each: mark, name, tokens, estimated cost and share. */
export function ModelList(props: { rows: readonly ModelUsage[]; totalTokens: number; agentName: (id: string) => string }) {
  const [all, setAll] = createSignal(false);
  const rows = createMemo(() => [...props.rows].sort((a, b) => b.totals.tokens.total - a.totals.tokens.total));
  const largest = () => rows()[0]?.totals.tokens.total || 1;
  return (
    <Panel title="By model" count={props.rows.length}>
      <ol class="usage-rank">
        <For each={all() ? rows() : rows().slice(0, MODEL_LIMIT)}>{(row) => (
          <li class="usage-rank-row" title={`${row.model}: ${priceNote(row)}`}>
            <span class="usage-rank-mark"><ModelIcon id={brandId(row.agentIds[0] ?? "")} name={props.agentName(row.agentIds[0] ?? "")} traits={[]} size={16} model={{ value: row.model, name: row.model }} /></span>
            <span class="usage-rank-name">
              <span class="usage-rank-title">{row.price?.label ?? (row.model || "Model not named")}<Show when={row.price && slug(row.price.label) !== slug(row.model)}><span class="usage-rank-id usage-mono">{row.model}</span></Show></span>
            </span>
            <span class="usage-rank-num">{compactTokens(row.totals.tokens.total)}</span>
            <span class="usage-rank-num usage-rank-cost"><Cost totals={row.totals} /></span>
            <span class="usage-rank-share">{shareText(row.totals.tokens.total, props.totalTokens)}</span>
            <span class="usage-rank-bar" aria-hidden="true"><i style={{ width: `${Math.max(0.6, (row.totals.tokens.total / largest()) * 100)}%` }} /></span>
          </li>
        )}</For>
      </ol>
      <Show when={rows().length > MODEL_LIMIT}>
        <button type="button" class="usage-more" aria-expanded={all()} onClick={() => setAll(!all())}>{all() ? "Show fewer" : `Show all ${rows().length} models`}<Icon name={all() ? "arrow-up3" : "arrow-down4"} size={12} /></button>
      </Show>
    </Panel>
  );
}

export type ProviderRow = { key: string; name: string; slot: number | "other"; totals: UsageTotals; spark: number[]; imported: number };

/** A small trend line in the series colour: a 1.5px line over a faint wash, no axes. */
export function Sparkline(props: { values: readonly number[]; slot: number | "other"; label: string }) {
  const W = 96;
  const H = 26;
  const path = createMemo(() => {
    const values = props.values.length > 1 ? props.values : [props.values[0] ?? 0, props.values[0] ?? 0];
    const max = Math.max(...values, 0) || 1;
    const step = W / (values.length - 1);
    const points = values.map((value, index) => [index * step, H - 2 - (value / max) * (H - 4)] as const);
    const line = points.map(([px, py], index) => `${index ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
    return { line, area: `${line}L${W},${H}L0,${H}Z` };
  });
  return (
    <svg class="usage-spark" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={props.label}>
      <path d={path().area} fill={seriesVar(props.slot)} opacity="0.12" />
      <path d={path().line} fill="none" stroke={seriesVar(props.slot)} stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    </svg>
  );
}

/** Tracked by Span against imported from local logs: tokens and sessions with a share bar each. */
export function SourceList(props: { tracked: UsageTotals; imported: UsageTotals }) {
  const total = () => props.tracked.tokens.total + props.imported.tokens.total;
  const rows = () => [
    { name: "Tracked by Span", sub: "Sessions Span ran", totals: props.tracked },
    { name: "Imported", sub: "Agents' own local logs", totals: props.imported },
  ];
  return (
    <Panel title="By source">
      <ol class="usage-rank">
        <For each={rows()}>{(row) => (
          <li class="usage-rank-row usage-source-row">
            <span class="usage-rank-name"><span class="usage-rank-title">{row.name}</span><span class="usage-rank-sub">{fullNumber(row.totals.sessions)} {row.totals.sessions === 1 ? "session" : "sessions"} · {row.sub}</span></span>
            <span class="usage-rank-num">{compactTokens(row.totals.tokens.total)}</span>
            <span class="usage-rank-num usage-rank-cost"><Cost totals={row.totals} /></span>
            <span class="usage-rank-share">{shareText(row.totals.tokens.total, total())}</span>
            <span class="usage-rank-bar" aria-hidden="true"><i style={{ width: `${total() ? Math.max(0.6, (row.totals.tokens.total / total()) * 100) : 0}%` }} /></span>
          </li>
        )}</For>
      </ol>
    </Panel>
  );
}

/** Providers (agents) with a sparkline of their daily tokens. */
export function ProviderList(props: { rows: readonly ProviderRow[]; totalTokens: number }) {
  const rows = createMemo(() => [...props.rows].sort((a, b) => b.totals.tokens.total - a.totals.tokens.total));
  return (
    <Panel title="By agent" count={props.rows.length}>
      <ol class="usage-rank">
        <For each={rows()}>{(row) => (
          <li class="usage-rank-row usage-provider-row">
            <span class="usage-rank-mark"><BrandIcon id={row.key} name={row.name} size={16} /></span>
            <span class="usage-rank-name">
              <span class="usage-rank-title">{row.name}</span>
              <span class="usage-rank-sub" title={row.imported > 0 ? `${fullNumber(row.imported)} imported from local logs` : undefined}>{fullNumber(row.totals.sessions)} {row.totals.sessions === 1 ? "session" : "sessions"}</span>
            </span>
            <Sparkline values={row.spark} slot={row.slot} label={`${row.name} tokens over the range`} />
            <span class="usage-rank-num">{compactTokens(row.totals.tokens.total)}</span>
            <span class="usage-rank-num usage-rank-cost"><Cost totals={row.totals} /></span>
            <span class="usage-rank-share">{shareText(row.totals.tokens.total, props.totalTokens)}</span>
          </li>
        )}</For>
      </ol>
    </Panel>
  );
}

type SessionKey = "name" | "agent" | "model" | "tokens" | "cost" | "last";
type Column = { key: SessionKey; label: string; numeric?: boolean; title?: string };
const COLUMNS: Column[] = [
  { key: "name", label: "Session" },
  { key: "agent", label: "Agent" },
  { key: "model", label: "Model" },
  { key: "tokens", label: "Tokens", numeric: true },
  { key: "cost", label: "Cost", numeric: true, title: "API-equivalent estimate, not a subscription bill" },
  { key: "last", label: "Last active", numeric: true },
];

function SortHeader(props: { column: Column; sort: SortState<SessionKey>; onSort: (key: SessionKey) => void }) {
  const active = () => props.sort.key === props.column.key;
  return (
    <th scope="col" class={props.column.numeric ? "num" : undefined} aria-sort={active() ? (props.sort.descending ? "descending" : "ascending") : "none"} title={props.column.title}>
      <button type="button" class="usage-sort" onClick={() => props.onSort(props.column.key)}>
        <span>{props.column.label}</span>
        <Icon name={active() && !props.sort.descending ? "arrow-up3" : "arrow-down4"} size={10} class={active() ? "usage-sort-icon on" : "usage-sort-icon"} />
      </button>
    </th>
  );
}

const PAGE = 25;
/** Sessions: searchable, sortable, compact. A session Span ran opens on click when `onOpen` is given. */
export function SessionTable(props: { rows: readonly SessionUsageRow[]; onOpen?: (row: SessionUsageRow) => void; canOpen?: (row: SessionUsageRow) => boolean; actions?: JSX.Element }) {
  const [sort, setSort] = createSignal<SortState<SessionKey>>({ key: "last", descending: true });
  const [query, setQuery] = createSignal("");
  const [limit, setLimit] = createSignal(PAGE);
  const toggle = (key: SessionKey) => setSort((current) => (current.key === key ? { key, descending: !current.descending } : { key, descending: key !== "name" && key !== "agent" && key !== "model" }));
  const filtered = createMemo(() => props.rows.filter((row) => matchesSearch(row, query())));
  const rows = createMemo(() => sortRows(filtered(), sort(), (row, key) => {
    switch (key) {
      case "name": return (row.title || row.sessionId).toLowerCase();
      case "agent": return row.agentName.toLowerCase();
      case "model": return (row.models[0] ?? "~").toLowerCase();
      case "tokens": return row.totals.tokens.total;
      // An unknown price sorts below every known one, including a known zero.
      case "cost": return row.totals.cost.known ? money(row.totals.cost.usd) : -1;
      case "last": return row.lastActiveMs;
    }
  }));
  const when = (ms: number) => (ms > 0 ? new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
  const openable = (row: SessionUsageRow) => Boolean(props.onOpen && !row.imported && (props.canOpen?.(row) ?? true));
  return (
    <Panel title="Sessions" count={props.rows.length} class="usage-sessions" actions={<>
      <label class="usage-search">
        <Icon name="SearchNormal1" size={13} />
        <input type="search" placeholder="Search sessions" aria-label="Search sessions" value={query()} onInput={(event) => { setQuery(event.currentTarget.value); setLimit(PAGE); }} />
      </label>
      {props.actions}
    </>}>
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead><tr><For each={COLUMNS}>{(column) => <SortHeader column={column} sort={sort()} onSort={toggle} />}</For></tr></thead>
          <tbody>
            <For each={rows().slice(0, limit())} fallback={<tr><td class="usage-table-empty" colSpan={COLUMNS.length}>No sessions match “{query()}”</td></tr>}>{(row) => (
              <tr classList={{ openable: openable(row) }} tabindex={openable(row) ? 0 : undefined} title={openable(row) ? "Open this session" : row.imported ? "Imported from the agent's local logs" : undefined}
                onClick={() => openable(row) && props.onOpen!(row)} onKeyDown={(event) => { if (openable(row) && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); props.onOpen!(row); } }}>
                <th scope="row"><span class="usage-session-title">{row.title || "Untitled session"}</span></th>
                <td><span class="usage-agent"><BrandIcon id={brandId(row.agentId)} name={row.agentName} size={14} /><span>{providerName(brandId(row.agentId), row.agentName)}</span><Show when={row.imported}><span class="usage-tag">Imported</span></Show></span></td>
                <td><span class="usage-mono usage-model-cell" title={row.models.join(", ")}>{row.models[0] ?? "–"}<Show when={row.models.length > 1}><small> +{row.models.length - 1}</small></Show></span></td>
                <td class="num" title={`${fullNumber(row.totals.tokens.total)} tokens`}>{row.totals.turns > 0 && row.totals.tokens.total === 0 ? <span class="usage-unknown">Not reported</span> : compactTokens(row.totals.tokens.total)}</td>
                <td class="num"><Cost totals={row.totals} /></td>
                <td class="num secondary">{when(row.lastActiveMs)}</td>
              </tr>
            )}</For>
          </tbody>
        </table>
      </div>
      <Show when={rows().length > limit()}>
        <button type="button" class="usage-more" onClick={() => setLimit((value) => value + PAGE)}>Show {Math.min(PAGE, rows().length - limit())} more of {fullNumber(rows().length - limit())}<Icon name="arrow-down4" size={12} /></button>
      </Show>
    </Panel>
  );
}
