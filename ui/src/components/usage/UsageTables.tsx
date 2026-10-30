import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import type { AgentUsage_Serialize as AgentUsage, ModelUsage_Serialize as ModelUsage, SessionUsageRow_Serialize as SessionUsageRow, UsageTotals_Serialize as UsageTotals } from "../../bindings";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";
import { ModelIcon } from "../agent/ModelPopover";
import { compactTokens, costText, fullNumber, money, sortRows, type SortState } from "../../lib/usage";

/** Imported sessions carry their own agent ids; their marks are the agent's own. */
export const brandId = (agentId: string) => (agentId === "claude-code-logs" ? "claude" : agentId === "codex-logs" ? "codex" : agentId);

type NumericKey = "tokens" | "input" | "output" | "cache" | "turns" | "sessions" | "cost";
const numeric = (totals: UsageTotals, key: NumericKey): number => {
  switch (key) {
    case "tokens": return totals.tokens.total;
    case "input": return totals.tokens.input;
    case "output": return totals.tokens.output;
    case "cache": return totals.tokens.cacheRead + totals.tokens.cacheWrite;
    case "turns": return totals.turns;
    case "sessions": return totals.sessions;
    // An unknown price sorts below every known one, including a known zero.
    case "cost": return totals.cost.known ? money(totals.cost.usd) : -1;
  }
};

type Column<K extends string> = { key: K; label: string; numeric?: boolean; title?: string };

function SortHeader<K extends string>(props: { column: Column<K>; sort: SortState<K>; onSort: (key: K) => void }) {
  const active = () => props.sort.key === props.column.key;
  return (
    <th scope="col" class={props.column.numeric ? "num" : undefined} aria-sort={active() ? (props.sort.descending ? "descending" : "ascending") : "none"} title={props.column.title}>
      <button type="button" class="usage-sort" onClick={() => props.onSort(props.column.key)}>
        <span>{props.column.label}</span>
        <Icon name={active() && !props.sort.descending ? "arrow-up3" : "arrow-down4"} size={11} class={active() ? "usage-sort-icon on" : "usage-sort-icon"} />
      </button>
    </th>
  );
}

function useSort<K extends string>(initial: K) {
  const [sort, setSort] = createSignal<SortState<K>>({ key: initial, descending: true });
  const toggle = (key: K) => setSort((current) => (current.key === key ? { key, descending: !current.descending } : { key, descending: true }));
  return [sort, toggle] as const;
}

function CostCell(props: { totals: UsageTotals }) {
  const info = () => costText(props.totals.cost);
  return <td class="num" classList={{ "usage-unknown": !info().known }} title={info().title}>{info().text}</td>;
}

function TokenCells(props: { totals: UsageTotals }) {
  const tokens = () => props.totals.tokens;
  const missing = () => props.totals.turns > 0 && props.totals.tokens.total === 0;
  return <>
    <td class="num" title={missing() ? "The agent did not report token counts for these turns" : `${fullNumber(tokens().total)} tokens`} classList={{ "usage-unknown": missing() }}>{missing() ? "Not reported" : compactTokens(tokens().total)}</td>
    <td class="num secondary" title={`${fullNumber(tokens().input)} input tokens`}>{compactTokens(tokens().input)}</td>
    <td class="num secondary" title={`${fullNumber(tokens().output)} output tokens`}>{compactTokens(tokens().output)}</td>
    <td class="num secondary" title={`${fullNumber(tokens().cacheRead)} cache read, ${fullNumber(tokens().cacheWrite)} cache write tokens`}>{compactTokens(tokens().cacheRead + tokens().cacheWrite)}</td>
  </>;
}

const TOKEN_COLUMNS: Column<NumericKey>[] = [
  { key: "tokens", label: "Tokens", numeric: true },
  { key: "input", label: "Input", numeric: true },
  { key: "output", label: "Output", numeric: true },
  { key: "cache", label: "Cache", numeric: true, title: "Cache read plus cache write tokens" },
];

function Section(props: { title: string; count: number; children: JSX.Element; actions?: JSX.Element }) {
  return (
    <section class="usage-card usage-table-card" aria-label={props.title}>
      <header class="usage-card-head"><h2>{props.title}</h2><span class="usage-count">{props.count}</span><span class="usage-spacer" />{props.actions}</header>
      {props.children}
    </section>
  );
}

export function AgentTable(props: { rows: readonly AgentUsage[]; share: (id: string) => number }) {
  type Key = NumericKey | "name";
  const [sort, toggle] = useSort<Key>("tokens");
  const rows = createMemo(() => sortRows(props.rows, sort(), (row, key) => (key === "name" ? row.name.toLowerCase() : numeric(row.totals, key))));
  const columns: Column<Key>[] = [{ key: "name", label: "Agent" }, ...TOKEN_COLUMNS, { key: "sessions", label: "Sessions", numeric: true }, { key: "cost", label: "Cost estimate", numeric: true, title: "API-equivalent estimate, not a subscription bill" }];
  return (
    <Section title="By agent" count={props.rows.length}>
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead><tr><For each={columns}>{(column) => <SortHeader column={column} sort={sort()} onSort={toggle} />}</For></tr></thead>
          <tbody>
            <For each={rows()}>{(row) => (
              <tr>
                <th scope="row"><span class="usage-name"><BrandIcon id={brandId(row.agentId)} name={row.name} size={16} /><span>{row.name}</span><span class="usage-share-pill" title="Share of tokens in this range">{props.share(row.agentId)}%</span><Show when={row.imported}><span class="usage-source-pill" title="Read from the agent's own local logs">Imported</span></Show></span></th>
                <TokenCells totals={row.totals} />
                <td class="num">{fullNumber(row.totals.sessions)}</td>
                <CostCell totals={row.totals} />
              </tr>
            )}</For>
          </tbody>
        </table>
      </div>
    </Section>
  );
}

