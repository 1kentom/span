//! Usage page commands (ADR 0012). The ledger lives in `span_core::usage`
//! and the local log importers (on by default) in `span_core::usage_import`. Reading never
//! writes a session store; the importer writes only its own cache in the
//! profile folder.
use crate::DesktopState;
use serde::Serialize;
use span_core::{
    usage::{session_rows, summarize, PriceTable, SessionUsageRow, UsageRange, UsageSummary},
    usage_import::{
        claude_blocks, default_roots, imported_sessions, more_roots, scan_in, ImportCache,
        ImportLimits, ScanReport, UsageBlock,
    },
    AgentUsageSettings, CoreWorkspace, SessionMeta, SessionMetaStore, SettingsScope,
};
use specta::Type;
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;

/// Upper bound on workspace stores read for one request.
const MAX_STORES: usize = 512;

/// `agents.usage.*` from the user settings file only: the keys are user only.
fn usage_settings() -> AgentUsageSettings {
    CoreWorkspace::for_user_settings()
        .and_then(|user| user.get_settings_for_scope(SettingsScope::User))
        .map(|settings| settings.agents.usage)
        .unwrap_or_default()
}

fn prices(settings: &AgentUsageSettings) -> PriceTable {
    PriceTable::bundled().with_overrides(&settings.prices)
}

fn import_cache_path() -> Result<PathBuf, String> {
    let directory = SessionMetaStore::profile_directory().map_err(|error| error.to_string())?;
    let profile = directory
        .parent()
        .ok_or_else(|| "Cannot locate the profile folder".to_owned())?;
    Ok(profile.join("usage-import/cache.json"))
}

/// Every stored session with usage counters, health check sessions left
/// out, plus imported sessions when the user turned the importer on.
fn usage_sessions_for(
    settings: &AgentUsageSettings,
    range: &UsageRange,
) -> Result<Vec<SessionMeta>, String> {
    let directory = SessionMetaStore::profile_directory().map_err(|error| error.to_string())?;
    let mut sessions: Vec<SessionMeta> = SessionMetaStore::list_all_in(&directory, MAX_STORES)
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|meta| meta.usage.is_some())
        .filter(|meta| !span_acp::is_hidden_session(&meta.session_id, None))
        .collect();
    if settings.import_local_logs {
        let tracked: HashSet<String> = sessions.iter().map(|m| m.session_id.clone()).collect();
        let cache = ImportCache::load(&import_cache_path()?);
        sessions.extend(imported_sessions(
            &cache,
            range
                .utc_offset_minutes
                .unwrap_or(0)
                .clamp(-14 * 60, 14 * 60),
            &tracked,
        ));
    }
    Ok(sessions)
}

async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Usage task failed: {error}"))?
}

/// Totals by day, agent and model over every folder's sessions in `range`.
/// Works without an open folder.
#[tauri::command]
#[specta::specta]
pub async fn usage_summary(
    _state: State<'_, DesktopState>,
    range: UsageRange,
) -> Result<UsageSummary, String> {
    blocking(move || {
        let settings = usage_settings();
        let sessions = usage_sessions_for(&settings, &range)?;
        Ok(summarize(&sessions, &range, &prices(&settings)))
    })
    .await
}

/// Sessions with usage in `range`, most recently active first.
#[tauri::command]
#[specta::specta]
pub async fn usage_sessions(
    _state: State<'_, DesktopState>,
    range: UsageRange,
) -> Result<Vec<SessionUsageRow>, String> {
    blocking(move || {
        let settings = usage_settings();
        let sessions = usage_sessions_for(&settings, &range)?;
        Ok(session_rows(&sessions, &range, &prices(&settings)))
    })
    .await
}

/// The price table in use, with the user's overrides first.
#[tauri::command]
#[specta::specta]
pub async fn usage_prices(_state: State<'_, DesktopState>) -> Result<PriceTable, String> {
    blocking(|| Ok(prices(&usage_settings()))).await
}

/// The local log importer's state for the Usage page.
#[derive(Debug, Clone, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageImportStatus {
    /// `agents.usage.importLocalLogs` in the user settings.
    pub enabled: bool,
    pub running: bool,
    /// The running or last scan.
    pub report: Option<ScanReport>,
    /// Unix milliseconds of the last finished scan.
    pub scanned_ms: Option<u64>,
    pub error: Option<String>,
}

