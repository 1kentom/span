//! Thread links, subagent model uses and change tracking in the session
//! metadata store (ADR 0005, sections 1 and 5).
use span_core::{
    patch_for_turn_start, ModelUsePatch, SessionLink, SessionMetaPatch, SessionMetaStore,
};

fn store(dir: &tempfile::TempDir) -> SessionMetaStore {
    SessionMetaStore::in_directory(dir.path(), "/work/project")
}

fn link(agent: &str, session: &str, title: Option<&str>) -> SessionLink {
    SessionLink {
        agent_id: agent.into(),
        session_id: session.into(),
        title: title.map(str::to_owned),
    }
}

#[test]
fn a_switched_session_links_to_the_segment_it_continues() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    store
        .upsert_at(
            patch_for_turn_start("codex", "s1", Some("Codex"), Some("gpt-5"), None),
            10,
        )
        .unwrap();
    let mut patch = SessionMetaPatch::new("claude-acp", "s2");
    patch.connection_name = Some("Claude Agent".into());
    patch.continues = Some(link("codex", "s1", Some("  Ship path filtering  ")));
    let meta = store.upsert_at(patch, 20).unwrap();
    assert_eq!(
        meta.continues,
        Some(link("codex", "s1", Some("Ship path filtering"))),
        "the link title is trimmed"
    );
    // A later patch without a link keeps it.
    store
        .upsert_at(SessionMetaPatch::new("claude-acp", "s2"), 30)
        .unwrap();
    let kept = store.get("claude-acp", "s2").unwrap().unwrap();
    assert_eq!(kept.continues.unwrap().session_id, "s1");
    // The earlier segment is untouched.
    assert!(store
        .get("codex", "s1")
        .unwrap()
        .unwrap()
        .continues
        .is_none());
}

#[test]
fn a_link_to_itself_or_with_bad_ids_is_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    let mut own = SessionMetaPatch::new("a", "s");
    own.continues = Some(link("a", "s", None));
    assert!(store.upsert_at(own, 1).unwrap().continues.is_none());
    let mut empty = SessionMetaPatch::new("a", "s");
    empty.continues = Some(link("", "s0", None));
    assert!(store.upsert_at(empty, 2).unwrap().continues.is_none());
    let mut blank_title = SessionMetaPatch::new("a", "s");
    blank_title.continues = Some(link("b", "s0", Some("   ")));
    assert_eq!(
        store.upsert_at(blank_title, 3).unwrap().continues,
        Some(link("b", "s0", None))
    );
}

#[test]
fn subagent_model_uses_are_kept_apart_from_the_lead_model() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    store
        .upsert_at(
            patch_for_turn_start("a", "s", None, Some("Sonnet 4.5"), None),
            10,
        )
        .unwrap();
    let mut child = SessionMetaPatch::new("a", "s");
    child.models.push(ModelUsePatch {
        name: "Sonnet 4.5".into(),
        effort: None,
        turns: Some(0),
        subagent: Some(true),
    });
    store.upsert_at(child.clone(), 20).unwrap();
    store.upsert_at(child, 30).unwrap();
    let meta = store.get("a", "s").unwrap().unwrap();
    assert_eq!(
        meta.models.len(),
        2,
        "same name, one lead and one subagent use"
    );
    let lead = meta.models.iter().find(|m| !m.subagent).unwrap();
    let sub = meta.models.iter().find(|m| m.subagent).unwrap();
    assert_eq!((lead.turns, sub.turns), (1, 0));
}

#[test]
fn changes_tracked_is_set_by_the_latest_patch() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    let mut tracked = SessionMetaPatch::new("a", "s");
    tracked.changes_tracked = Some(true);
    assert!(store.upsert_at(tracked, 1).unwrap().changes_tracked);
    assert!(
        store
            .upsert_at(SessionMetaPatch::new("a", "s"), 2)
            .unwrap()
            .changes_tracked,
        "absent keeps the stored value"
    );
    let mut untracked = SessionMetaPatch::new("a", "s");
    untracked.changes_tracked = Some(false);
    assert!(!store.upsert_at(untracked, 3).unwrap().changes_tracked);
}

#[test]
fn a_file_written_before_these_fields_existed_still_loads() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir);
    std::fs::create_dir_all(store.path().parent().unwrap()).unwrap();
    let old = r#"{"version":1,"sessions":[{"agentId":"a","connectionName":"A","sessionId":"s","titleOverride":null,"archived":false,"firstSeenMs":1,"lastActiveMs":2,"models":[{"name":"m","effort":null,"usedMs":2,"turns":1}],"agents":[],"filesChanged":0,"linesAdded":0,"linesRemoved":0,"stopReasonLast":null,"parent":null}]}"#;
    std::fs::write(store.path(), old).unwrap();
    let meta = store.get("a", "s").unwrap().unwrap();
    assert!(meta.continues.is_none());
    assert!(!meta.changes_tracked);
    assert!(!meta.models[0].subagent);
    assert!(
        !store.path().with_extension("json.corrupt").exists(),
        "not treated as corrupt"
    );
}
