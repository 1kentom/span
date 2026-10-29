import { For, Show, createEffect, createSignal, on, onMount, untrack } from "solid-js";
import { BrandIcon } from "../BrandIcon";
import {
  agentUsageRows,
  compactHint,
  compactRunText,
  compactStep,
  contextPercent,
  contextTone,
  formatCost,
  formatTokens,
  limitText,
  meterAria,
  meterLabel,
  startCompaction,
  type AgentUsageRow,
  type CompactRun,
  type ContextUsage,
  type LimitNote,
  type MeterState,
} from "../../lib/context-usage";
import type { DelegationTaskState } from "../../lib/agent-delegation";
import { useEscape } from "./util";
import "../../styles/context-meter.css";

/** Ring segments. A thin segmented ring reads as a gauge at 14px without looking like a spinner. */
const SEGMENTS = 10;
const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const SEGMENT = CIRCUMFERENCE / SEGMENTS;

function Ring(props: { pct: number | undefined }) {
  const filled = () => ((props.pct ?? 0) / 100) * CIRCUMFERENCE;
  return (
    <svg class="sb-ctx-ring" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle class="sb-ring-track" cx="8" cy="8" r={RADIUS} fill="none" stroke-width="2" stroke-dasharray={`${SEGMENT - 1} 1`} />
      <Show when={props.pct !== undefined}>
        <circle class="sb-ring-value" cx="8" cy="8" r={RADIUS} fill="none" stroke-width="2" stroke-dasharray={`${filled()} ${CIRCUMFERENCE}`} transform="rotate(-90 8 8)" />
      </Show>
    </svg>
  );
}

/** A thin bar with the real number on it, for the popover rows. */
function Bar(props: { pct: number | undefined; label: string; tone: string }) {
  return (
    <div
      class={`sb-ctx-bar ${props.tone}`}
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={props.pct}
      aria-valuetext={props.pct === undefined ? "Not reported" : `${props.pct}%`}
    >
      <div class="sb-ctx-bar-fill" style={{ width: `${props.pct ?? 0}%` }} />
    </div>
  );
}

export type ContextMeterProps = {
  state: MeterState;
  usage?: ContextUsage;
  agent: string;
  expanded: boolean;
  compacting?: boolean;
  onToggle: (button: HTMLButtonElement) => void;
};

/** The one-line meter in the composer toolbar: "42% context" with a segmented ring, toned by how full the window is. */
export function ContextMeter(props: ContextMeterProps) {
  let button!: HTMLButtonElement;
  const pct = () => (props.usage ? contextPercent(props.usage.used, props.usage.size) : undefined);
  const tone = () => (props.state === "live" ? contextTone(pct()) : "neutral");
  const shownPct = () => (props.state === "live" || props.state === "stale" ? pct() : undefined);
  return (
    <button
      ref={button}
      type="button"
      class={`sb-ring sb-ctx ${tone()}`}
      classList={{ stale: props.state === "stale", unknown: shownPct() === undefined, busy: props.compacting }}
      data-state={props.state}
      aria-label={meterAria(props.state, props.usage, props.agent)}
      title={meterAria(props.state, props.usage, props.agent).replace(/\. Show usage details$/, "")}
      aria-haspopup="dialog"
      aria-expanded={props.expanded}
      onClick={() => props.onToggle(button)}
    >
      <Ring pct={shownPct()} />
      <span class="sb-ctx-label">{meterLabel(props.state, pct())}</span>
    </button>
  );
}

export type ContextHintProps = {
  pct?: number;
  /** A compaction run, when one was started from the meter. Takes the hint's place. */
  run?: CompactRun;
  showHint: boolean;
  onCompact: () => void;
  onDismiss: () => void;
};