fn status() -> &'static Mutex<UsageImportStatus> {
    static STATUS: OnceLock<Mutex<UsageImportStatus>> = OnceLock::new();
    STATUS.get_or_init(|| Mutex::new(UsageImportStatus::default()))
}

fn snapshot() -> UsageImportStatus {
    status().lock().map(|s| s.clone()).unwrap_or_default()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// One full incremental scan of the agents' log folders into the cache.
fn run_scan() -> Result<(ScanReport, u64), String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let mut roots = default_roots(
        home.as_deref(),
        std::env::var("CLAUDE_CONFIG_DIR").ok().as_deref(),
        std::env::var("CODEX_HOME").ok().as_deref(),
    );
    roots.extend(more_roots(
        home.as_deref(),
        std::env::var("OPENCODE_DATA_DIR").ok().as_deref(),
        std::env::var("XDG_DATA_HOME").ok().as_deref(),
    ));
    let path = import_cache_path()?;
    let mut cache = ImportCache::load(&path);
    // A live OpenCode database is copied here for the read, then removed.
    let work = path
        .parent()
        .map(|dir| dir.join("tmp"))
        .ok_or_else(|| "Cannot locate the usage import folder".to_owned())?;
    let report = scan_in(
        &roots,
        &mut cache,
        &ImportLimits::default(),
        &work,
        &mut |report| {
            if let Ok(mut current) = status().lock() {
                current.report = Some(report.clone());
            }
        },
    );
    cache.scanned_ms = now_ms();
    cache.save(&path).map_err(|error| error.to_string())?;
    Ok((report, cache.scanned_ms))
}

/// Starts a background scan of the local logs when the importer is on (the
/// default) and no scan is running. Returns at once; poll
/// `usage_import_status` for progress.
#[tauri::command]
#[specta::specta]
pub async fn usage_import_scan(
    _state: State<'_, DesktopState>,
) -> Result<UsageImportStatus, String> {
    let enabled = blocking(|| Ok(usage_settings().import_local_logs)).await?;
    {
        let mut current = status()
            .lock()
            .map_err(|_| "Usage import state is unavailable")?;
        current.enabled = enabled;
        if !enabled || current.running {
            return Ok(current.clone());
        }
        current.running = true;
        current.error = None;
        current.report = Some(ScanReport::default());
    }
    tauri::async_runtime::spawn_blocking(|| {
        let outcome = run_scan();
        if let Ok(mut current) = status().lock() {
            current.running = false;
            match outcome {
                Ok((report, scanned)) => {
                    current.report = Some(report);
                    current.scanned_ms = Some(scanned);
                }
                Err(error) => current.error = Some(error),
            }
        }
    });
    Ok(snapshot())
}

/// The importer's state: whether it is on, a running scan's progress, and the
/// last scan's outcome.
#[tauri::command]
#[specta::specta]
pub async fn usage_import_status(
    _state: State<'_, DesktopState>,
) -> Result<UsageImportStatus, String> {
    let enabled = blocking(|| Ok(usage_settings().import_local_logs)).await?;
    let mut current = snapshot();
    current.enabled = enabled;
    if current.scanned_ms.is_none() && enabled {
        current.scanned_ms = blocking(|| Ok(ImportCache::load(&import_cache_path()?).scanned_ms))
            .await
            .ok()
            .filter(|ms| *ms > 0);
    }
    Ok(current)
}

/// Claude Code's five-hour usage blocks (ccusage rules) from its local logs,
/// oldest first, over the last `days` days (at most 90). Empty when the
/// importer is off.
#[tauri::command]
#[specta::specta]
pub async fn usage_blocks(
    _state: State<'_, DesktopState>,
    days: u32,
) -> Result<Vec<UsageBlock>, String> {
    blocking(move || {
        let settings = usage_settings();
        if !settings.import_local_logs {
            return Ok(vec![]);
        }
        let cache = ImportCache::load(&import_cache_path()?);
        let now = now_ms();
        let since = now.saturating_sub(u64::from(days.clamp(1, 90)) * 86_400_000);
        Ok(claude_blocks(&cache, &prices(&settings), now, since))
    })
    .await
}
