//! Desktop glue for per-turn checkpoints (ADR 0013).
//!
//! Snapshots are taken around every prompt turn: at the start (before the
//! prompt is sent, bounded by a short timeout so a slow capture never holds a
//! prompt back) and at the end (after the turn completes, off the prompt's
//! path). Revert, restore and undo are Tauri commands only, so nothing an agent
//! can reach triggers them (ADR 0003: edit review stays with the user).
use crate::{events, git, DesktopState};
use serde::{Deserialize, Serialize};
use span_acp::SessionKey;
use span_core::{
    CancellationToken, CaptureOutcome, CheckpointChanges, CheckpointHunkRef, CheckpointPhase,
    CheckpointRestoreReport, CheckpointRevertReport, CheckpointStatus, CheckpointTurn, Checkpoints,
};
use specta::Type;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;
use tauri_specta::Event;

/// How long a prompt waits for its start snapshot before going out without one.
const START_TIMEOUT: Duration = Duration::from_millis(1500);
/// A start this soon after the previous turn's end reuses that snapshot.
const REUSE_WINDOW: Duration = Duration::from_secs(3);

/// Checkpoints of a session changed (a turn was captured, a restore ran).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointsChanged {
    pub session_id: String,
}

#[derive(Default)]
struct SessionCheckpoints {
    /// Serialises captures of one session so start and end land in order.
    lock: Arc<tokio::sync::Mutex<()>>,
    last_end: Option<(u32, Instant)>,
}

#[derive(Clone, Default)]
pub(crate) struct CheckpointState {
    sessions: Arc<Mutex<HashMap<String, SessionCheckpoints>>>,
    app: Arc<Mutex<Option<tauri::AppHandle>>>,
}

impl CheckpointState {
    pub(crate) fn set_app(&self, app: tauri::AppHandle) {
        if let Ok(mut slot) = self.app.lock() {
            *slot = Some(app);
        }
    }
    fn lock_for(&self, session: &str) -> Option<Arc<tokio::sync::Mutex<()>>> {
        let mut sessions = self.sessions.lock().ok()?;
        Some(sessions.entry(session.to_owned()).or_default().lock.clone())
    }
    fn last_end(&self, session: &str) -> Option<(u32, Instant)> {
        self.sessions.lock().ok()?.get(session)?.last_end
    }
    fn set_last_end(&self, session: &str, turn: u32) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.entry(session.to_owned()).or_default().last_end = Some((turn, Instant::now()));
        }
    }
    fn notify(&self, session: &str) {
        let app = self.app.lock().ok().and_then(|slot| slot.clone());
        if let Some(app) = app {
            events::emit(
                &app,
                &CheckpointsChanged {
                    session_id: session.to_owned(),
                },
            );
        }
    }
}

async fn checkpoints(state: &DesktopState) -> Result<Checkpoints, String> {
    let (_, service) = git::current_service(state).await?;
    Ok(Checkpoints::new(service))
}

