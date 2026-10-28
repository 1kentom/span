import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { markState, type MarkInput, type MarkState } from "../../lib/agent-mark";
import { ComposerHints, type ComposerHintsProps } from "./ComposerHints";
import "../../styles/agent-mark.css";

const DONE_MS = 900;

/** The brand mark at status size. Motion comes from the pack's states and stays inside its fixed box. */
export function AgentMark(props: { state: MarkState; size?: number }) {
  const width = () => props.size ?? 16;
  return (
    <span class="agent-mark" data-state={props.state} aria-hidden="true" style={{ width: `${width()}px`, height: `${(width() * 969) / 916}px` }}>
      <img src="/span-logo.svg" alt="" width="916" height="969" draggable={false} />
    </span>
  );
}

export type AgentStatusBarProps = {
  text: string;
  running: boolean;
  input: Omit<MarkInput, "running" | "justFinished">;
  hints: ComposerHintsProps;
};

/** One line under the prompt box: the mark, what the agent is doing, then the shortcuts that really apply. */
export function AgentStatusBar(props: AgentStatusBarProps) {
  const [justFinished, setJustFinished] = createSignal(false);
  createEffect(on(() => props.running, (now, before) => {
    if (!before || now) return;
    setJustFinished(true);
    const timer = setTimeout(() => setJustFinished(false), DONE_MS);
    onCleanup(() => clearTimeout(timer));
  }));
  const state = () => markState({ ...props.input, running: props.running, justFinished: justFinished() });
  return (
    <div class="agent-statusbar" data-state={state()}>
      <AgentMark state={state()} />
      <span class="agent-statusbar-text">{props.text}</span>
      <ComposerHints {...props.hints} />
    </div>
  );
}
