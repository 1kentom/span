import { For, Show, createSignal } from "solid-js";
import { AnimatedLogo } from "../AnimatedLogo";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";
import type { FoundAgent, PresetRow, RegistryAgent } from "./types";

type ConnectScreenProps = {
  found: FoundAgent[];
  registry: RegistryAgent[];
  /** Known launch commands for agents outside the registry. The command is shown exactly as it will run. */
  presets?: PresetRow[];
  onPreset?: (id: string) => void;
  busy?: boolean;
  onConnect: (id: string) => void;
  onInstall: (id: string) => void;
  /** Receives the command line typed into the custom ACP row. */
  onCustom: (command: string) => void;
};

/** First-run screen: agents found on this computer, the ACP registry, and a custom command. */
export function ConnectScreen(props: ConnectScreenProps) {
  const [custom, setCustom] = createSignal(false);
  const [command, setCommand] = createSignal("");
  const submit = (event: Event) => {
    event.preventDefault();
    const value = command().trim();
    if (value) props.onCustom(value);
  };
  return (
    <section class="sb-connect" aria-labelledby="sb-connect-title">
      <header class="sb-hero">
        <AnimatedLogo size={22} label="Span" />
        <h2 id="sb-connect-title" class="sb-title">Connect an agent</h2>
        <p class="sb-lede">Span talks to coding agents over ACP. They run on your computer with your user's access.</p>
      </header>
      <Show when={props.found.length}>
        <div class="sb-group" role="group" aria-label="Found on this computer">
          <div class="sb-eyebrow">Found on this computer</div>
          <For each={props.found}>
            {(agent) => (
              <div class="sb-agent-row">
                <BrandIcon id={agent.id} name={agent.name} size={18} />
                <span class="sb-agent-text">
                  <span class="sb-agent-name">{agent.name}</span>
                  <Show when={agent.subtitle}><span class="sb-sub">{agent.subtitle}</span></Show>
                </span>
                <button class="sb-btn primary" disabled={props.busy} aria-label={`Connect ${agent.name}`} onClick={() => props.onConnect(agent.id)}>Connect</button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.presets?.length}>
        <div class="sb-group" role="group" aria-label="Agents with a known command">
          <div class="sb-eyebrow">Known commands</div>
          <For each={props.presets}>
            {(preset) => (
              <div class="sb-agent-row stacked">
                <div class="sb-agent-line">
                  <BrandIcon id={preset.id} name={preset.name} size={18} />
                  <span class="sb-agent-text">
                    <span class="sb-agent-name">{preset.name}</span>
                    <Show when={preset.description}><span class="sb-sub">{preset.description}</span></Show>
                  </span>
                  <button class="sb-btn primary" disabled={props.busy} aria-label={`Connect ${preset.name}`} onClick={() => props.onPreset?.(preset.id)}>Connect</button>
                </div>
                <code class="sb-preset-command sb-mono" aria-label={`Command for ${preset.name}`}>{preset.command}</code>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.registry.length}>
        <div class="sb-group" role="group" aria-label="ACP registry">
          <div class="sb-eyebrow">ACP registry</div>
          <For each={props.registry}>
            {(agent) => (
              <div class="sb-agent-row stacked">
                <div class="sb-agent-line">
                  <BrandIcon id={agent.id} name={agent.name} size={18} />
                  <span class="sb-agent-text">
                    <span class="sb-agent-name">{agent.name}</span>
                    <Show when={agent.subtitle}><span class="sb-sub">{agent.subtitle}</span></Show>
                  </span>
                  <Show when={agent.status === "available"}>
                    <button class="sb-btn" disabled={props.busy} aria-label={`Install ${agent.name}`} onClick={() => props.onInstall(agent.id)}>Install</button>
                  </Show>
                  <Show when={agent.status === "installing"}>
                    <span class="sb-sub nowrap">Installing{agent.progress === undefined ? "…" : ` ${Math.round(agent.progress * 100)}%`}</span>
                  </Show>
                  <Show when={agent.status === "unsupported"}>
                    <span class="sb-sub nowrap">Needs custom command</span>
                  </Show>
                </div>
                <Show when={agent.status === "installing"}>
                  <div
                    class="sb-bar"
                    classList={{ indeterminate: agent.progress === undefined }}
                    role="progressbar"
                    aria-label={`Installing ${agent.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={agent.progress === undefined ? undefined : Math.round(agent.progress * 100)}
                  >
                    <span class="sb-bar-fill" style={agent.progress === undefined ? undefined : { width: `${Math.round(agent.progress * 100)}%` }} />
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="sb-custom">
        <button class="sb-custom-toggle" aria-expanded={custom()} onClick={() => setCustom(!custom())}>
          <Icon name="Code1" size={15} />
          <span class="sb-agent-text">
            <span class="sb-agent-name">Custom ACP command</span>
            <span class="sb-sub">Any executable that speaks ACP over stdio</span>
          </span>
          <Icon name={custom() ? "arrow-down4" : "arrow-right4"} size={11} />
        </button>
        <Show when={custom()}>
          <form class="sb-custom-form" onSubmit={submit}>
            <input
              class="sb-input mono"
              aria-label="ACP command"
              placeholder="my-agent --acp"
              value={command()}
              onInput={(event) => setCommand(event.currentTarget.value)}
            />
            <button class="sb-btn primary" type="submit" disabled={props.busy || !command().trim()}>Connect</button>
          </form>
        </Show>
      </div>
    </section>
  );
}