/// Checkpoint opt-in is independent of Git UI consent. Only share the editor
/// mutation boundary, keeping checkpoint snapshots on their private index.
async fn mutate_checkpoint<T, F, Fut>(state: DesktopState, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(Checkpoints) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = span_core::Result<T>> + Send + 'static,
{
    let (workspace, service) = git::current_service(&state).await?;
    git::mutate_workspace(state, workspace, true, "checkpoint", move || async move {
        operation(Checkpoints::new(service))
            .await
            .map_err(|error| error.to_string())
    })
    .await
}

/// A turn in progress: what to finish with [`turn_ended`].
pub(crate) struct TurnCheckpoint {
    session: String,
    turn: u32,
}

/// Snapshot before a prompt goes out. Returns `None` ("no checkpoint") when
/// the folder is not a repository, the capture fails, or it takes longer
/// than [`START_TIMEOUT`]; the prompt proceeds either way.
pub(crate) async fn turn_started(state: &DesktopState, key: &SessionKey) -> Option<TurnCheckpoint> {
    let session = key.session_id.clone();
    let lock = state.checkpoints.lock_for(&session)?;
    let token = CancellationToken::default();
    let work = {
        let state = state.clone();
        let session = session.clone();
        let token = token.clone();
        async move {
            let _guard = lock.lock().await;
            let service = checkpoints(&state).await.ok()?;
            let turn = service.next_turn(&session, token.clone()).await.ok()?;
            if let Some((previous, at)) = state.checkpoints.last_end(&session) {
                if at.elapsed() < REUSE_WINDOW
                    && service
                        .alias(
                            &session,
                            turn,
                            CheckpointPhase::Start,
                            previous,
                            CheckpointPhase::End,
                            token.clone(),
                        )
                        .await
                        .unwrap_or(false)
                {
                    return Some(turn);
                }
            }
            match service
                .capture(&session, turn, CheckpointPhase::Start, token)
                .await
            {
                Ok(CaptureOutcome::Captured { .. }) => Some(turn),
                Ok(CaptureOutcome::Unavailable { .. }) => None,
                Err(error) => {
                    eprintln!("Checkpoint before the turn failed: {error}");
                    None
                }
            }
        }
    };
    match tokio::time::timeout(START_TIMEOUT, work).await {
        Ok(turn) => turn.map(|turn| TurnCheckpoint { session, turn }),
        Err(_) => {
            // A late snapshot could include the agent's first edits, so stop it.
            token.cancel();
            eprintln!("Checkpoint before the turn took too long; this turn has no checkpoint");
            None
        }
    }
}

/// Snapshot after the turn completed, in the background.
pub(crate) fn turn_ended(state: &DesktopState, checkpoint: TurnCheckpoint) {
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        let Some(lock) = state.checkpoints.lock_for(&checkpoint.session) else {
            return;
        };
        let _guard = lock.lock().await;
        let Ok(service) = checkpoints(&state).await else {
            return;
        };
        match service
            .capture(
                &checkpoint.session,
                checkpoint.turn,
                CheckpointPhase::End,
                CancellationToken::default(),
            )
            .await
        {
            Ok(CaptureOutcome::Captured { .. }) => {
                state
                    .checkpoints
                    .set_last_end(&checkpoint.session, checkpoint.turn);
            }
            Ok(CaptureOutcome::Unavailable { .. }) => {}
            Err(error) => eprintln!("Checkpoint after the turn failed: {error}"),
        }
        state.checkpoints.notify(&checkpoint.session);
    });
}

/// The prompt never went out (busy session): drop its start snapshot.
pub(crate) fn turn_refused(state: &DesktopState, checkpoint: TurnCheckpoint) {
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(service) = checkpoints(&state).await {
            let _ = service
                .forget(
                    &checkpoint.session,
                    checkpoint.turn,
                    CheckpointPhase::Start,
                    CancellationToken::default(),
                )
                .await;
        }
    });
}

/// The session was deleted: drop its checkpoint refs.
pub(crate) fn session_deleted(state: &DesktopState, session: &str) {
    let state = state.clone();
    let session = session.to_owned();
    tauri::async_runtime::spawn(async move {
        if let Ok(service) = checkpoints(&state).await {
            if let Err(error) = service
                .delete_session(&session, CancellationToken::default())
                .await
            {
                eprintln!("Could not remove checkpoints of a deleted session: {error}");
            }
        }
        if let Ok(mut sessions) = state.checkpoints.sessions.lock() {
            sessions.remove(&session);
        }
    });
}

/// Whether checkpoints work in the open folder, and why not.
#[tauri::command]
#[specta::specta]
pub async fn checkpoint_status(state: State<'_, DesktopState>) -> Result<CheckpointStatus, String> {
    let service = checkpoints(state.inner()).await?;
    Ok(service.status(CancellationToken::default()).await)
}

/// "Enable checkpoints": create a Git repository in the open folder. Only
/// ever run from this explicit user action.
#[tauri::command]
#[specta::specta]
pub async fn checkpoint_enable(state: State<'_, DesktopState>) -> Result<CheckpointStatus, String> {
    let (_, service) = git::current_service(state.inner()).await?;
    service
        .init_repository(CancellationToken::default())
        .await
        .map_err(|error| error.to_string())?;
    Ok(Checkpoints::new(service)
        .status(CancellationToken::default())
        .await)
}

