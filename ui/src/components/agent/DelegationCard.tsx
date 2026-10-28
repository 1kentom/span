import { For, Show, createSignal, onCleanup, createEffect } from "solid-js";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";
import type { Artifact } from "../../bindings";
import { formatElapsed } from "../../lib/agent-feed";
import { STATUS_TEXT, boundedSummary, isFinished, taskElapsedMs, type DelegationStatusKind } from "../../lib/agent-delegation";

type DelegationCardProps = {
  agent: string;
  status: DelegationStatusKind;
  /** The reason text for a failed or cancelled task, from the backend's reported reason. */
  note?: string;
  /** The delegated agent has a permission request open in the dock. */
  waiting?: boolean;
  taskId?: string;
  startedAtMs?: number;
  finishedAtMs?: number;
  progressText?: string;
  resultSummary?: string;
  artifacts?: readonly Artifact[];
  /** Budget used so far, already formatted from reported figures. */
  budget?: string;
  /** Stops the task. Called from the Cancel button only. */
  onCancel?: (taskId: string) => Promise<void>;
  /** Opens a workspace-relative path through the validated open path. False when nothing opened. */
  onOpenArtifact?: (path: string) => boolean;
};

const GLYPH: Partial<Record<DelegationStatusKind, { name: string; tone: string }>> = {
  completed: { name: "TickCircle", tone: "sb-ok" },
  failed: { name: "CloseCircle", tone: "sb-bad" },
  cancelled: { name: "Stop", tone: "dim" },
  unknown: { name: "InfoCircle", tone: "dim" },
};

/** A task the lead delegated to another agent. It shows only what the backend reports: status, reason, and timing, progress, result, files and budget when present. */
export function DelegationCard(props: DelegationCardProps) {
  const glyph = () => GLYPH[props.status];
  const finished = () => isFinished(props.status);
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (finished() || typeof props.startedAtMs !== "number") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const elapsed = () => {
    const ms = taskElapsedMs({ startedAtMs: props.startedAtMs, finishedAtMs: props.finishedAtMs, status: props.status }, now());
    return ms === undefined ? undefined : formatElapsed(ms);
  };
  const summary = () => boundedSummary(props.resultSummary);
  const [pending, setPending] = createSignal(false);
  const [cancelError, setCancelError] = createSignal<string>();
  const [openError, setOpenError] = createSignal<string>();
  const cancel = async () => {
    if (pending() || !props.onCancel || !props.taskId) return;
    setPending(true);
    setCancelError(undefined);
    try {
      await props.onCancel(props.taskId);
    } catch (cause) {
      setCancelError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  const openArtifact = (path: string) => setOpenError(props.onOpenArtifact?.(path) ? undefined : `Could not open ${path}`);
  return (
    <section class="sb-delegation" classList={{ failed: props.status === "failed" }} aria-label={`Delegated to ${props.agent}: ${STATUS_TEXT[props.status]}`}>
      <div class="sb-delegation-head">
        <BrandIcon name={props.agent} size={14} />
        <span class="sb-delegation-name sb-ellipsis">{props.agent}</span>
        <span class="sb-chip">Delegated</span>
        <span class="sb-flex" />
        <span class="sb-delegation-status" role="status">
          <Show when={glyph()} fallback={<span class="sb-spinner" aria-hidden="true" />}>
            {(item) => <Icon name={item().name} size={12} class={item().tone} />}
          </Show>
          <span class="sb-sub nowrap">{STATUS_TEXT[props.status]}</span>
        </span>
      </div>
      <Show when={props.note}><div class="sb-body sb-delegation-note">{props.note}</div></Show>
      <Show when={elapsed()}><div class="sb-sub sb-delegation-elapsed">Elapsed {elapsed()}</div></Show>
      <Show when={props.progressText && !finished()}><div class="sb-sub sb-delegation-progress">{props.progressText}</div></Show>
      <Show when={summary()}><div class="sb-body sb-delegation-result">{summary()}</div></Show>
      <Show when={props.artifacts?.length}>
        <ul class="sb-delegation-files" aria-label="Files from this task">
          <For each={props.artifacts}>
            {(artifact) => (
              <li class="sb-mono">
                <Show when={props.onOpenArtifact} fallback={<span class="dim sb-ellipsis" title={artifact.path}>{artifact.path}</span>}>
                  <button type="button" class="sb-link sb-ellipsis" title={`Open ${artifact.path}`} onClick={() => openArtifact(artifact.path)}>{artifact.path}</button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={openError()}><div class="sb-sub sb-bad" role="alert">{openError()}</div></Show>
      <Show when={props.budget}><div class="sb-sub sb-delegation-budget">Used {props.budget}</div></Show>
      <Show when={props.waiting}>
        <div class="sb-delegation-wait"><span class="sb-dot warn" aria-hidden="true" />Needs your approval below</div>
      </Show>
      <Show when={!finished() && props.onCancel && props.taskId}>
        <div class="sb-delegation-actions">
          <button type="button" class="sb-btn danger" disabled={pending()} onClick={() => void cancel()}>{pending() ? "Cancelling" : "Cancel"}</button>
        </div>
      </Show>
      <Show when={cancelError()}><div class="sb-sub sb-bad sb-delegation-error" role="alert">Could not cancel: {cancelError()}</div></Show>
    </section>
  );
}
