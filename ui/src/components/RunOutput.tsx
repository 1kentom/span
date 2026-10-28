import { For, Show, createEffect, createSignal, type JSX } from "solid-js";
import type { RunWorkbench } from "../stores/runs";
import Icon, { MenuIcon } from "./Icon";
import "../styles/run-configurations.css";

export const runOutputText = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, character => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`);
export function RunOutput(props: { workbench: RunWorkbench; available: boolean; headerStart?: JSX.Element; onHide?: () => void }) {
  const w = props.workbench; let output!: HTMLDivElement;
  const [following, setFollowing] = createSignal(true);
  const current = () => w.selectedRun();
  const text = () => w.outputs()[w.selectedRunId() || ""];
  const active = () => current()?.status === "running" || current()?.status === "stopping";
  createEffect(() => { text(); if (following()) queueMicrotask(() => { if (output?.isConnected) output.scrollTop = output.scrollHeight; }); });
  return <section class="run-output" aria-label="Run output">
    <header class="run-output-toolbar">{props.headerStart}<Icon name="u-play" size={14} /><strong>{current()?.name || w.selectedConfiguration()?.name || "Run"}</strong><Show when={current()}>{run => <span class={`run-status run-status-${run().status}`} role="status">{run().status === "exited" ? `Exited (${run().exitCode ?? "unknown"})` : run().status === "failed" ? "Failed" : run().status === "stopped" ? "Stopped" : run().status === "stopping" ? "Stopping" : "Running"}</span>}</Show><span class="run-output-spacer" />
      <button class="icon-button" aria-label="Restart selected run" title="Restart selected run" disabled={!props.available || !current() || !!w.operation()} onClick={() => void w.launch(true)}><Icon name="Refresh2" size={14} /></button>
      <button class="icon-button" aria-label="Stop selected run" title="Stop selected run" disabled={!props.available || !active() || !!w.operation()} onClick={() => void w.stop()}><Icon name="Stop" size={14} /></button>
      <button class="icon-button" aria-label="Clear run output" title="Clear display" disabled={!current()} onClick={w.clearOutput}><MenuIcon name="discard" size={14} /></button><Show when={props.onHide}><button class="icon-button" aria-label="Close run panel" title="Hide run output" onClick={props.onHide}><MenuIcon name="cancel" size={14} /></button></Show>
    </header>
    <Show when={w.runs().length > 1}><div class="run-history" role="tablist" aria-label="Run sessions"><For each={w.runs()}>{run => <button role="tab" aria-selected={w.selectedRunId() === run.id} onClick={() => { setFollowing(true); void w.selectRun(run.id); }}>{run.name}<small>{run.status}</small></button>}</For></div></Show>
    <div class="run-output-policy">Runs saved files. Editor changes are not saved automatically.</div>
    <Show when={w.error() || current()?.error}><div class="run-error" role="alert">{w.error() || current()?.error}<button class="run-retry" onClick={() => void w.retry()}>Refresh run state</button></div></Show>
    <Show when={text()?.trimmed}><div class="run-output-truncated" role="status">Older output was trimmed to keep the view responsive.</div></Show>
    <div ref={output} class="run-output-console" role="log" aria-label="Process output" aria-live="off" onScroll={() => setFollowing(output.scrollHeight - output.clientHeight - output.scrollTop < 24)}><Show when={text()?.chunks.length} fallback={<div class="run-output-empty">{!props.available ? "Process execution requires the desktop app. Browser preview does not execute commands." : w.operation() === "start" ? "Starting process…" : current() ? "No process output yet." : "Select a configuration and choose Run."}</div>}><For each={text()?.chunks || []}>{chunk => <span class={`run-output-${chunk.stream}`}><Show when={chunk.stream === "stderr"}><span class="sr-only">stderr: </span></Show>{runOutputText(chunk.text)}</span>}</For></Show></div>
    <Show when={!following()}><button class="run-follow" onClick={() => { setFollowing(true); output.scrollTop = output.scrollHeight; }}>Follow output<Icon name="arrow-down4" size={11} /></button></Show>
  </section>;
}