/// The session's checkpointed turns, oldest first.
#[tauri::command]
#[specta::specta]
pub async fn checkpoint_list(
    state: State<'_, DesktopState>,
    session_id: String,
) -> Result<Vec<CheckpointTurn>, String> {
    checkpoints(state.inner())
        .await?
        .list(&session_id, CancellationToken::default())
        .await
        .map_err(|error| error.to_string())
}

/// Files and hunks one turn changed, or every turn of the session when `turn` is null.
#[tauri::command]
#[specta::specta]
pub async fn checkpoint_turn_changes(
    state: State<'_, DesktopState>,
    session_id: String,
    turn: Option<u32>,
) -> Result<CheckpointChanges, String> {
    checkpoints(state.inner())
        .await?
        .changes(&session_id, turn, CancellationToken::default())
        .await
        .map_err(|error| error.to_string())
}

/// Undo hunks of a change set on disk. Each hunk is refused, and reported,
/// when the file no longer holds the post-turn text around it.
#[tauri::command]
#[specta::specta]
pub async fn checkpoint_revert_hunks(
    state: State<'_, DesktopState>,
    session_id: String,
    revision: String,
    hunks: Vec<CheckpointHunkRef>,
) -> Result<CheckpointRevertReport, String> {
    let session = session_id.clone();
    let report = mutate_checkpoint(state.inner().clone(), move |service| async move {
        service
            .revert_hunks(&session, &revision, hunks, CancellationToken::default())
            .await
    })
    .await?;
    state.checkpoints.notify(&session_id);
    Ok(report)
}

/// Undo whole files of a change set; a file changed since is refused.
#[tauri::command]
#[specta::specta]
pub async fn checkpoint_revert_files(
    state: State<'_, DesktopState>,
    session_id: String,
    revision: String,
    paths: Vec<String>,
) -> Result<CheckpointRevertReport, String> {
    let session = session_id.clone();
    let report = mutate_checkpoint(state.inner().clone(), move |service| async move {
        service
            .revert_files(&session, &revision, paths, CancellationToken::default())
            .await
    })
    .await?;
    state.checkpoints.notify(&session_id);
    Ok(report)
}

/// Put the folder's files back to how they were before `turn`. The agent
/// conversation is not rolled back. A snapshot is taken first; pass the
/// returned `undoId` to `checkpoint_undo_restore`.
#[tauri::command]
#[specta::specta]
pub async fn checkpoint_restore(
    state: State<'_, DesktopState>,
    session_id: String,
    turn: u32,
) -> Result<CheckpointRestoreReport, String> {
    let session = session_id.clone();
    let report = mutate_checkpoint(state.inner().clone(), move |service| async move {
        service
            .restore(&session, turn, CancellationToken::default())
            .await
    })
    .await?;
    state.checkpoints.notify(&session_id);
    Ok(report)
}

/// Undo a restore or revert, leaving files changed since then as they are.
#[tauri::command]
#[specta::specta]
pub async fn checkpoint_undo_restore(
    state: State<'_, DesktopState>,
    session_id: String,
    undo_id: String,
) -> Result<CheckpointRestoreReport, String> {
    let session = session_id.clone();
    let report = mutate_checkpoint(state.inner().clone(), move |service| async move {
        service
            .undo_restore(&session, &undo_id, CancellationToken::default())
            .await
    })
    .await?;
    state.checkpoints.notify(&session_id);
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn turn_without_a_workspace_has_no_checkpoint_and_does_not_wait() {
        let state = DesktopState::default();
        let started = Instant::now();
        let checkpoint = turn_started(&state, &SessionKey::new("c", "s")).await;
        assert!(checkpoint.is_none());
        assert!(started.elapsed() < START_TIMEOUT);
    }

    #[test]
    fn agent_tools_cannot_reach_checkpoint_actions() {
        // ADR 0003: revert and restore are Tauri commands only. The span-agents
        // tool server must not grow a tool that reaches them.
        for source in [
            include_str!("../../../crates/acp/src/tools/mod.rs"),
            include_str!("../../../crates/acp/src/tools/server.rs"),
            include_str!("../../../crates/acp/src/tools/host.rs"),
            include_str!("../../../crates/acp/src/tools/tasks.rs"),
            include_str!("../../../crates/acp/src/tools/run_tools.rs"),
        ] {
            assert!(!source.contains("checkpoint"));
        }
    }
}