/** The quiet line above the prompt box: the compact suggestion, then the run's progress and its settled result. */
export function ContextHint(props: ContextHintProps) {
  return (
    <Show
      when={props.run}
      fallback={
        <Show when={props.showHint && props.pct !== undefined}>
          <div class="sb-ctx-hint" role="status">
            <span class="sb-ctx-hint-text">{compactHint(props.pct!)}</span>
            <button type="button" class="sb-ctx-link" onClick={() => props.onCompact()}>Compact</button>
            <button type="button" class="sb-ctx-link quiet" onClick={() => props.onDismiss()}>Dismiss</button>
          </div>
        </Show>
      }
    >
      {(run) => (
        <div class={`sb-ctx-hint ${run().phase}`} role={run().phase === "failed" ? "alert" : "status"}>
          <Show when={run().phase === "running"}><span class="sb-pulse sb-ctx-pulse" aria-hidden="true" /></Show>
          <span class="sb-ctx-hint-text">{compactRunText(run())}</span>
          <Show when={run().phase === "failed"}>
            <button type="button" class="sb-ctx-link" onClick={() => props.onCompact()}>Retry</button>
          </Show>
          <Show when={run().phase !== "running"}>
            <button type="button" class="sb-ctx-link quiet" onClick={() => props.onDismiss()}>Dismiss</button>
          </Show>
        </div>
      )}
    </Show>
  );
}

export type ContextPopoverProps = {
  agent: { id?: string; name: string };
  state: MeterState;
  usage?: ContextUsage;
  model?: string;
  limit?: LimitNote;
  now: number;
  tasks: readonly DelegationTaskState[];
  /** The agent's own compact command, when it advertised one. No command, no button. */
  compactCommand?: string;
  /** A turn is running, so a command cannot be sent now. */
  busy: boolean;
  run?: CompactRun;
  onCompact: () => void;
  onClose: () => void;
};

const STATE_NOTE: Partial<Record<MeterState, (agent: string) => string>> = {
  unknown: () => "No usage reported yet. It appears after the agent's first update.",
  unreported: (agent) => `${agent} does not report context usage.`,
  stale: () => "From before the model switch. Updates on the agent's next report.",
};

function Row(props: { row: AgentUsageRow }) {
  return (
    <li class="sb-ctx-row" classList={{ lead: props.row.lead }}>
      <BrandIcon id={props.row.id} name={props.row.name} size={14} />
      <span class="sb-ctx-row-name">{props.row.name}</span>
      <span class="sb-ctx-row-note">{props.row.note}{props.row.cost ? ` · ${props.row.cost}` : ""}</span>
      <Bar pct={props.row.pct} tone={props.row.tone} label={`${props.row.name} context`} />
    </li>
  );
}

/** Usage details: the window with real numbers, cost and model when reported, the last limit, Compact, delegated agents. */
export function ContextPopover(props: ContextPopoverProps) {
  let root!: HTMLDivElement;
  useEscape(props.onClose);
  onMount(() => queueMicrotask(() => root?.focus()));
  const pct = () => (props.usage ? contextPercent(props.usage.used, props.usage.size) : undefined);
  const known = () => (props.state === "live" || props.state === "stale") && pct() !== undefined;
  const tone = () => (props.state === "live" ? contextTone(pct()) : "neutral");
  const cost = () => formatCost(props.usage?.cost);
  const rows = () => agentUsageRows({ lead: { ...props.agent, usage: props.usage, stale: props.state === "stale" }, tasks: props.tasks }).slice(1);
  const running = () => props.run?.phase === "running";
  return (
    <div class="sb-popover sb-picker sb-ctx-pop" role="dialog" aria-label={`${props.agent.name} context usage`} tabIndex={-1} ref={root}>
      <div class="sb-ctx-head">
        <BrandIcon id={props.agent.id} name={props.agent.name} size={14} />
        <span class="sb-ctx-head-name">{props.agent.name}</span>
        <Show when={known()}>
          <span class={`sb-ctx-pct ${tone()}`}>{pct()}%</span>
        </Show>
      </div>
      <Show when={known()}>
        <Bar pct={pct()} tone={tone()} label="Context used" />
        <p class="sb-ctx-figures">
          <span>{formatTokens(props.usage!.used)} of {formatTokens(props.usage!.size)} tokens</span>
          <span class="sb-ctx-exact">{props.usage!.used.toLocaleString("en-US")} / {props.usage!.size.toLocaleString("en-US")}</span>
        </p>
      </Show>
      <Show when={STATE_NOTE[props.state]}>{(note) => <p class="sb-ctx-note">{note()(props.agent.name)}</p>}</Show>
      <dl class="sb-ctx-facts">
        <Show when={cost()}>
          <div><dt>Session cost</dt><dd>{cost()}</dd></div>
        </Show>
        <Show when={props.model}>
          <div><dt>Model</dt><dd>{props.model}</dd></div>
        </Show>
        <Show when={props.limit}>
          {(limit) => (
            <div class="danger"><dt>{limit().provider ? `${limit().provider} limit` : "Limit"}</dt><dd>{limitText(limit(), props.now)}</dd></div>
          )}
        </Show>
      </dl>
      <Show when={props.run && props.run.phase !== "running"}>
        <p class={`sb-ctx-run ${props.run!.phase}`} role={props.run!.phase === "failed" ? "alert" : "status"}>{compactRunText(props.run!)}</p>
      </Show>
      <Show when={props.compactCommand}>
        <div class="sb-ctx-actions">
          <button
            type="button"
            class="sb-btn sb-ctx-compact"
            classList={{ primary: tone() !== "neutral" || props.run?.phase === "failed" }}
            disabled={props.busy || running()}
            aria-busy={running()}
            title={props.busy && !running() ? "Wait for the current turn to finish" : `Sends ${props.compactCommand} to ${props.agent.name}`}
            onClick={() => props.onCompact()}
          >
            {running() ? "Compacting" : props.run?.phase === "failed" ? "Retry compact" : "Compact"}
          </button>
          <span class="sb-ctx-sub">Sends {props.compactCommand}</span>
        </div>
      </Show>
      <Show when={rows().length}>
        <div class="sb-rule-h" />
        <div class="sb-eyebrow">Delegated agents</div>
        <ul class="sb-ctx-rows" aria-label="Delegated agents context">
          <For each={rows()}>{(row) => <Row row={row} />}</For>
        </ul>
      </Show>
    </div>
  );
}

