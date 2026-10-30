//! Session history metadata commands (ADR 0005). The store lives in
//! `span_core::SessionMetaStore`; these commands bind it to the active
//! workspace and run it on a blocking worker, never on the UI thread.
use crate::DesktopState;
use span_acp::{tools::DelegationEvent, AgentEvent, ConfigOption};
use span_core::{
    patch_for_model_selected, patch_for_turn_complete, patches_for_delegation, SessionMeta,
    SessionMetaPatch, SessionMetaStore, Transcript,
};
use tauri::State;

/// The canonical root of the active workspace, read without holding the
/// workspace lock during file IO.
fn active_root(state: &DesktopState) -> Result<Option<String>, String> {
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?
        .clone();
    let Some(workspace) = workspace else {
        return Ok(None);
    };
    let root = workspace
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?
        .workspace()
        .root;
    Ok(Some(root))
}

async fn with_store<T, F>(state: DesktopState, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&SessionMetaStore) -> span_core::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let root = active_root(&state)?
            .ok_or_else(|| "Open a folder to use session history".to_owned())?;
        let store = SessionMetaStore::for_workspace(&root).map_err(|error| error.to_string())?;
        operation(&store).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Session history task failed: {error}"))?
}

/// Every recorded session of the active workspace, most recently active first.
/// Empty when no folder is open.
#[tauri::command]
#[specta::specta]
pub async fn session_meta_list(state: State<'_, DesktopState>) -> Result<Vec<SessionMeta>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(root) = active_root(&state)? else {
            return Ok(vec![]);
        };
        SessionMetaStore::for_workspace(&root)
            .and_then(|store| store.list())
            .map(without_health_sessions)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Session history task failed: {error}"))?
}

/// Span's own health check sessions (ADR 0010) never get metadata entries.
fn refuse_health_session(session_id: &str) -> Result<(), String> {
    if span_acp::is_hidden_session(session_id, None) {
        return Err("Health check sessions have no history".into());
    }
    Ok(())
}

/// Drops entries of health check sessions an earlier version may have
/// stored, and of recorded delegated children (ADR 0003): a child is shown
/// inside its lead's thread, never as a History row of its own. An entry
/// with a `parent` link is kept here; the UI leaves it out of History rows.
fn without_health_sessions(metas: Vec<SessionMeta>) -> Vec<SessionMeta> {
    metas
        .into_iter()
        .filter(|meta| {
            !span_acp::is_hidden_session(&meta.session_id, None)
                && !span_acp::is_delegated_session(&meta.session_id)
        })
        .collect()
}

/// Merges `patch` into its session (created when missing) and returns the result.
#[tauri::command]
#[specta::specta]
pub async fn session_meta_update(
    state: State<'_, DesktopState>,
    patch: SessionMetaPatch,
) -> Result<SessionMeta, String> {
    refuse_health_session(&patch.session_id)?;
    with_store(state.inner().clone(), move |store| store.upsert(patch)).await
}

/// A null or blank title clears the user's title.
#[tauri::command]
#[specta::specta]
pub async fn session_meta_set_title(
    state: State<'_, DesktopState>,
    agent_id: String,
    session_id: String,
    title: Option<String>,
) -> Result<SessionMeta, String> {
    with_store(state.inner().clone(), move |store| {
        store.set_title(&agent_id, &session_id, title)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn session_meta_set_archived(
    state: State<'_, DesktopState>,
    agent_id: String,
    session_id: String,
    archived: bool,
) -> Result<SessionMeta, String> {
    with_store(state.inner().clone(), move |store| {
        store.set_archived(&agent_id, &session_id, archived)
    })
    .await
}

/// Forgets Span's metadata for a session. The agent's own session is untouched.
#[tauri::command]
#[specta::specta]
pub async fn session_meta_delete(
    state: State<'_, DesktopState>,
    agent_id: String,
    session_id: String,
) -> Result<bool, String> {
    with_store(state.inner().clone(), move |store| {
        store.delete(&agent_id, &session_id)
    })
    .await
}

/// Renders a transcript as Markdown with the workspace root shown as `.` and
/// the home directory as `~`. Works without an open folder.
#[tauri::command]
#[specta::specta]
pub async fn session_export_markdown(
    state: State<'_, DesktopState>,
    transcript: Transcript,
) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = active_root(&state)?;
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok();
        Ok(span_core::transcript_to_markdown(
            &transcript,
            root.as_deref(),
            home.as_deref(),
        ))
    })
    .await
    .map_err(|error| format!("Export task failed: {error}"))?
}

/// The patches an agent event implies for the store, for a future caller in
/// the session manager. `agent_id` is the stable id of the connection that
/// emitted the event. Pure: no IO.
pub fn patches_from_event(agent_id: &str, event: &AgentEvent) -> Vec<SessionMetaPatch> {
    match event {
        AgentEvent::Config {
            session_id,
            options,
        } => model_selection(options)
            .map(|(model, effort)| {
                vec![patch_for_model_selected(
                    agent_id,
                    session_id,
                    &model,
                    effort.as_deref(),
                )]
            })
            .unwrap_or_default(),
        AgentEvent::Complete {
            session_id,
            stop_reason,
            ..
        } => vec![patch_for_turn_complete(agent_id, session_id, stop_reason)],
        AgentEvent::Delegation {
            event:
                DelegationEvent::Delegated {
                    lead,
                    child,
                    agent_name,
                    ..
                },
        } => patches_for_delegation(
            agent_id,
            &lead.session_id,
            agent_name,
            agent_name,
            &child.session_id,
        )
        .into(),
        _ => vec![],
    }
}

