//! Main window startup. The window is created hidden (tauri.conf.json) and shown once the
//! frontend has rendered the restored session, with a timed failsafe if startup stalls.
use serde::{Deserialize, Serialize};
use specta::Type;
use std::io::Write;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{window::Color, Manager};

static PROCESS_START: OnceLock<(Instant, SystemTime)> = OnceLock::new();
static STARTUP_TRACE: OnceLock<StartupTrace> = OnceLock::new();

struct StartupTrace {
    enabled: bool,
    emitted: AtomicU8,
}

impl StartupTrace {
    fn new(value: Option<&std::ffi::OsStr>) -> Self {
        Self {
            enabled: value == Some(std::ffi::OsStr::new("1")),
            emitted: AtomicU8::new(0),
        }
    }

    fn claim(&self, event: TraceEvent) -> bool {
        self.enabled && self.emitted.fetch_or(event as u8, Ordering::Relaxed) & event as u8 == 0
    }
}

#[derive(Clone, Copy)]
#[repr(u8)]
enum TraceEvent {
    WindowCreated = 1,
    WindowShown = 2,
    WebviewStartup = 4,
}

impl TraceEvent {
    fn name(self) -> &'static str {
        match self {
            Self::WindowCreated => "window_created",
            Self::WindowShown => "window_shown",
            Self::WebviewStartup => "webview_startup",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TraceRecord {
    schema: &'static str,
    event: &'static str,
    process_elapsed_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    shown_by: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    webview: Option<WebviewTrace>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WebviewTrace {
    entry_evaluated_ms: Option<f64>,
    shell_rendered_ms: Option<f64>,
    session_ready_ms: Option<f64>,
    webview_paint_ms: Option<f64>,
    paint_status: &'static str,
    paint_source: &'static str,
    navigation_process_ms: Option<f64>,
    session_ready_process_ms: Option<f64>,
}

fn valid_ms(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && *value >= 0.0)
}

fn relative_ms(epoch_ms: f64, started_ms: f64, observed_ms: f64) -> Option<f64> {
    let relative = valid_ms(Some(epoch_ms))? - valid_ms(Some(started_ms))?;
    valid_ms(Some(relative)).filter(|value| *value <= observed_ms)
}

fn webview_trace(timings: &StartupTimings, observed_ms: f64) -> WebviewTrace {
    let navigation = timings
        .time_origin_ms
        .and_then(process_relative_ms)
        .filter(|value| *value <= observed_ms);
    let session = valid_ms(timings.session_ready_ms);
    let paint = valid_ms(timings.first_paint_ms);
    WebviewTrace {
        entry_evaluated_ms: valid_ms(timings.entry_evaluated_ms),
        shell_rendered_ms: valid_ms(timings.shell_rendered_ms),
        session_ready_ms: session,
        webview_paint_ms: paint,
        paint_status: if paint.is_some() {
            "reported"
        } else {
            "unavailable"
        },
        // The existing frontend IPC field can contain the FCP fallback. Do not imply FP identity.
        paint_source: "first-paint-or-first-contentful-paint",
        navigation_process_ms: navigation,
        session_ready_process_ms: navigation
            .zip(session)
            .and_then(|(navigation, session)| valid_ms(Some(navigation + session)))
            .filter(|value| *value <= observed_ms),
    }
}

fn trace_startup(
    event: TraceEvent,
    shown_by: Option<&'static str>,
    timings: Option<&StartupTimings>,
) {
    let Some(trace) = STARTUP_TRACE.get() else {
        return;
    };
    if !trace.claim(event) {
        return;
    }
    let elapsed = since_process_start_ms();
    let record = TraceRecord {
        schema: "span.startup.v1",
        event: event.name(),
        process_elapsed_ms: elapsed,
        shown_by,
        webview: timings.map(|timings| webview_trace(timings, elapsed)),
    };
    if let Ok(line) = serde_json::to_string(&record) {
        // Diagnostics must not change startup behavior if stderr is unavailable.
        let _ = writeln!(std::io::stderr().lock(), "{line}");
    }
}

/// Starts the Rust app-entry clock, excluding process creation and OS loader work.
pub fn mark_process_start() {
    PROCESS_START.get_or_init(|| (Instant::now(), SystemTime::now()));
    STARTUP_TRACE
        .get_or_init(|| StartupTrace::new(std::env::var_os("SPAN_STARTUP_TRACE").as_deref()));
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
    relative_ms(epoch_ms, started_ms, since_process_start_ms())
}

/// Records the existing setup hook after the main window and startup services exist.
pub fn log_window_created() {
    trace_startup(TraceEvent::WindowCreated, None, None);
    if cfg!(debug_assertions) {
        eprintln!(
            "startup: main window created at {:.0}ms",
            since_process_start_ms()
        );
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
    valid_ms(value).map_or_else(|| "n/a".to_owned(), |value| format!("{value:.0}ms"))
}

/// Logs the webview's startup marks next to the time since the process started.
#[tauri::command]
#[specta::specta]
pub fn report_startup_timings(timings: StartupTimings) {
    trace_startup(TraceEvent::WebviewStartup, None, Some(&timings));
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
pub fn show_main_window(
    window: tauri::WebviewWindow,
    theme: span_core::Theme,
) -> Result<(), String> {
    if let Err(error) = window.set_background_color(Some(canvas_color(theme))) {
        eprintln!("Could not set the window background: {error}");
    }
    reveal(&window, "frontend").map_err(|error| error.to_string())
}

fn reveal(window: &tauri::WebviewWindow, by: &'static str) -> tauri::Result<()> {
    if !window.is_visible()? {
        window.show()?;
        trace_startup(TraceEvent::WindowShown, Some(by), None);
        window.set_focus()?;
        if cfg!(debug_assertions) {
            eprintln!(
                "startup: window shown by {by} at {:.0}ms",
                since_process_start_ms()
            );
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
    use super::*;

    #[test]
    fn trace_opt_in_is_exact_and_each_event_is_bounded_once() {
        use std::ffi::OsStr;
        for value in [
            None,
            Some(OsStr::new("")),
            Some(OsStr::new("0")),
            Some(OsStr::new("true")),
            Some(OsStr::new(" 1")),
        ] {
            assert!(!StartupTrace::new(value).claim(TraceEvent::WindowCreated));
        }
        let trace = StartupTrace::new(Some(OsStr::new("1")));
        for event in [
            TraceEvent::WindowCreated,
            TraceEvent::WindowShown,
            TraceEvent::WebviewStartup,
        ] {
            assert!(trace.claim(event));
            assert!(!trace.claim(event));
        }
    }

    #[test]
    fn trace_choice_is_cached_for_the_process_lifetime() {
        let state = OnceLock::new();
        let initial = state.get_or_init(|| StartupTrace::new(None));
        assert!(!initial.enabled);
        let later = state.get_or_init(|| StartupTrace::new(Some(std::ffi::OsStr::new("1"))));
        assert!(!later.claim(TraceEvent::WebviewStartup));
    }

    #[test]
    fn invalid_timings_and_clock_offsets_are_unavailable() {
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0] {
            assert_eq!(valid_ms(Some(value)), None);
        }
        assert_eq!(valid_ms(Some(0.0)), Some(0.0));
        assert_eq!(relative_ms(1005.0, 1000.0, 10.0), Some(5.0));
        assert_eq!(relative_ms(995.0, 1000.0, 10.0), None);
        assert_eq!(relative_ms(1011.0, 1000.0, 10.0), None);
        assert_eq!(relative_ms(f64::MAX, 1000.0, 10.0), None);
        assert_eq!(relative_ms(f64::NAN, 1000.0, 10.0), None);
    }

    #[test]
    fn trace_schema_has_only_bounded_anonymous_metrics() {
        let timings = StartupTimings {
            first_paint_ms: None,
            entry_evaluated_ms: Some(-1.0),
            shell_rendered_ms: Some(f64::INFINITY),
            session_ready_ms: Some(40.0),
            time_origin_ms: Some(f64::MAX),
        };
        let record = TraceRecord {
            schema: "span.startup.v1",
            event: TraceEvent::WebviewStartup.name(),
            process_elapsed_ms: 50.0,
            shown_by: None,
            webview: Some(webview_trace(&timings, 50.0)),
        };
        let json = serde_json::to_value(record).unwrap();
        assert_eq!(json["schema"], "span.startup.v1");
        assert_eq!(json["webview"]["paintStatus"], "unavailable");
        assert!(json["webview"]["webviewPaintMs"].is_null());
        assert!(json["webview"]["entryEvaluatedMs"].is_null());
        assert!(json["webview"]["shellRenderedMs"].is_null());
        assert!(json["webview"]["navigationProcessMs"].is_null());
        assert_eq!(json["webview"]["sessionReadyMs"], 40.0);
        assert!(!json.to_string().contains("timeOrigin"));
        assert!(!json.to_string().contains("shownBy"));
    }

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
