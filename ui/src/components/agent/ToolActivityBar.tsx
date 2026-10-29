import { For, Show, createEffect, createSignal, on } from "solid-js";
import Icon from "../Icon";
import { RUN_TEXT } from "../../lib/agent-hint-text";
import type { ToolBarView } from "../../lib/agent-tool-bar";

type ToolActivityBarProps = {
  view: ToolBarView;
  /** The running tool's newest output lines. */
  lines?: string[];
  /** Earlier lines left out of `lines`. */
  hidden?: number;
  /** Every line, shown after "Show full output". */
  full?: string[];
  /** The quiet "Still running, no new output for Ns" line. */
  still?: string;
};

/**
 * The one stacked bar above the composer while a turn runs: a spinner, the friendly tool title, its command or path
 * as a one-line monospace secondary, a "+N more" chip when tools overlap, one timer and the Esc key hint. Below it,
 * only when there is any, the running tool's output tail and a failed tool's reason.
 *
 * The polite live region holds the phase and tool only. The timer sits outside it, so ticking never re-announces.
 */
export function ToolActivityBar(props: ToolActivityBarProps) {
  const [showAll, setShowAll] = createSignal(false);
  const v = () => props.view;
  // A new tool starts collapsed again.
  createEffect(on(() => v().toolCallId, () => setShowAll(false), { defer: true }));
  const shown = () => (showAll() ? (props.full ?? []) : (props.lines ?? []));
  const timerTitle = () => (v().turn ? `This step ${v().elapsed}, turn ${v().turn}` : undefined);
  const moreTitle = () => v().more.join("\n");
  return (
    <section class={`sb-activity agent-toolbar ${v().tone}`} aria-label="Agent activity">
      <span class="sb-visually-hidden" role="status" aria-live="polite">{v().announce}</span>
      <div class="agent-toolbar-row">
        <span class="agent-toolbar-glyph" aria-hidden="true">
          <Show when={v().tone === "done"} fallback={<Show when={v().tone === "failed"} fallback={<span class="sb-spinner" />}><Icon name="Danger" size={13} /></Show>}>
            <Icon name="Check" size={13} />
          </Show>
        </span>
        <span class="agent-toolbar-label nowrap" classList={{ "sb-shimmer": v().tone === "running" || v().tone === "thinking" }}>{v().label}</span>
        <Show when={v().summary} fallback={<span class="sb-flex" />}>
          <span class="agent-toolbar-summary sb-mono sb-ellipsis sb-flex" title={v().summary}>{v().summary}</span>
        </Show>
        <Show when={v().more.length}>
          <span class="agent-toolbar-more nowrap" title={moreTitle()}>+{v().more.length} more</span>
        </Show>
        <span class="agent-toolbar-elapsed sb-mono nowrap" title={timerTitle()}>{v().elapsed}</span>
        <Show when={v().stoppable}>
          <span class="agent-toolbar-hint nowrap" aria-label="Press Escape to stop">
            <kbd class="sb-hint-key" aria-hidden="true">Esc</kbd>
            <span aria-hidden="true">to stop</span>
          </span>
        </Show>
      </div>
      <Show when={v().tone === "failed" && v().reason}>
        <p class="agent-toolbar-reason sb-ellipsis" title={v().reason}>{v().reason}</p>
      </Show>
      <Show when={v().tone === "running" && shown().length}>
        <div class="agent-toolbar-output sb-mono" classList={{ full: showAll() }} tabIndex={0} aria-label={`Output of ${v().summary ?? v().label}`}>
          <For each={shown()}>{(line) => <div class="agent-toolbar-line">{line || " "}</div>}</For>
        </div>
      </Show>
      <Show when={v().tone === "running" && ((props.hidden ?? 0) > 0 || showAll())}>
        <button type="button" class="sb-link agent-toolbar-toggle" aria-expanded={showAll()} onClick={() => setShowAll(!showAll())}>
          {showAll() ? RUN_TEXT.hideFull : `${RUN_TEXT.showFull} (${props.hidden} more ${props.hidden === 1 ? "line" : "lines"})`}
        </button>
      </Show>
      <Show when={v().tone === "running" && props.still}>
        <p class="agent-toolbar-still">{props.still}</p>
      </Show>
    </section>
  );
}
