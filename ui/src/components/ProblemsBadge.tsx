import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "./Icon";
import { BrandIcon } from "./BrandIcon";
import type { BrandIdentity } from "../lib/brand-icons";
import { agentPrompt, summarize, type Problem } from "../lib/problems";

export interface ProblemsBadgeProps {
  path: string;
  problems: readonly Problem[];
  /** Whether the file has been checked by a language server at all. Without it no tick is shown. */
  checked: boolean;
  onJump: (line: number, column: number) => void;
  /** Hands text to the agent composer. Left out when there is no agent panel. */
  onAskAgent?: (text: string) => void;
  lineText?: (line: number) => string | undefined;
  /** The agent the "Fix with agent" buttons hand work to, for its mark. */
  agent?: BrandIdentity;
}

/** Per file problems badge, top right of the editor, with a popover that lists them. Design: `.probs` and `.pw`. */
export function ProblemsBadge(props: ProblemsBadgeProps) {
  const [open, setOpen] = createSignal(false);
  const [onlyErrors, setOnlyErrors] = createSignal(false);
  const [picked, setPicked] = createSignal<number>();
  let root: HTMLDivElement | undefined;
  const summary = () => summarize(props.problems);
  const shown = () => (onlyErrors() ? props.problems.filter(item => item.severity === "error") : props.problems);
  const mixed = () => summary().errors > 0 && summary().warnings > 0;
  const lead = () => (summary().errors ? "" : "warn");
  onMount(() => {
    const away = (event: PointerEvent) => { if (open() && root && !root.contains(event.target as Node)) setOpen(false); };
    const keys = (event: KeyboardEvent) => { if (open() && event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", away, true); document.addEventListener("keydown", keys, true);
    onCleanup(() => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", keys, true); });
  });
  const ask = (items: readonly Problem[], action: "fix" | "explain") => { props.onAskAgent?.(agentPrompt(props.path, items, action, props.lineText)); setOpen(false); };
  return <Show when={props.problems.length > 0 || props.checked}>
    <div class="problems" ref={root}>
      <button class="probs" title={summary().label} aria-label={summary().label} aria-haspopup="dialog" aria-expanded={open()} onClick={() => setOpen(value => !value)}>
        <Show when={props.problems.length} fallback={<span class="pb-ok"><Icon name="TickCircle" size={16} /></span>}>
          <Show when={mixed()}><span class="sl sl2" /><span class="sl sl1" /></Show>
          <span class={`pb ${lead()}`}>{props.problems.length > 99 ? "99+" : props.problems.length}</span>
        </Show>
      </button>
      <Show when={open()}>
        <div class="pw" role="dialog" aria-label="Problems">
          <div class="pw-head">
            <Show when={summary().errors}><span class="cnt cnt-err">{summary().errors} {summary().errors === 1 ? "error" : "errors"}</span></Show>
            <Show when={summary().warnings}><span class="cnt cnt-warn">{summary().warnings} {summary().warnings === 1 ? "warning" : "warnings"}</span></Show>
            <Show when={!summary().total}><span class="cnt cnt-ok">No problems</span></Show>
            <span class="pw-spacer" />
            <Show when={props.onAskAgent && summary().total}><button class="pw-ai" title="Send these problems to the agent as context" onClick={() => ask(shown(), "fix")}><BrandIcon {...props.agent} fallback="flash" size={14} /><span>{shown().length === 1 ? "Fix with agent" : `Fix ${shown().length} with agent`}</span></button></Show>
            <Show when={summary().errors && summary().warnings}><button class="mini" classList={{ on: onlyErrors() }} title="Show errors only" aria-label="Show errors only" aria-pressed={onlyErrors()} onClick={() => setOnlyErrors(value => !value)}><Icon name="Filter" size={15} /></button></Show>
            <button class="mini" title="Close" aria-label="Close problems" onClick={() => setOpen(false)}><Icon name="Close" size={14} /></button>
          </div>
          <div class="pw-list">
            <For each={shown()}>{(item, index) => <div class={`pw-item ${item.severity === "error" ? "err" : "warn"}`} classList={{ sel: picked() === index() }}>
              <button class="pw-main" onClick={() => { setPicked(index()); props.onJump(item.line, item.column); }}>
                <Show when={item.severity === "error"} fallback={<svg class="pw-ic warn" viewBox="0 0 16 16" role="img" aria-label="Warning"><path d="M8 1.6 15.2 14H.8z" fill="#cd984d" stroke="#cd984d" stroke-width="1.4" stroke-linejoin="round" /><path d="M8 6v3.6" stroke="#18191b" stroke-width="1.5" stroke-linecap="round" /><circle cx="8" cy="11.9" r=".9" fill="#18191b" /></svg>}>
                  <svg class="pw-ic err" viewBox="0 0 16 16" role="img" aria-label="Error"><circle cx="8" cy="8" r="7" fill="#e1465e" /><path d="M8 4.2v4.4" stroke="#fff" stroke-width="1.6" stroke-linecap="round" /><circle cx="8" cy="11.4" r=".95" fill="#fff" /></svg>
                </Show>
                <span class="pw-text">{item.message}</span>
                <span class="pw-line">:{item.line}</span>
              </button>
              <Show when={props.onAskAgent && picked() !== index()}><button class="pw-ask" title="Fix with agent" aria-label={`Ask the agent to fix: ${item.message}`} onClick={() => ask([item], "fix")}><BrandIcon {...props.agent} fallback="flash" size={14} /></button></Show>
              <Show when={picked() === index() && props.onAskAgent}>
                <div class="pw-fix">
                  <button class="pw-agent" onClick={() => ask([item], "fix")}><BrandIcon {...props.agent} fallback="flash" size={14} /><span>Fix with agent</span></button>
                  <button class="pw-agent ghost" onClick={() => ask([item], "explain")}>Explain</button>
                </div>
              </Show>
            </div>}</For>
          </div>
        </div>
      </Show>
    </div>
  </Show>;
}