export function ModelTable(props: { rows: readonly ModelUsage[]; agentName: (id: string) => string }) {
  type Key = NumericKey | "name";
  const [sort, toggle] = useSort<Key>("tokens");
  const rows = createMemo(() => sortRows(props.rows, sort(), (row, key) => (key === "name" ? (row.model || "~").toLowerCase() : numeric(row.totals, key))));
  const columns: Column<Key>[] = [{ key: "name", label: "Model" }, ...TOKEN_COLUMNS, { key: "turns", label: "Turns", numeric: true }, { key: "cost", label: "Cost estimate", numeric: true, title: "API-equivalent estimate, not a subscription bill" }];
  const priceNote = (row: ModelUsage) => {
    const price = row.price;
    if (!price) return "No price in the table: tokens only";
    const how = price.kind === "exact" ? "Priced as" : price.kind === "alias" ? "Alias, priced as the current" : price.kind === "family" ? "Variant, priced as" : "Your price for";
    return `${how} ${price.label}${price.note ? `. ${price.note}` : ""}`;
  };
  return (
    <Section title="By model" count={props.rows.length}>
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead><tr><For each={columns}>{(column) => <SortHeader column={column} sort={sort()} onSort={toggle} />}</For></tr></thead>
          <tbody>
            <For each={rows()}>{(row) => (
              <tr>
                <th scope="row">
                  <span class="usage-name">
                    <ModelIcon id={brandId(row.agentIds[0] ?? "")} name={props.agentName(row.agentIds[0] ?? "")} traits={[]} size={16} model={{ value: row.model, name: row.model }} />
                    <span class="usage-model-text"><span class="usage-mono">{row.model || "Model not named"}</span><small title={priceNote(row)}>{priceNote(row)}</small></span>
                  </span>
                </th>
                <TokenCells totals={row.totals} />
                <td class="num">{fullNumber(row.totals.turns)}</td>
                <CostCell totals={row.totals} />
              </tr>
            )}</For>
          </tbody>
        </table>
      </div>
    </Section>
  );
}

const PAGE = 50;
export function SessionTable(props: { rows: readonly SessionUsageRow[] }) {
  type Key = NumericKey | "name" | "agent" | "last";
  const [sort, toggle] = useSort<Key>("last");
  const [limit, setLimit] = createSignal(PAGE);
  const rows = createMemo(() => sortRows(props.rows, sort(), (row, key) => (key === "name" ? (row.title || row.sessionId).toLowerCase() : key === "agent" ? row.agentName.toLowerCase() : key === "last" ? row.lastActiveMs : numeric(row.totals, key))));
  const columns: Column<Key>[] = [{ key: "name", label: "Session" }, { key: "agent", label: "Agent" }, { key: "last", label: "Last active", numeric: true }, ...TOKEN_COLUMNS, { key: "turns", label: "Turns", numeric: true }, { key: "cost", label: "Cost estimate", numeric: true, title: "API-equivalent estimate, not a subscription bill" }];
  const when = (ms: number) => (ms > 0 ? new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
  return (
    <Section title="By session" count={props.rows.length}>
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead><tr><For each={columns}>{(column) => <SortHeader column={column} sort={sort()} onSort={toggle} />}</For></tr></thead>
          <tbody>
            <For each={rows().slice(0, limit())}>{(row) => (
              <tr>
                <th scope="row"><span class="usage-model-text"><span class="usage-session-title">{row.title || "Untitled session"}</span><small class="usage-mono" title={row.sessionId}>{row.sessionId}{row.models.length ? ` · ${row.models.join(", ")}` : ""}</small></span></th>
                <td><span class="usage-name"><BrandIcon id={brandId(row.agentId)} name={row.agentName} size={14} /><span>{row.agentName}</span><Show when={row.imported}><span class="usage-source-pill" title="Read from the agent's own local logs">Imported</span></Show></span></td>
                <td class="num secondary">{when(row.lastActiveMs)}</td>
                <TokenCells totals={row.totals} />
                <td class="num">{fullNumber(row.totals.turns)}</td>
                <CostCell totals={row.totals} />
              </tr>
            )}</For>
          </tbody>
        </table>
      </div>
      <Show when={rows().length > limit()}>
        <button type="button" class="usage-more" onClick={() => setLimit((value) => value + PAGE)}>Show {Math.min(PAGE, rows().length - limit())} more of {rows().length - limit()}<Icon name="arrow-down4" size={12} /></button>
      </Show>
    </Section>
  );
}
