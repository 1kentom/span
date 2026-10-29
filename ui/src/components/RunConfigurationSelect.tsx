import { For, Show, createUniqueId, createSignal, onCleanup, onMount } from "solid-js";
import Icon, { FileIcon } from "./Icon";
import { groupRunOptions, type RunConfigurationOption } from "../lib/run-options";
import "../styles/run-configurations.css";

export type { RunConfigurationOption } from "../lib/run-options";
export function RunConfigurationSelect(props: {
  options: readonly RunConfigurationOption[];
  value?: string;
  disabled?: boolean;
  running?: boolean;
  busy?: boolean;
  onSelect: (id: string) => void;
  onManage: () => void;
  onRun: () => void;
  onStop: () => void;
  onOpen?: () => void;
}) {
  const [open, setOpen] = createSignal(false);
  const id = `run-configurations-${createUniqueId()}`;
  let root!: HTMLDivElement; let trigger!: HTMLButtonElement;
  const rows = () => [...root.querySelectorAll<HTMLButtonElement>('.run-select-popup [role="option"], .run-select-manage')];
  const selected = () => props.options.find(option => option.id === props.value);
  const runnable = () => !!selected() && !selected()!.disabled;
  const groups = () => groupRunOptions(props.options);
  const close = (restore = false) => { setOpen(false); if (restore) trigger.focus(); };
  function show() { setOpen(true); props.onOpen?.(); queueMicrotask(() => { const list = rows(); (list.find(row => row.dataset.configuration === props.value) || list.find(row => row.getAttribute("aria-disabled") !== "true") || list[0])?.focus(); }); }
  function choose(option: RunConfigurationOption, run = false) { if (option.disabled) return; props.onSelect(option.id); close(true); if (run) props.onRun(); }
  onMount(() => {
    const outside = (event: PointerEvent) => { if (!root.contains(event.target as Node)) close(); };
    const blur = () => close();
    document.addEventListener("pointerdown", outside, true); window.addEventListener("blur", blur);
    onCleanup(() => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("blur", blur); });
  });
  const lead = (option: RunConfigurationOption) => option.kind === "current-file" ? <Icon name="RunCurrentFile" size={16} /> : option.kind === "detected" ? <FileIcon path={option.source || ""} /> : <Icon name="u-gear" size={16} />;
  return <div class="run-selector" ref={root} onKeyDown={event => {
    if (event.key === "Escape" && open()) { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && !props.disabled) {
      event.preventDefault(); event.stopPropagation();
      if (!open()) { show(); return; }
      const list = rows(); if (!list.length) return;
      const index = list.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    } else if (event.key === "Tab") close();
  }}>
    <button ref={trigger} class="run-select-trigger" aria-label="Run configuration" aria-haspopup="listbox" aria-expanded={open()} aria-controls={id} disabled={props.disabled} title={selected()?.detail ? `${selected()!.triggerLabel || selected()!.label}: ${selected()!.detail}` : selected()?.label || "Choose a run configuration"} onClick={() => open() ? close() : show()}><Icon name="u-play" size={13} /><span>{selected()?.triggerLabel || selected()?.label || "Run configuration"}</span><Icon name="arrow-down4" size={11} /></button>
    <button class="run-toolbar-action run-start" aria-label="Run selected configuration" title="Run selected configuration" disabled={props.disabled || !runnable() || props.running || props.busy} onClick={props.onRun}><Icon name="u-play" size={14} /></button>
    <button class="run-toolbar-action" aria-label="Stop run" title="Stop run" disabled={props.disabled || !props.running || props.busy} onClick={props.onStop}><Icon name="Stop" size={14} /></button>
    <Show when={open() && !props.disabled}><div class="run-select-popup" id={id}>
      <div class="run-select-list" role="listbox" aria-label="Run configurations"><For each={groups()}>{group => <div class="run-select-group" role="group" aria-label={group.heading || "Current file"}>
        <Show when={group.heading}><div class="run-select-heading"><span>{group.heading}</span><Show when={group.auto}><span class="run-select-chip" title="Found automatically in project files. Read-only until saved as a copy.">Auto</span></Show></div></Show>
        <For each={group.options}>{option => <button role="option" class="run-select-row" aria-selected={option.id === props.value} aria-disabled={option.disabled ? "true" : undefined} data-configuration={option.id} data-kind={option.kind} onClick={() => choose(option)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); choose(option, event.shiftKey); } }}>
          <span class="run-select-lead">{lead(option)}</span>
          <span class="run-select-text"><span class="run-select-label">{option.label}</span><Show when={option.detail}><span class={option.disabled ? "run-select-reason" : "run-select-command"}>{option.detail}</span></Show></span>
          <span class="run-select-check"><Show when={option.id === props.value}><Icon name="RunCheck" size={14} /></Show></span>
        </button>}</For>
      </div>}</For><Show when={!props.options.some(option => option.kind !== "current-file")}><div class="run-select-empty">No saved or detected configurations yet</div></Show></div>
      <div class="run-select-rule" role="separator" />
      <button class="run-select-row run-select-manage" onClick={() => { close(); props.onManage(); }}><span class="run-select-lead"><Icon name="u-gear" size={16} /></span><span class="run-select-text"><span class="run-select-label">Edit configurations…</span></span><span class="run-select-check" /></button>
      <div class="run-select-hint"><span><kbd>Enter</kbd> select</span><span><kbd>Shift</kbd><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span></div>
    </div></Show>
  </div>;
}
