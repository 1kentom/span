import { For, Show, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import Icon, { FileIcon } from "./Icon";
import "../styles/run-configurations.css";

/** Presentation rows, derived by the run controller from generated IPC values. */
export type RunConfigurationOption = { id: string; label: string; detail?: string; filePath?: string; detected: boolean };
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
}) {
  const [open, setOpen] = createSignal(false);
  const id = `run-configurations-${createUniqueId()}`;
  let root!: HTMLDivElement; let trigger!: HTMLButtonElement;
  const rows = () => [...root.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  const selected = () => props.options.find(option => option.id === props.value);
  const close = (restore = false) => { setOpen(false); if (restore) trigger.focus(); };
  function show() { setOpen(true); queueMicrotask(() => (rows().find(row => row.dataset.configuration === props.value) || rows()[0] || root.querySelector<HTMLButtonElement>(".run-select-manage"))?.focus()); }
  function choose(option: RunConfigurationOption, run = false) { props.onSelect(option.id); close(true); if (run) props.onRun(); }
  onMount(() => {
    const outside = (event: PointerEvent) => { if (!root.contains(event.target as Node)) close(); };
    const blur = () => close();
    document.addEventListener("pointerdown", outside, true); window.addEventListener("blur", blur);
    onCleanup(() => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("blur", blur); });
  });
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
    <button ref={trigger} class="run-select-trigger" aria-label="Run configuration" aria-haspopup="listbox" aria-expanded={open()} aria-controls={id} disabled={props.disabled} title={selected()?.label || "Choose a run configuration"} onClick={() => open() ? close() : show()}><Icon name="u-play" size={13} /><span>{selected()?.label || "Run configuration"}</span><Icon name="arrow-down4" size={11} /></button>
    <button class="run-toolbar-action run-start" aria-label="Run selected configuration" title="Run selected configuration" disabled={props.disabled || !selected() || props.running || props.busy} onClick={props.onRun}><Icon name="u-play" size={14} /></button>
    <button class="run-toolbar-action" aria-label="Stop run" title="Stop run" disabled={props.disabled || !props.running || props.busy} onClick={props.onStop}><Icon name="Stop" size={14} /></button>
    <Show when={open() && !props.disabled}><div class="run-select-popup" id={id}>
      <div role="listbox" aria-label="Run configurations"><For each={[false, true]}>{detected => <Show when={props.options.some(option => option.detected === detected)}><div class="run-select-heading">{detected ? "Detected tasks" : "Saved configurations"}</div><For each={props.options.filter(option => option.detected === detected)}>{option => <button role="option" aria-selected={option.id === props.value} data-configuration={option.id} onClick={() => choose(option)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); choose(option, event.shiftKey); } }}><Show when={detected} fallback={<Icon name="u-gear" size={14} />}><FileIcon path={option.filePath || option.detail || ""} /></Show><span><strong>{option.label}</strong><Show when={option.detail}><small>{option.detail}</small></Show></span><Show when={option.id === props.value}><span class="run-selected-mark" aria-hidden="true">✓</span></Show></button>}</For></Show>}</For><Show when={!props.options.length}><div class="run-select-empty">No run configurations yet</div></Show></div>
      <button class="run-select-manage" onClick={() => { close(); props.onManage(); }}><Icon name="u-gear" size={14} /><span>Edit configurations…</span></button>
      <div class="run-select-hint">Enter to select · Shift+Enter to run</div>
    </div></Show>
  </div>;
}