/// The current model and effort from ACP session config options: the option
/// with category `model` (or id `model`), and the one with category
/// `thought_level` (or an id naming effort, reasoning or thought).
pub fn model_selection(options: &[ConfigOption]) -> Option<(String, Option<String>)> {
    let is = |option: &&ConfigOption, category: &str| option.category.as_deref() == Some(category);
    let model = options
        .iter()
        .find(|o| is(o, "model"))
        .or_else(|| options.iter().find(|o| o.id == "model"))?;
    let effort = options
        .iter()
        .find(|o| is(o, "thought_level"))
        .or_else(|| {
            options.iter().find(|o| {
                let id = o.id.to_ascii_lowercase();
                id.contains("effort") || id.contains("reasoning") || id.contains("thought")
            })
        })
        .map(|o| o.current_value.clone())
        .filter(|v| !v.trim().is_empty());
    let value = model.current_value.trim();
    (!value.is_empty()).then(|| (value.to_owned(), effort))
}

#[cfg(test)]
mod tests {
    use super::*;
    use span_acp::SessionKey;

    fn option(id: &str, category: Option<&str>, value: &str) -> ConfigOption {
        ConfigOption {
            id: id.into(),
            name: id.into(),
            description: None,
            category: category.map(str::to_owned),
            current_value: value.into(),
            groups: vec![],
        }
    }

    #[test]
    fn health_sessions_get_no_metadata_and_are_left_out_of_the_list() {
        span_acp::remember_hidden_sessions(["meta-health-1".to_owned()]);
        assert!(refuse_health_session("meta-health-1").is_err());
        assert!(refuse_health_session("meta-user-1").is_ok());
        let meta = |id: &str| SessionMeta {
            agent_id: "claude".into(),
            connection_name: "Claude".into(),
            session_id: id.into(),
            title_override: None,
            archived: false,
            first_seen_ms: 0,
            last_active_ms: 0,
            models: vec![],
            agents: vec![],
            files_changed: 0,
            lines_added: 0,
            lines_removed: 0,
            stop_reason_last: None,
            parent: None,
            continues: None,
            changes_tracked: false,
            usage: None,
            permission_mode: None,
        };
        span_acp::record_delegated_session("meta-worker", "meta-child-1");
        let kept = without_health_sessions(vec![
            meta("meta-health-1"),
            meta("meta-user-1"),
            meta("meta-child-1"),
        ]);
        let ids: Vec<&str> = kept.iter().map(|m| m.session_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["meta-user-1"],
            "health and delegated child left out"
        );
    }

    #[test]
    fn config_event_records_model_and_effort_without_a_turn() {
        let event = AgentEvent::Config {
            session_id: "s".into(),
            options: vec![
                option("mode", Some("mode"), "code"),
                option("model", Some("model"), "opus"),
                option("reasoning_effort", None, "high"),
            ],
        };
        let patches = patches_from_event("claude", &event);
        assert_eq!(patches.len(), 1);
        let model = &patches[0].models[0];
        assert_eq!(model.name, "opus");
        assert_eq!(model.effort.as_deref(), Some("high"));
        assert_eq!(model.turns, Some(0));
        let none = AgentEvent::Config {
            session_id: "s".into(),
            options: vec![option("mode", Some("mode"), "code")],
        };
        assert!(patches_from_event("claude", &none).is_empty());
    }

    #[test]
    fn complete_and_delegation_events_map_to_patches() {
        let complete = AgentEvent::Complete {
            session_id: "s".into(),
            stop_reason: "end_turn".into(),
            usage: None,
            meta: None,
            hint: None,
        };
        let patches = patches_from_event("claude", &complete);
        assert_eq!(patches[0].stop_reason_last.as_deref(), Some("end_turn"));

        let delegated = AgentEvent::Delegation {
            event: DelegationEvent::Delegated {
                lead: SessionKey::new("conn-1", "lead-s"),
                child: SessionKey::new("conn-2", "child-s"),
                task_id: "t".into(),
                agent_name: "Codex".into(),
                model: None,
                deliverables: None,
                group_id: None,
            },
        };
        let patches = patches_from_event("claude", &delegated);
        assert_eq!(patches.len(), 2);
        assert_eq!(patches[0].session_id, "lead-s");
        assert_eq!(patches[0].agents[0].role.as_deref(), Some("delegated"));
        assert_eq!(patches[1].session_id, "child-s");
        assert_eq!(
            patches[1].parent.as_ref().map(|p| p.agent_id.as_str()),
            Some("claude")
        );
        let log = AgentEvent::Log {
            direction: "in".into(),
            line: "x".into(),
        };
        assert!(patches_from_event("claude", &log).is_empty());
    }
}
