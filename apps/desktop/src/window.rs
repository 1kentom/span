//! Main window startup: timing reports from the frontend.
use serde::Deserialize;
use specta::Type;
use std::sync::OnceLock;
use std::time::Instant;

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

/// Records when the process started so startup reports can include the native side.
pub fn mark_process_start() {
    PROCESS_START.get_or_init(Instant::now);
}

fn since_process_start_ms() -> f64 {
    PROCESS_START
        .get()
        .map(|start| start.elapsed().as_secs_f64() * 1000.0)
        .unwrap_or_default()
}

/// Startup marks measured by the webview, in milliseconds since its navigation started.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StartupTimings {
    pub first_paint_ms: Option<f64>,
    pub entry_evaluated_ms: Option<f64>,
    pub shell_rendered_ms: Option<f64>,
    pub session_ready_ms: Option<f64>,
}

fn format_ms(value: Option<f64>) -> String {
    value.map_or_else(|| "n/a".to_owned(), |value| format!("{value:.0}ms"))
}

/// Logs the webview's startup marks next to the time since the process started.
#[tauri::command]
#[specta::specta]
pub fn report_startup_timings(timings: StartupTimings) {
    if cfg!(debug_assertions) {
        eprintln!(
            "startup: process {:.0}ms | webview: entry {} first-paint {} shell {} session-ready {}",
            since_process_start_ms(),
            format_ms(timings.entry_evaluated_ms),
            format_ms(timings.first_paint_ms),
            format_ms(timings.shell_rendered_ms),
            format_ms(timings.session_ready_ms),
        );
    }
}
