//! Usage page commands (ADR 0012). The ledger lives in `span_core::usage`;
//! these commands read every workspace's session metadata store on a
//! blocking worker and never write anything.
use crate::DesktopState;
use span_core::{
    usage::{session_rows, summarize, PriceTable, SessionUsageRow, UsageRange, UsageSummary},
    CoreWorkspace, SessionMeta, SessionMetaStore, SettingsScope,
};
use tauri::State;

/// Upper bound on workspace stores read for one request.
const MAX_STORES: usize = 512;

/// The bundled price table with the user's own `agents.usage.prices`. Only
/// the user settings file is read: the key is user only (ADR 0012).
fn prices() -> PriceTable {
    let overrides = CoreWorkspace::for_user_settings()
        .and_then(|user| user.get_settings_for_scope(SettingsScope::User))
        .map(|settings| settings.agents.usage.prices)
        .unwrap_or_default();
    PriceTable::bundled().with_overrides(&overrides)
}

/// Every stored session with usage counters, health check sessions left out.
fn tracked_sessions() -> Result<Vec<SessionMeta>, String> {
    let directory = SessionMetaStore::profile_directory().map_err(|error| error.to_string())?;
    let sessions =
        SessionMetaStore::list_all_in(&directory, MAX_STORES).map_err(|error| error.to_string())?;
    Ok(sessions
        .into_iter()
        .filter(|meta| meta.usage.is_some())
        .filter(|meta| !span_acp::is_hidden_session(&meta.session_id, None))
        .collect())
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
    blocking(move || Ok(summarize(&tracked_sessions()?, &range, &prices()))).await
}

/// Sessions with usage in `range`, most recently active first.
#[tauri::command]
#[specta::specta]
pub async fn usage_sessions(
    _state: State<'_, DesktopState>,
    range: UsageRange,
) -> Result<Vec<SessionUsageRow>, String> {
    blocking(move || Ok(session_rows(&tracked_sessions()?, &range, &prices()))).await
}

/// The price table in use, with the user's overrides first.
#[tauri::command]
#[specta::specta]
pub async fn usage_prices(_state: State<'_, DesktopState>) -> Result<PriceTable, String> {
    blocking(|| Ok(prices())).await
}
