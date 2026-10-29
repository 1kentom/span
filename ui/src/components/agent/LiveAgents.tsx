import { For, Show, createUniqueId } from "solid-js";
import { BrandIcon } from "../BrandIcon";
import { healthText } from "../../lib/agent-health";
import { liveStateText, liveSummary, liveTone, orderByUrgency, stackOf, type LiveAgent } from "../../lib/live-agents";

/** Avatars shown whole before the rest fold into a "+N" chip. */
const MAX_VISIBLE = 5;

/**
 * The agents working on the current chat, as one row stacked on the prompt box like the plan drawer: an "Active
 * agents" label, overlapping brand avatars (most urgent first, each with a state badge) and a one-phrase summary.
 * Shown only when more than one agent is involved: a single-agent chat gets nothing. A delegated agent's avatar opens
 * its delegation card on click. Hover or focus shows the full name, state and current task or model.
 */
export function LiveAgents(props: { agents: LiveAgent[]; now: number; showHealth: boolean; onOpen?: (agent: LiveAgent) => void }) {
  const ordered = () => orderByUrgency(props.agents, props.showHealth);
  const stack = () => stackOf(ordered(), MAX_VISIBLE);
  const summary = () => liveSummary(props.agents, props.showHealth);
  const describe = (agent: LiveAgent) => `${agent.name}${agent.lead ? " (lead)" : ""}, ${liveStateText(agent, props.showHealth)}`;
  return (
    <Show when={props.agents.length > 1}>
      <section class="sb-drawer sb-live-agents" aria-label="Active agents">
        <span class="sb-live-title">Active agents</span>
        <ul class="sb-live-stack">
          <For each={stack().visible}>
            {(agent, index) => {
              const tipId = createUniqueId();
              const tone = () => liveTone(agent, props.showHealth);
              const avatar = () => (
                <>
                  <span class="sb-live-face">
                    <BrandIcon id={agent.id} name={agent.name} size={12} />
                  </span>
                  <span class="sb-live-badge" data-tone={tone()} aria-hidden="true" />
                </>
              );
              const label = () => `${describe(agent)}${agent.taskId && props.onOpen ? ". Show its task" : ""}`;
              return (
                <li class="sb-live-agent" data-tone={tone()} style={{ "--sb-live-z": String(MAX_VISIBLE - index()) }}>
                  <Show
                    when={agent.taskId && props.onOpen}
                    fallback={
                      <span class="sb-live-avatar" tabindex="0" role="img" aria-label={label()} aria-describedby={tipId}>
                        {avatar()}
                      </span>
                    }
                  >
                    <button type="button" class="sb-live-avatar sb-plain" aria-label={label()} aria-describedby={tipId} onClick={() => props.onOpen?.(agent)}>
                      {avatar()}
                    </button>
                  </Show>
                  <span class="sb-live-tip" role="tooltip" id={tipId}>
                    <span class="sb-live-tip-name">
                      {agent.name}
                      <Show when={agent.lead}>
                        <span class="sb-live-tip-role"> Lead</span>
                      </Show>
                    </span>
                    <span class="sb-live-tip-state" data-tone={tone()}>
                      {liveStateText(agent, props.showHealth)}
                    </span>
                    <Show when={agent.detail}>
                      <span class="sb-live-tip-detail">{agent.detail}</span>
                    </Show>
                    <Show when={props.showHealth}>
                      <span class="sb-live-tip-health">{healthText(agent.health, props.now)}</span>
                    </Show>
                  </span>
                </li>
              );
            }}
          </For>
          <Show when={stack().hidden.length}>
            {(() => {
              const tipId = createUniqueId();
              const names = () => stack().hidden.map(describe).join("; ");
              return (
                <li class="sb-live-agent sb-live-more-item">
                  <span class="sb-live-more" tabindex="0" role="img" aria-label={`${stack().hidden.length} more: ${names()}`} aria-describedby={tipId}>
                    +{stack().hidden.length}
                  </span>
                  <span class="sb-live-tip" role="tooltip" id={tipId}>
                    <For each={stack().hidden}>
                      {(agent) => (
                        <span class="sb-live-tip-row">
                          <span class="sb-live-badge inline" data-tone={liveTone(agent, props.showHealth)} aria-hidden="true" />
                          <span class="sb-live-tip-name">{agent.name}</span>
                          <span class="sb-live-tip-state" data-tone={liveTone(agent, props.showHealth)}>
                            {liveStateText(agent, props.showHealth)}
                          </span>
                        </span>
                      )}
                    </For>
                  </span>
                </li>
              );
            })()}
          </Show>
        </ul>
        <span class="sb-live-summary" data-tone={summary().tone}>
          {summary().text}
        </span>
      </section>
    </Show>
  );
}
