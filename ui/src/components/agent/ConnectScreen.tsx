import { For, Show, createEffect, createSignal, on, type JSX } from "solid-js";
import { AnimatedLogo } from "../AnimatedLogo";
import { BrandIcon } from "../BrandIcon";
import { Icon, MenuIcon } from "../Icon";
import { splitCode } from "../../lib/agent-hint-text";
import type { AgentUpdate_Serialize as AgentUpdate } from "../../bindings";
import type { FoundAgent, PresetRow, RegistryAgent } from "./types";
import { CopyCommand, UpdateBadge, UpdatePanel } from "./UpdateBadge";

type ConnectScreenProps = {
  found: FoundAgent[];
  registry: RegistryAgent[];
  /** Known launch commands for agents outside the registry. The command is shown exactly as it will run. */
  presets?: PresetRow[];
  onPreset?: (id: string) => void;
  /** Check-only results from `agent_update_status`. Badges show only for a confirmed newer version. */
  updates?: AgentUpdate[];
  checkingUpdates?: boolean;
  updateError?: string;
  /** A user click. Nothing is checked until this runs. */
  onCheckUpdates?: () => void;
  busy?: boolean;
  onConnect: (id: string) => void;
  onInstall: (id: string) => void;
  /** Receives the command line typed into the custom ACP row. */
  onCustom: (command: string) => void;
  /** The curated agent catalog, drawn under the heading and above the other groups. */
  catalog?: JSX.Element;
  /** A command to place in the custom ACP row and open it for review. The user still presses Connect. */
  customDraft?: { command: string };
  /** Opens a release notes link through the host's external opener. */
  onOpenExternal?: (url: string) => void;
  /** Agents the curated catalog already lists. They are left out of the groups below so each program appears once. */
  listedIds?: readonly string[];
};

/** A one-line subtitle: ellipsis on overflow, the whole text in the title, backticked spans drawn as code. */
function Subtitle(props: { text: string }) {
  return (
    <span class="sb-sub" title={props.text.replace(/`/g, "")}>
      <For each={splitCode(props.text)}>{(part) => (part.code ? <code>{part.text}</code> : part.text)}</For>
    </span>
  );
}

/** A group eyebrow with the number of rows under it. */
function Eyebrow(props: { label: string; count: number }) {
  return (
    <div class="sb-eyebrow">
      {props.label} <span class="sb-count">{props.count}</span>
    </div>
  );
}

/** First-run screen: agents found on this computer, the ACP registry, and a custom command. */
export function ConnectScreen(props: ConnectScreenProps) {
  const [custom, setCustom] = createSignal(false);
  const [command, setCommand] = createSignal("");
  createEffect(
    on(
      () => props.customDraft,
      (draft) => {
        if (!draft?.command) return;
        setCommand(draft.command);
        setCustom(true);
      },
    ),
  );
  const submit = (event: Event) => {
    event.preventDefault();
    const value = command().trim();
    if (value) props.onCustom(value);
  };
  const listed = (id: string) => props.listedIds?.includes(id) ?? false;
  const found = () => props.found.filter((agent) => !listed(agent.id));
  const presets = () => (props.presets ?? []).filter((preset) => !listed(preset.id));
  const updateFor = (id: string) => props.updates?.find((update) => update.id === id);
  const [openUpdate, setOpenUpdate] = createSignal<string>();
  const toggleUpdate = (id: string) => setOpenUpdate((value) => (value === id ? undefined : id));
  const Badge = (badge: { id: string }) => <UpdateBadge update={updateFor(badge.id)} expanded={openUpdate() === badge.id} onToggle={() => toggleUpdate(badge.id)} />;
  const Panel = (panel: { id: string }) => (
    <Show when={openUpdate() === panel.id ? updateFor(panel.id) : undefined}>{(update) => <UpdatePanel update={update()} onOpenExternal={props.onOpenExternal} />}</Show>
  );
  return (
    <section class="sb-connect" aria-labelledby="sb-connect-title">
      <header class="sb-hero">
        <AnimatedLogo size={22} label="Span" />
        <h2 id="sb-connect-title" class="sb-title">Connect an agent</h2>
        <p class="sb-lede">Span talks to coding agents over ACP. They run on your computer with your user's access.</p>
      </header>
      {props.catalog}
      <Show when={found().length}>
        <div class="sb-group" role="group" aria-label="Found on this computer">
          <Eyebrow label="Found on this computer" count={found().length} />
          <For each={found()}>
            {(agent) => (
              <div class="sb-agent-row stacked">
                <div class="sb-agent-line">
                  <BrandIcon id={agent.id} name={agent.name} size={18} />
                  <span class="sb-agent-text">
                    <span class="sb-agent-name">{agent.name}</span>
                    <Show when={agent.subtitle}>{(subtitle) => <Subtitle text={subtitle()} />}</Show>
                    <Badge id={agent.id} />
                  </span>
                  <button class="sb-btn primary" disabled={props.busy} aria-label={`Connect ${agent.name}`} onClick={() => props.onConnect(agent.id)}>Connect</button>
                </div>
                <Panel id={agent.id} />
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={presets().length}>
        <div class="sb-group" role="group" aria-label="Agents with a known command">
          <Eyebrow label="Known commands" count={presets().length} />
          <For each={presets()}>
            {(preset) => (
              <div class="sb-agent-row stacked">
                <div class="sb-agent-line">
                  <BrandIcon id={preset.id} name={preset.name} size={18} />
                  <span class="sb-agent-text">
                    <span class="sb-agent-name">{preset.name}</span>
                    <Show when={preset.description}>{(description) => <Subtitle text={description()} />}</Show>
                    <Badge id={preset.id} />
                  </span>
                  <button class="sb-btn primary" disabled={props.busy} aria-label={`Connect ${preset.name}`} onClick={() => props.onPreset?.(preset.id)}>Connect</button>
                </div>
                <div class="sb-command-chip">
                  <code class="sb-preset-command sb-mono" aria-label={`Command for ${preset.name}`}>{preset.command}</code>
                  <CopyCommand command={preset.command} />
                </div>
                <Panel id={preset.id} />
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.registry.length}>
        <div class="sb-group" role="group" aria-label="ACP registry">
          <Eyebrow label="ACP registry" count={props.registry.length} />
          <For each={props.registry}>
            {(agent) => (
              <div class="sb-agent-row stacked">
                <div class="sb-agent-line">
                  <BrandIcon id={agent.id} name={agent.name} size={18} />
                  <span class="sb-agent-text">
                    <span class="sb-agent-name">{agent.name}</span>
                    <Show when={agent.subtitle}>{(subtitle) => <Subtitle text={subtitle()} />}</Show>
                  </span>
                  <Show when={agent.status === "available"}>
                    <button class="sb-btn secondary" disabled={props.busy} aria-label={`Install ${agent.name}`} onClick={() => props.onInstall(agent.id)}>
                      <MenuIcon name="install" size={13} />
                      Install
                    </button>
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
      <Show when={props.onCheckUpdates}>
        <div class="sb-update-check">
          <button class="sb-btn ghost" disabled={props.checkingUpdates} onClick={() => props.onCheckUpdates?.()}>
            <Icon name="Refresh2" size={13} />
            {props.checkingUpdates ? "Checking for updates…" : "Check agents for updates"}
          </button>
          <Show when={props.updateError}><p class="sb-fine sb-update-error" role="alert">{props.updateError}</p></Show>
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
      <p class="sb-fine sb-delegation-hint">
        Agents can hand work to each other once <code>agents.delegation.enabled</code> is set to true in your user settings file. It is off by default and applies to chats started afterwards.
      </p>
    </section>
  );
}
