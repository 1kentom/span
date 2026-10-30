//! Native subagent sessions (ADR 0005, amendment of 2026-10-29). When an
//! agent runs its OWN subagent tool (OpenCode's `subagent`/`task`), the
//! child is a real session in the agent's store and `session/list` may list
//! it next to the user's chats. This is not Span's delegation (ADR 0003):
//! the agent owns these sessions, so Span never closes or deletes them; it
//! only marks them so History can hide them and nest them under the parent.
//!
//! What each agent sends, read from source (not run live):
//! - OpenCode 2.x (`packages/cli/src/acp/service.ts` `listSessions`) lists
//!   every session of the folder, children included (1.x passed
//!   `roots: true`). A list item carries no parent field and no `_meta`.
//!   The parent link reaches the client only inside the parent's own
//!   stream: projected child updates carry
//!   `_meta["opencode/child-session"] = {id, parentID, depth, title?}`
//!   (`child.ts`), and the `subagent` tool's result carries
//!   `rawOutput.metadata.sessionID` (`tool/plugin/subagent.ts`). The child's
//!   first user message starts with [`OPENCODE_SUBAGENT_PREAMBLE`].
//! - Codex (codex-acp 2.3.0 `SessionIndex.ts`) asks `thread/list` with
//!   `sourceKinds: []`, which leaves subagent threads out of the list.
//! - Claude (claude-agent-acp `listSessions`) lists the Agent SDK's top
//!   level transcripts; Task subagents are not separate list entries.
//!
//! Span records child ids (and the parent id when known) as it sees them,
//! in this process and in a small JSON ledger across runs. Ids only: no
//! prompt text is stored (ADR 0005). The listing marks recorded ids and,
//! for OpenCode, the exact title shapes the agent gives an untitled or a
//! 1.x child (see `adapter::opencode`).
use crate::health::push_capped;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, MutexGuard};

/// The first line OpenCode prepends to a subagent's first prompt, verbatim
/// from `packages/core/src/tool/plugin/subagent.ts` and
/// `packages/core/src/config/plugin/command.ts` (2.2.1).
pub const OPENCODE_SUBAGENT_PREAMBLE: &str = "You are a subagent spawned by another session.";

