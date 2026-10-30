/** Settings row for `agents.usage.importLocalLogs` (ADR 0012, source B). Saved to the user settings file only. */
export function UsageImportSettings(props: { enabled?: boolean; onChange?: (enabled: boolean) => void }) {
  const on = () => props.enabled ?? true;
  const id = "usage-import-local-logs";
  return (
    <div class="sp-preference">
      <div class="sp-preference-label">
        <label for={id}>Read usage from agents' local logs</label>
        <p id={`${id}-help`}>On by default. The Usage page also reads Claude Code's, Codex's (including compressed rollouts), Gemini CLI's and OpenCode's own usage logs in your home folder, OpenCode's opencode.db database included, so it shows sessions you ran outside Span. Span only reads them (a live database is read from a temporary copy, never opened for writing), keeps token counts, model and session ids and times (never your prompts or replies), and uploads nothing. While the Usage page is open it rescans every minute. Imported figures are labelled separately from what Span tracked itself. Saved in your user settings.</p>
        <span class="sp-setting-path">agents.usage.importLocalLogs</span>
      </div>
      <div class="sp-preference-control">
        <button id={id} class="sp-switch" role="switch" aria-label="Read usage from agents' local logs" aria-describedby={`${id}-help`} aria-checked={on()} disabled={!props.onChange} onClick={() => props.onChange?.(!on())}>
          <span />
        </button>
      </div>
    </div>
  );
}