/** Inputs the compaction run listens to. Accessors, so the run can be driven by the controller or a test. */
export type CompactionSource = {
  usage: () => ContextUsage | undefined;
  running: () => boolean;
  /** Changes identity when a new failure is recorded. */
  failure: () => { message: string } | undefined;
  compactions: () => ReadonlyArray<{ compactionId: string; status: string; error?: string }>;
  send: (command: string) => void;
};

/**
 * One compaction run started from the meter: sends the agent's own command, then follows the usage updates, the ACP
 * compaction updates and the turn end to a settled or failed result.
 */
export function createCompaction(source: CompactionSource) {
  const [run, setRun] = createSignal<CompactRun>();
  let seenCompactions = new Set<string>();
  let failureAtStart: unknown;
  let sawRunning = false;
  const step = (signal: Parameters<typeof compactStep>[1]) => {
    const current = run();
    if (current) setRun(compactStep(current, signal));
  };
  createEffect(on(source.usage, (usage) => {
    if (!untrack(run)) return;
    step({ kind: "usage", pct: usage ? contextPercent(usage.used, usage.size) : undefined });
  }, { defer: true }));
  createEffect(() => {
    const items = source.compactions();
    if (untrack(run)?.phase !== "running") return;
    for (const item of items) {
      if (seenCompactions.has(`${item.compactionId}:${item.status}`)) continue;
      seenCompactions.add(`${item.compactionId}:${item.status}`);
      step({ kind: "compaction", status: item.status, error: item.error });
    }
  });
  createEffect(on(source.running, (running) => {
    if (running) {
      sawRunning = true;
      return;
    }
    if (!sawRunning || untrack(run)?.phase !== "running") return;
    const failure = untrack(source.failure);
    step({ kind: "turnEnd", error: failure && failure !== failureAtStart ? failure.message : undefined });
  }, { defer: true }));
  const start = (command: string) => {
    const usage = source.usage();
    seenCompactions = new Set(source.compactions().map((item) => `${item.compactionId}:${item.status}`));
    failureAtStart = source.failure();
    sawRunning = false;
    setRun(startCompaction(usage ? contextPercent(usage.used, usage.size) : undefined));
    source.send(command);
  };
  return { run, start, clear: () => setRun(undefined) };
}

/** Records which model the last usage report belongs to, so a model switch marks the number stale until the next one. */
export function createStaleTracker(usage: () => ContextUsage | undefined, model: () => string | undefined) {
  const [reportedFor, setReportedFor] = createSignal<string | undefined>(untrack(model));
  createEffect(on(usage, () => setReportedFor(untrack(model)), { defer: true }));
  return () => Boolean(usage()) && model() !== undefined && reportedFor() !== undefined && model() !== reportedFor();
}
