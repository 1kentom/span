import { For } from "solid-js";
import type { MarkdownView } from "../bindings";
import Icon from "./Icon";
import "../styles/markdown.css";

const modes = ["source", "preview", "both"] as const;
const labels: Record<MarkdownView, string> = { source: "Source", preview: "Preview", both: "Source and preview" };

export function SourcePreviewToggle(props: { value: MarkdownView; onChange: (value: MarkdownView) => void; label?: string }) {
  let group!: HTMLDivElement;
  function keydown(event: KeyboardEvent) {
    const current = modes.indexOf(props.value);
    const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : ["ArrowRight", "ArrowDown"].includes(event.key) ? (current + 1) % 3 : ["ArrowLeft", "ArrowUp"].includes(event.key) ? (current + 2) % 3 : -1;
    if (next < 0) return;
    event.preventDefault();
    props.onChange(modes[next]);
    group.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }
  return <div ref={group} class="markdown-view-toggle" role="radiogroup" aria-label={props.label || "Document view"} onKeyDown={keydown}>
    <For each={modes}>{mode => <button type="button" role="radio" aria-label={labels[mode]} aria-checked={props.value === mode} tabIndex={props.value === mode ? 0 : -1} title={labels[mode]} onClick={() => props.onChange(mode)}><Icon name={`markdown-view-${mode}`} size={16} /></button>}</For>
  </div>;
}
