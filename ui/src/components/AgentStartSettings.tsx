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
