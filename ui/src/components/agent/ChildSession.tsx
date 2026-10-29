import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import type { DelegationTranscript_Serialize as DelegationTranscript } from "../../bindings";
import { isFinished, type DelegationStatusKind } from "../../lib/agent-delegation";

/** How often an open child session refreshes while its task runs. */
export const CHILD_SESSION_POLL_MS = 2000;

type ChildSessionProps = {
  taskId: string;
  agent: string;
  status: DelegationStatusKind;
  /** Reads the task and what its child wrote so far. */
  load: (taskId: string) => Promise<DelegationTranscript>;
  /** Renders the child's text. Plain preformatted text without it. */
  renderText?: (text: string) => JSX.Element;
};

/**
 * The delegated child session, opened from its card. Read only: the text the child agent wrote, as Span received it
 * for this task, refreshed while the task runs. Its tool calls and permission answers are not part of it.
 */
export function ChildSession(props: ChildSessionProps) {
  const [transcript, setTranscript] = createSignal<DelegationTranscript>();
  const [error, setError] = createSignal<string>();
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const refresh = async () => {
    try {
      const next = await props.load(props.taskId);
      if (disposed) return;
      setTranscript(next);
      setError(undefined);
    } catch (cause) {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  createEffect(() => {
    // Read once on open and again whenever the card's status changes; poll while the task is still running.
    props.status;
    void refresh();
    if (isFinished(props.status)) return;
    const timer = setInterval(() => void refresh(), CHILD_SESSION_POLL_MS);
    onCleanup(() => clearInterval(timer));
  });
  const text = () => transcript()?.text.trim() ?? "";
  return (
    <div class="sb-child-session" role="region" aria-label={`${props.agent} session`}>
      <div class="sb-sub sb-child-session-head">
        <Show when={transcript()} fallback={<span>Opening the session</span>}>
          {(loaded) => <span class="sb-ellipsis" title={loaded().task.child.sessionId}>Session {loaded().task.child.sessionId.slice(0, 12)} on {props.agent}. Read only, the agent's replies for this task.</span>}
        </Show>
      </div>
      <Show when={error()}><div class="sb-sub sb-bad" role="alert">Could not open the session: {error()}</div></Show>
      <Show when={transcript()}>
        <Show when={text()} fallback={<div class="sb-sub dim">{isFinished(props.status) ? "The agent wrote no text for this task." : "Nothing written yet."}</div>}>
          <div class="sb-body sb-child-session-text">{props.renderText ? props.renderText(text()) : <pre>{text()}</pre>}</div>
        </Show>
      </Show>
    </div>
  );
}
