/** Settings row for `agents.usage.importLocalLogs` (ADR 0012, source B). Saved to the user settings file only. */
export function UsageImportSettings(props: { enabled?: boolean; onChange?: (enabled: boolean) => void }) {
  const on = () => props.enabled ?? false;
  const id = "usage-import-local-logs";
  return (
    <div class="sp-preference">
      <div class="sp-preference-label">
        <label for={id}>Import usage from agents' local logs</label>
        <p id={`${id}-help`}>Off by default. The Usage page also reads Claude Code's and Codex's own usage logs in your home folder, so it shows sessions you ran outside Span. Span only reads them, keeps token counts, model and session ids and times (never your prompts or replies), and uploads nothing. Imported figures are labelled separately from what Span tracked itself. Saved in your user settings.</p>
        <span class="sp-setting-path">agents.usage.importLocalLogs</span>
      </div>
      <div class="sp-preference-control">
        <button id={id} class="sp-switch" role="switch" aria-label="Import usage from agents' local logs" aria-describedby={`${id}-help`} aria-checked={on()} disabled={!props.onChange} onClick={() => props.onChange?.(!on())}>
          <span />
        </button>
      </div>
    </div>
  );
}
