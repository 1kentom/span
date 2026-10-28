import { For, Show, createSignal } from "solid-js";
import { RUN_TEXT } from "../../lib/agent-hint-text";
import { StepGlyph } from "./WorkGroup";

type RunningStepProps = {
  title: string;
  /** A shell command: labelled "Running command" and drawn as terminal output. */
  command?: boolean;
  /** This step's own elapsed time. Not in a live region: it ticks every second. */
  elapsed: string;
  /** The newest output lines. */
  lines: string[];
  /** Earlier lines left out of `lines`. */
  hidden: number;
  /** Every line, shown after "Show full output". */
  full: string[];
  /** The quiet "Still running, no new output for Ns" line, when the step went silent. */
  still?: string;
};

/**
 * The step running now, pinned above the composer so it stays visible however the feed is scrolled. It shows the live
 * output tail (truncated, with "Show full output"), its own elapsed time and, after a silence, a quiet still-running
 * line. Turn start and end are announced by the composer; nothing here is a live region.
 */
export function RunningStep(props: RunningStepProps) {
  const [full, setFull] = createSignal(false);
  const label = () => `${props.command ? RUN_TEXT.runningCommand : RUN_TEXT.running}: ${props.title}`;
  const shown = () => (full() ? props.full : props.lines);
  return (
    <section class="agent-running-step" aria-label={label()}>
      <div class="agent-running-head">
        <StepGlyph kind={props.command ? "run" : "other"} status="in_progress" size={12} />
        <span class="agent-running-title sb-ellipsis sb-flex sb-mono" title={props.title}>{props.title}</span>
        <span class="agent-running-elapsed sb-sub nowrap sb-mono">{props.elapsed}</span>
      </div>
      <Show when={shown().length}>
        <div class="agent-running-output sb-mono" classList={{ full: full() }} tabIndex={0} aria-label={`Output of ${props.title}`}>
          <For each={shown()}>{(line) => <div class="agent-running-line">{line || " "}</div>}</For>
        </div>
      </Show>
      <Show when={props.hidden > 0 || full()}>
        <button type="button" class="sb-link agent-running-more" aria-expanded={full()} onClick={() => setFull(!full())}>
          {full() ? RUN_TEXT.hideFull : `${RUN_TEXT.showFull} (${props.hidden} more ${props.hidden === 1 ? "line" : "lines"})`}
        </button>
      </Show>
      <Show when={props.still}>
        <p class="agent-running-still sb-sub">{props.still}</p>
      </Show>
    </section>
  );
}
