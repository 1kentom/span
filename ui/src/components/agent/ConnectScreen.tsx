import { For, Show, createEffect, createSignal, on, onCleanup, type JSX } from "solid-js";
import { AnimatedLogo } from "../AnimatedLogo";
import { BrandIcon } from "../BrandIcon";
import { Icon, MenuIcon } from "../Icon";
import type { AgentUpdate_Serialize as AgentUpdate } from "../../bindings";
import type { FoundAgent, PresetRow, RegistryAgent } from "./types";
import { UpdateBadge } from "./UpdateBadge";

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
  /** Copies a shown launch command. Without it the browser clipboard is used. */
  onCopyCommand?: (command: string) => unknown;
  /**
   * Asks to remove an installed agent (`uninstall` also deletes its managed files). The request only opens the
   * confirmation; nothing is removed here. Without it the manage menu has no removal entries.
   */
  onRemove?: (id: string, uninstall: boolean) => void;
};

/**
 * A launch command on one line that fills the text column: the command on the left, cut with an ellipsis when it
 * does not fit (the full text is in the title), and an icon-only copy button on the right. It never wraps or stacks.
 */
export function CommandChip(props: { command: string; label?: string; onCopy?: (command: string) => unknown }) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const copy = async () => {
    try {
      await (props.onCopy ? props.onCopy(props.command) : navigator.clipboard.writeText(props.command));
      setCopied(true);
      clearTimeout(timer);
      timer = setTimeout(() => setCopied(false), 1500);
    } catch { /* the command stays selectable */ }
  };
  onCleanup(() => clearTimeout(timer));
  return (
    <span class="sb-command-chip">
      <code class="sb-preset-command sb-mono" aria-label={props.label} title={props.command}>{props.command}</code>
      <button type="button" class="sb-icon-btn sb-command-copy" classList={{ copied: copied() }} aria-label="Copy command" title={copied() ? "Copied" : "Copy command"} onClick={() => void copy()}>
        <Icon name={copied() ? "TickCircle" : "Copy"} size={13} />
      </button>
      <span class="sb-visually-hidden" role="status" aria-live="polite">{copied() ? "Copied" : ""}</span>
    </span>
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
  const updateFor = (id: string) => props.updates?.find((update) => update.id === id);
  const [managing, setManaging] = createSignal<string>();
  const remove = (id: string, uninstall: boolean) => {
    setManaging(undefined);
    props.onRemove?.(id, uninstall);
  };
  return (
    <section class="sb-connect" aria-labelledby="sb-connect-title">
      <header class="sb-hero">
        <AnimatedLogo size={22} label="Span" />
        <h2 id="sb-connect-title" class="sb-title">Connect an agent</h2>
        <p class="sb-lede">Span talks to coding agents over ACP. They run on your computer with your user's access.</p>
      </header>
      {props.catalog}
      <Show when={props.found.length}>
        <div class="sb-group" role="group" aria-label="Found on this computer">
          <div class="sb-eyebrow">Found on this computer</div>
          <For each={props.found}>
            {(agent) => (
              <div class="sb-found-entry" data-agent-id={agent.id}>
                <div class="sb-agent-row">
                  <BrandIcon id={agent.id} name={agent.name} size={18} />
                  <span class="sb-agent-text">
                    <span class="sb-agent-name">{agent.name}</span>
                    <span class="sb-sub sb-installed-line">
                      <Icon name="TickCircle" size={11} />
                      <span>Installed{agent.subtitle ? ` · ${agent.subtitle}` : ""}</span>
                    </span>
                    <UpdateBadge update={updateFor(agent.id)} />
                  </span>
                  <button class="sb-btn primary" disabled={props.busy} aria-label={`Connect ${agent.name}`} onClick={() => props.onConnect(agent.id)}>Connect</button>
                  <Show when={props.onRemove || props.onCheckUpdates}>
                    <button
                      type="button"
                      class="sb-icon-btn sb-found-manage"
                      aria-label={`Manage ${agent.name}`}
                      aria-expanded={managing() === agent.id}
                      onClick={() => setManaging((open) => (open === agent.id ? undefined : agent.id))}
                    >
                      <Icon name="3DotsMore" size={14} />
                    </button>
                  </Show>
                </div>
                <Show when={managing() === agent.id}>
                  <div class="agent-row-management sb-found-management">
                    <Show when={props.onRemove}>
                      <button type="button" onClick={() => remove(agent.id, false)}>
                        <Icon name="CloseCircle" size={14} />
                        Remove from Span
                      </button>
                      <button type="button" onClick={() => remove(agent.id, true)}>
                        <MenuIcon name="trash" size={14} />
                        Uninstall managed adapter
                      </button>
                    </Show>
                    <Show when={props.onCheckUpdates}>
                      <button type="button" disabled={props.checkingUpdates} onClick={() => { setManaging(undefined); props.onCheckUpdates?.(); }}>
                        <Icon name="Refresh2" size={14} />
                        Check for updates
                      </button>
                    </Show>
                  </div>
                </Show>
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
              <div class="sb-agent-row sb-preset-row">
                <BrandIcon id={preset.id} name={preset.name} size={18} />
                <span class="sb-agent-text">
                  <span class="sb-agent-name">{preset.name}</span>
                  <Show when={preset.description}><span class="sb-sub">{preset.description}</span></Show>
                  <CommandChip command={preset.command} label={`Command for ${preset.name}`} onCopy={props.onCopyCommand} />
                  <UpdateBadge update={updateFor(preset.id)} />
                </span>
                <button class="sb-btn primary" disabled={props.busy} aria-label={`Connect ${preset.name}`} onClick={() => props.onPreset?.(preset.id)}>Connect</button>
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
      <Show when={props.onCheckUpdates}>
        <div class="sb-update-check">
          <button class="sb-btn" disabled={props.checkingUpdates} onClick={() => props.onCheckUpdates?.()}>
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