/// True when a user message starts with the OpenCode subagent preamble. Only
/// the exact sentence at the very start counts, so a chat that mentions
/// subagents, or quotes the sentence later, is never matched.
pub fn starts_with_subagent_preamble(text: &str) -> bool {
    text.trim_start().starts_with(OPENCODE_SUBAGENT_PREAMBLE)
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Entry {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent: Option<String>,
}

#[derive(Default)]
struct Registry {
    /// Child id to parent id (None when the parent is unknown).
    parents: HashMap<String, Option<String>>,
    /// Insertion order, for the capped ledger.
    order: Vec<String>,
    path: Option<PathBuf>,
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(Mutex::default);

fn registry() -> MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(|p| p.into_inner())
}

fn save(registry: &Registry) {
    let Some(path) = &registry.path else {
        return;
    };
    let entries: Vec<Entry> = registry
        .order
        .iter()
        .map(|id| Entry {
            id: id.clone(),
            parent: registry.parents.get(id).cloned().flatten(),
        })
        .collect();
    let Ok(bytes) = serde_json::to_vec_pretty(&entries) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let temporary = path.with_extension("json.tmp");
    if std::fs::write(&temporary, bytes).is_ok() {
        let _ = std::fs::rename(&temporary, path);
    }
}

/// Insert or improve one entry. Returns true when something changed.
fn insert(registry: &mut Registry, child: &str, parent: Option<&str>) -> bool {
    let parent = parent.filter(|p| !p.is_empty() && *p != child);
    match registry.parents.get_mut(child) {
        Some(known) if known.is_some() || parent.is_none() => false,
        Some(known) => {
            *known = parent.map(str::to_owned);
            true
        }
        None => {
            registry
                .parents
                .insert(child.to_owned(), parent.map(str::to_owned));
            push_capped(&mut registry.order, child);
            // Keep the map in step with the capped order.
            if registry.parents.len() > registry.order.len() {
                let kept: std::collections::HashSet<&String> = registry.order.iter().collect();
                registry.parents.retain(|id, _| kept.contains(id));
            }
            true
        }
    }
}

/// Remember native subagent ids across runs in the JSON file at `path`. The
/// ids already in it are marked at once. A missing or unreadable file starts
/// empty. Ids recorded before this call are kept.
pub fn set_native_subagent_ledger(path: PathBuf) {
    let loaded: Vec<Entry> = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let mut registry = registry();
    for entry in loaded {
        insert(&mut registry, &entry.id, entry.parent.as_deref());
    }
    registry.path = Some(path);
    save(&registry);
}

/// Record a native subagent session the agent reported, with its parent
/// session when the agent named it.
pub fn record_native_subagent(child: &str, parent: Option<&str>) {
    if child.is_empty() {
        return;
    }
    let mut registry = registry();
    if insert(&mut registry, child, parent) {
        save(&registry);
    }
}

/// `Some(parent)` for a recorded native subagent (the parent is `None` when
/// unknown), `None` for any other session.
pub fn native_subagent_parent(session_id: &str) -> Option<Option<String>> {
    registry().parents.get(session_id).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preamble_matches_only_at_the_start() {
        assert!(starts_with_subagent_preamble(
            "You are a subagent spawned by another session.\nCreate a PNG image"
        ));
        assert!(starts_with_subagent_preamble(
            "  You are a subagent spawned by another session.\nx"
        ));
        // Near misses stay ordinary chats.
        assert!(!starts_with_subagent_preamble(
            "Please explain: You are a subagent spawned by another session."
        ));
        assert!(!starts_with_subagent_preamble(
            "You are a subagent spawned by another session"
        ));
        assert!(!starts_with_subagent_preamble(
            "you are a subagent spawned by another session."
        ));
        assert!(!starts_with_subagent_preamble("You are a subagent"));
        assert!(!starts_with_subagent_preamble(
            "Spawn a subagent to review this"
        ));
    }

    #[test]
    fn records_a_child_and_learns_its_parent_later() {
        record_native_subagent("ses_unit_child", None);
        assert_eq!(native_subagent_parent("ses_unit_child"), Some(None));
        record_native_subagent("ses_unit_child", Some("ses_unit_parent"));
        assert_eq!(
            native_subagent_parent("ses_unit_child"),
            Some(Some("ses_unit_parent".into()))
        );
        // A known parent is never replaced by an unknown one.
        record_native_subagent("ses_unit_child", None);
        assert_eq!(
            native_subagent_parent("ses_unit_child"),
            Some(Some("ses_unit_parent".into()))
        );
        assert_eq!(native_subagent_parent("ses_unit_other"), None);
    }

    #[test]
    fn a_session_is_never_its_own_parent() {
        record_native_subagent("ses_unit_self", Some("ses_unit_self"));
        assert_eq!(native_subagent_parent("ses_unit_self"), Some(None));
    }

    #[test]
    fn the_ledger_round_trips_ids_only() {
        let dir = std::env::temp_dir().join(format!("span-native-ledger-{}", std::process::id()));
        let path = dir.join("agent-native-subagents.json");
        let _ = std::fs::remove_file(&path);
        record_native_subagent("ses_unit_ledger", Some("ses_unit_ledger_parent"));
        set_native_subagent_ledger(path.clone());
        let saved: Vec<Entry> = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(saved.contains(&Entry {
            id: "ses_unit_ledger".into(),
            parent: Some("ses_unit_ledger_parent".into())
        }));
        let text = String::from_utf8(std::fs::read(&path).unwrap()).unwrap();
        assert!(!text.contains(OPENCODE_SUBAGENT_PREAMBLE));
        registry().path = None;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
