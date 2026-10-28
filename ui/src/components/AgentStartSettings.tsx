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
