//! Main window startup. The window is created hidden (tauri.conf.json) and shown once the
//! frontend has rendered the restored session, so no blank native frame is ever on screen.
use serde::Deserialize;
use specta::Type;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{window::Color, Manager};

static PROCESS_START: OnceLock<(Instant, SystemTime)> = OnceLock::new();

/// Records when the process started so startup reports can include the native side.
pub fn mark_process_start() {
    PROCESS_START.get_or_init(|| (Instant::now(), SystemTime::now()));
}

fn since_process_start_ms() -> f64 {
    PROCESS_START
        .get()
        .map(|(start, _)| start.elapsed().as_secs_f64() * 1000.0)
        .unwrap_or_default()
}

/// Milliseconds from process start to a wall clock time in milliseconds since the Unix epoch.
fn process_relative_ms(epoch_ms: f64) -> Option<f64> {
    let (_, started) = PROCESS_START.get()?;
    let started_ms = started.duration_since(UNIX_EPOCH).ok()?.as_secs_f64() * 1000.0;
    Some(epoch_ms - started_ms)
}

/// Logs when the main window exists (it was visible from here when created visible).
pub fn log_window_created() {
    if cfg!(debug_assertions) {
        eprintln!("startup: main window created at {:.0}ms", since_process_start_ms());
    }
}

/// Startup marks measured by the webview, in milliseconds since its navigation started.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StartupTimings {
    pub first_paint_ms: Option<f64>,
    pub entry_evaluated_ms: Option<f64>,
    pub shell_rendered_ms: Option<f64>,
    pub session_ready_ms: Option<f64>,
    /// `performance.timeOrigin`: when the webview navigation started, in Unix epoch milliseconds.
    pub time_origin_ms: Option<f64>,
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
        if let Some(navigation) = timings.time_origin_ms.and_then(process_relative_ms) {
            let at = |mark: Option<f64>| format_ms(mark.map(|value| navigation + value));
            eprintln!(
                "startup: since process start: navigation {navigation:.0}ms first-paint {} session-ready {}",
                at(timings.first_paint_ms),
                at(timings.session_ready_ms),
            );
        }
    }
}

/// The `--canvas` colour of each theme in ui/src/styles/workbench.css.
pub fn canvas_color(theme: span_core::Theme) -> Color {
    match theme {
        span_core::Theme::Dark => Color(9, 9, 9, 255),
        span_core::Theme::Light => Color(238, 239, 240, 255),
        span_core::Theme::Purple => Color(8, 8, 16, 255),
    }
}

/// Called by the frontend once the restored session has rendered: match the native background
/// to the theme (it shows during resizes and before the webview paints), then show the window.
#[tauri::command]
#[specta::specta]
pub fn show_main_window(window: tauri::WebviewWindow, theme: span_core::Theme) -> Result<(), String> {
    if let Err(error) = window.set_background_color(Some(canvas_color(theme))) {
        eprintln!("Could not set the window background: {error}");
    }
    reveal(&window, "frontend").map_err(|error| error.to_string())
}

fn reveal(window: &tauri::WebviewWindow, by: &str) -> tauri::Result<()> {
    if !window.is_visible()? {
        window.show()?;
        window.set_focus()?;
        if cfg!(debug_assertions) {
            eprintln!("startup: window shown by {by} at {:.0}ms", since_process_start_ms());
        }
    }
    Ok(())
}

/// Shows the main window after `delay` if the frontend never asked for it (a script error, or a
/// very slow first load), so a hidden window can never leave the app looking dead.
pub fn show_if_still_hidden(app: &tauri::AppHandle, delay: Duration) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        if let Some(window) = app.get_webview_window("main") {
            if let Err(error) = reveal(&window, "failsafe") {
                eprintln!("Could not show the main window: {error}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn canvas_colours_match_the_workbench_tokens() {
        use span_core::Theme;
        let hex = |theme| {
            let tauri::window::Color(r, g, b, a) = super::canvas_color(theme);
            assert_eq!(a, 255);
            format!("#{r:02x}{g:02x}{b:02x}")
        };
        assert_eq!(hex(Theme::Dark), "#090909");
        assert_eq!(hex(Theme::Light), "#eeeff0");
        assert_eq!(hex(Theme::Purple), "#080810");
    }
}
