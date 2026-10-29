import { For } from "solid-js";
import type { StartMode } from "../bindings";

/** Settings row for `agents.warmStart` (ADR 0009). It is saved to the user settings file only, like delegation. */
export interface AgentStartSettingsProps {
  /** The merged `agents.warmStart`. Unset means the default, which is on. */
  enabled?: boolean;
  /** Writes `agents.warmStart` to the user settings file. Without it the switch is read-only. */
  onChange?: (enabled: boolean) => void;
}

export function AgentStartSettings(props: AgentStartSettingsProps) {
  const on = () => props.enabled ?? true;
  const id = "agent-warm-start";
  return (
    <div class="sp-preference">
      <div class="sp-preference-label">
        <label for={id}>Start installed agents in the background</label>
        <p id={`${id}-help`}>When a folder opens, Span starts up to four installed agents, most recently used first, without opening a chat or using a model. Switching to one or delegating to it then does not wait. Saved in your user settings.</p>
        <span class="sp-setting-path">agents.warmStart</span>
      </div>
      <div class="sp-preference-control">
        <button id={id} class="sp-switch" role="switch" aria-label="Start installed agents in the background" aria-describedby={`${id}-help`} aria-checked={on()} disabled={!props.onChange} onClick={() => props.onChange?.(!on())}>
          <span />
        </button>
      </div>
    </div>
  );
}

/** Settings row for `agents.healthCheck` (ADR 0010). Saved to the user settings file only, like warm start. */
export interface AgentHealthSettingsProps {
  /** The merged `agents.healthCheck`. Unset means the default, which is on. */
  enabled?: boolean;
  /** Writes `agents.healthCheck` to the user settings file. Without it the switch is read-only. */
  onChange?: (enabled: boolean) => void;
}

export function AgentHealthSettings(props: AgentHealthSettingsProps) {
  const on = () => props.enabled ?? true;
  const id = "agent-health-check";
  return (
    <div class="sp-preference">
      <div class="sp-preference-label">
        <label for={id}>Check agents in the background</label>
        <p id={`${id}-help`}>Every five minutes, Span sends one short prompt to each running agent you are not chatting with and shows a dot for whether it replied. It never starts an agent and never adds to your history; each check uses a few tokens of that agent's model. Saved in your user settings.</p>
        <span class="sp-setting-path">agents.healthCheck</span>
      </div>
      <div class="sp-preference-control">
        <button id={id} class="sp-switch" role="switch" aria-label="Check agents in the background" aria-describedby={`${id}-help`} aria-checked={on()} disabled={!props.onChange} onClick={() => props.onChange?.(!on())}>
          <span />
        </button>
      </div>
    </div>
  );
}

/** Agents whose own configuration can start a session in a mode that skips approval prompts, with their adapter id. */
const START_MODE_AGENTS: [string, string][] = [["claude", "Claude Agent"], ["codex", "Codex"], ["gemini", "Gemini CLI"], ["generic", "Other agents"]];

/** Settings rows for `agents.startMode.<agent>` (#81). Saved to the user settings file only, like warm start. */
export interface AgentStartModeSettingsProps {
  /** The merged `agents.startMode`. A missing entry means `approval`. */
  value?: Partial<Record<string, StartMode>>;
  /** Writes the whole `agents.startMode` map to the user settings file. Without it the switches are read-only. */
  onChange?: (value: Partial<Record<string, StartMode>>) => void;
}

export function AgentStartModeSettings(props: AgentStartModeSettingsProps) {
  const keeps = (agent: string) => props.value?.[agent] === "agentDefault";
  const toggle = (agent: string) => {
    const next = { ...(props.value ?? {}) };
    if (keeps(agent)) delete next[agent];
    else next[agent] = "agentDefault";
    props.onChange?.(next);
  };
  return (
    <For each={START_MODE_AGENTS}>
      {([agent, name]) => {
        const id = `agent-start-mode-${agent}`;
        return (
          <div class="sp-preference">
            <div class="sp-preference-label">
              <label for={id}>{name}: keep its own start mode</label>
              <p id={`${id}-help`}>Off by default: new sessions start in the agent's normal approval mode, so Span asks before tools run even when the agent's own configuration starts in a mode such as Bypass permissions or Full access. For Claude, its ListAgents tool, which lists other Claude Code sessions on this computer, is also left out. On keeps whatever the agent's own configuration starts in. Saved in your user settings.</p>
              <span class="sp-setting-path">{`agents.startMode.${agent}`}</span>
            </div>
            <div class="sp-preference-control">
              <button id={id} class="sp-switch" role="switch" aria-label={`${name}: keep its own start mode`} aria-describedby={`${id}-help`} aria-checked={keeps(agent)} disabled={!props.onChange} onClick={() => toggle(agent)}>
                <span />
              </button>
            </div>
          </div>
        );
      }}
    </For>
  );
}
