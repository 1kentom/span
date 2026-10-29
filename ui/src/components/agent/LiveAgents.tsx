import { For, Show } from "solid-js";
import { BrandIcon } from "../BrandIcon";
import type { LiveAgent } from "../../lib/live-agents";
import { HealthDot } from "./HealthDot";

/**
 * The agents working on the current chat, stacked on the prompt box like the plan drawer. Shown only when more than
 * one agent is involved: a single-agent chat gets nothing. A delegated agent opens its delegation card on click.
 */
export function LiveAgents(props: { agents: LiveAgent[]; now: number; showHealth: boolean; onOpen?: (agent: LiveAgent) => void }) {
  return (
    <Show when={props.agents.length > 1}>
      <section class="sb-drawer sb-live-agents" aria-label="Live agents">
        <span class="sb-live-title">Live agents</span>
        <ul class="sb-live-list">
          <For each={props.agents}>
            {(agent) => {
              const body = () => (
                <>
                  <BrandIcon id={agent.id} name={agent.name} size={13} />
                  <span class="sb-live-name sb-ellipsis">{agent.name}</span>
                  <span class="sb-live-state" data-state={agent.state}>{agent.state}</span>
                  <Show when={props.showHealth}>
                    <HealthDot health={agent.health} now={props.now} />
                  </Show>
                </>
              );
              return (
                <li class="sb-live-agent">
                  <Show when={agent.taskId && props.onOpen} fallback={<span class="sb-live-entry">{body()}</span>}>
                    <button type="button" class="sb-live-entry sb-plain" aria-label={`${agent.name}, ${agent.state}. Show its task`} onClick={() => props.onOpen?.(agent)}>
                      {body()}
                    </button>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </section>
    </Show>
  );
}
