import { For, Show } from "solid-js";
import type { UsageBlock_Serialize as UsageBlock } from "../../bindings";
import { compactTokens, costShort, fullNumber } from "../../lib/usage";
import type { ChartMetric } from "./UsageChart";

/** Blocks shown, newest first. */
export const BLOCKS_SHOWN = 12;

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** Minutes left as "2h 10m" or "45m". */
export function timeLeft(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/**
 * Claude Code's five-hour usage blocks (ccusage rules: a block starts at the first message and lasts five hours), as
 * one bar per block, newest first. Read from Claude Code's local logs at hour resolution.
 */
export function UsageBlocks(props: { blocks: UsageBlock[]; metric: ChartMetric; now: number }) {
  const shown = () => [...props.blocks].reverse().slice(0, BLOCKS_SHOWN);
  const value = (block: UsageBlock): number => (props.metric === "tokens" ? block.tokens.total : block.cost.usd ?? 0);
  const max = () => Math.max(0, ...shown().map(value)) || 1;
  return (
    <Show when={shown().length} fallback={<p class="usage-blocks-empty">No Claude Code activity in this range. Blocks come from Claude Code's local logs.</p>}>
      <ol class="usage-blocks" aria-label="Claude Code five-hour blocks">
        <For each={shown()}>{(block) => (
          <li class="usage-block" classList={{ active: block.active }}>
            <span class="usage-block-when"><b>{day(block.startMs)}</b> {time(block.startMs)} to {time(block.endMs)}</span>
            <span class="usage-rank-bar usage-block-bar" aria-hidden="true"><i style={{ width: `${Math.max(1, (value(block) / max()) * 100)}%` }} /></span>
            <span class="usage-block-num" title={`${fullNumber(block.tokens.total)} tokens in ${fullNumber(block.turns)} turns`}>{compactTokens(block.tokens.total)}</span>
            <span class="usage-block-num" title={costShort(block.cost).title}>{costShort(block.cost).text}</span>
            <span class="usage-block-state">{block.active ? `Active, ${timeLeft(block.endMs - props.now)} left` : `${fullNumber(block.turns)} turns`}</span>
          </li>
        )}</For>
      </ol>
      <p class="usage-blocks-note">Five-hour windows from each block's first message, as Claude plans count usage. From Claude Code's local logs, to the hour.</p>
    </Show>
  );
}
