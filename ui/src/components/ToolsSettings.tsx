import { For, Show, createMemo, createSignal } from "solid-js";
import type { ToolInfo } from "../bindings";
import { BrandIcon } from "./BrandIcon";
import Icon from "./Icon";
import "../styles/tools.css";

export interface ToolsSettingsProps {
  tools: ToolInfo[];
  desktop: boolean;
  busy?: boolean;
  loaded?: boolean;
  error?: string;
  onRefresh: () => Promise<void>;
}

export function ToolsSettings(props: ToolsSettingsProps) {
  const [query, setQuery] = createSignal("");
  const [showMissing, setShowMissing] = createSignal(false);
  const installed = createMemo(() => props.tools.filter(tool => tool.available));
  const filtered = createMemo(() => props.tools.filter(tool => (tool.available || showMissing()) && `${tool.name} ${tool.kind} ${tool.program}`.toLowerCase().includes(query().trim().toLowerCase())));
  return <section class="tools-settings" aria-label="Developer tools">
    <div class="tools-heading"><div><h2>On this device</h2><p>Available command line tools and versions. Agent connections are managed in the assistant panel.</p></div><button class="button" disabled={!props.desktop || props.busy} onClick={() => void props.onRefresh()}><Icon name="Refresh2" size={13} />{props.busy ? "Checking…" : "Refresh"}</button></div>
    <Show when={props.desktop} fallback={<div class="tools-empty"><Icon name="Code1" size={24} /><strong>Open span desktop to inspect your tools</strong><p>The browser preview cannot read installed programs on your device.</p></div>}>
      <Show when={props.error}><p class="error-text" role="alert">{props.error}</p></Show>
      <div class="tools-filters"><label class="tools-search"><Icon name="SearchNormal1" size={14} /><input type="search" aria-label="Search developer tools" placeholder="Search tools" value={query()} onInput={event => setQuery(event.currentTarget.value)} /></label><label class="tools-missing"><input type="checkbox" checked={showMissing()} onChange={event => setShowMissing(event.currentTarget.checked)} />Show unavailable</label></div>
      <p class="tools-summary" aria-live="polite">{props.busy ? "Checking known tools…" : props.loaded ? `${installed().length} available ${installed().length === 1 ? "tool" : "tools"}` : "Refresh to inspect known tools."}</p>
      <Show when={filtered().length} fallback={<Show when={props.loaded && !props.busy}><p class="tools-empty">{query() ? "No tools match your search." : "No known tools found. Enable Show unavailable to see the tools span checks."}</p></Show>}>
        <div class="tools-list"><For each={filtered()}>{tool => <article class="tools-row"><BrandIcon id={tool.id} name={tool.name} size={23} fallback="Code1" /><div class="tools-detail"><div class="tools-name"><h3>{tool.name}</h3><span>{tool.kind}</span></div><p>{tool.version || (tool.available ? "Version unavailable" : "Not found")}</p><Show when={tool.path}><code title={tool.path || undefined}>{tool.path}</code></Show></div><span class="tools-availability" classList={{ available: tool.available }}>{tool.available ? "Available" : "Unavailable"}</span></article>}</For></div>
      </Show>
    </Show>
  </section>;
}
