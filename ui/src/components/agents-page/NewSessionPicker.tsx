import { For, Show } from "solid-js";
import type { AgentHealth } from "../../lib/agent-health";
import { BrandIcon } from "../BrandIcon";
import { HealthDot } from "../agent/HealthDot";

export type PickerAgent = { id: string; name: string; connected: boolean; model?: string; health?: AgentHealth };

/**
 * The new-session picker in the thread area: one card per installed agent (model and health when known) to lead the
 * session, and the agents it can delegate to. Delegation is one user setting today (`agents.delegation.enabled`), so
 * the switch is that setting and the chips only show who would be offered; there is no per-agent allowlist yet.
 */
export function NewSessionPicker(props: {
  workspaceName: string;
  agents: PickerAgent[];
  busy: boolean;
  now: number;
  showHealth: boolean;
  delegationEnabled: boolean;
  onDelegationChange?: (enabled: boolean) => void;
  onPick: (id: string) => void;
  onCancel?: () => void;
  onMoreAgents: () => void;
}) {
  let grid: HTMLDivElement | undefined;
  const move = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) || !grid) return;
    const cards = [...grid.querySelectorAll<HTMLButtonElement>("button.ap-agent-card")];
    const at = cards.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    cards[(at + step + cards.length) % cards.length]?.focus();
  };
  return (
    <section class="ap-picker" aria-labelledby="ap-picker-title">
      <header class="ap-picker-head">
        <h3 id="ap-picker-title">Start a session in {props.workspaceName}</h3>
        <p>Pick the lead agent. It can hand parts of the task to the agents you allow below.</p>
      </header>
      <Show when={props.agents.length} fallback={<p class="ap-picker-note">No agents are installed yet.</p>}>
        <div ref={grid} class="ap-agent-grid" role="group" aria-label="Lead agent" onKeyDown={move}>
          <For each={props.agents}>
            {(agent) => (
              <button type="button" class="ap-agent-card" classList={{ connected: agent.connected }} disabled={props.busy} aria-label={`Start with ${agent.name}${agent.connected ? ", connected" : ""}${agent.model ? `, ${agent.model}` : ""}`} onClick={() => props.onPick(agent.id)}>
                <span class="ap-agent-card-head">
                  <BrandIcon id={agent.id} name={agent.name} size={18} />
                  <span class="ap-agent-card-name">{agent.name}</span>
                  <Show when={props.showHealth}>
                    <HealthDot health={agent.health} now={props.now} />
                  </Show>
                </span>
                <span class="ap-agent-card-meta">{agent.connected ? `Connected${agent.model ? ` · ${agent.model}` : ""}` : agent.model ? `Last used ${agent.model}` : "Starts on pick"}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="ap-delegate">
        <label class="ap-switch">
          <input type="checkbox" role="switch" checked={props.delegationEnabled} disabled={!props.onDelegationChange} onChange={(event) => props.onDelegationChange?.(event.currentTarget.checked)} />
          <span class="ap-switch-track" aria-hidden="true" />
          <span>Can delegate to</span>
        </label>
        <ul class="ap-delegate-list" aria-label="Agents a lead may delegate to">
          <For each={props.agents}>
            {(agent) => (
              <li class="ap-delegate-chip" classList={{ off: !props.delegationEnabled }}>
                <BrandIcon id={agent.id} name={agent.name} size={13} />
                {agent.name}
              </li>
            )}
          </For>
        </ul>
        <span class="ap-delegate-note">{props.delegationEnabled ? "Depth 1. Their permission requests come to you." : "Delegation is off in your user settings."}</span>
      </div>
      <div class="ap-picker-actions">
        <button type="button" class="ap-btn ghost" onClick={() => props.onMoreAgents()}>
          Install or connect another agent
        </button>
        <Show when={props.onCancel}>
          <button type="button" class="ap-btn ghost" onClick={() => props.onCancel?.()}>
            Back to the thread
          </button>
        </Show>
      </div>
    </section>
  );
}
