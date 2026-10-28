use span_core::{
    CancellationToken, CoreError, CoreWorkspace, SearchQuery, Settings, TextEdit, Theme,
};
use std::fs;
use tempfile::tempdir;

fn edit(from: u32, to: u32, insert: &str) -> TextEdit {
    TextEdit {
        from,
        to,
        insert: insert.into(),
    }
}

#[test]
fn utf16_edits_are_atomic_and_revisions_reject_stale_transactions() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("emoji.ts"), "a😀b\n").unwrap();
    let mut core = CoreWorkspace::open(dir.path()).unwrap();
    let initial = core.open_buffer("emoji.ts").unwrap();
    assert_eq!(initial.language, "typescript");
    assert!(matches!(
        core.edit_buffer("emoji.ts", 0, vec![edit(2, 3, "x")]),
        Err(CoreError::InvalidEdit(_))
    ));
    assert_eq!(core.agent_read("emoji.ts").unwrap().text, "a😀b\n");
    let changed = core
        .edit_buffer("emoji.ts", 0, vec![edit(1, 3, "😎")])
        .unwrap();
    assert_eq!(changed.text, "a😎b\n");
    assert_eq!(changed.revision, 1);
    assert_eq!(changed.saved_revision, 0);
    assert!(matches!(
        core.edit_buffer("emoji.ts", 0, vec![edit(0, 1, "x")]),
        Err(CoreError::StaleRevision { .. })
    ));
    assert!(core
        .edit_buffer("emoji.ts", 1, vec![edit(0, 1, "x"), edit(99, 100, "y")])
        .is_err());
    assert_eq!(core.agent_read("emoji.ts").unwrap().text, "a😎b\n");
    // UI-owned undo and redo submit inverse transactions, preserving monotonically increasing revisions.
    assert_eq!(
        core.edit_buffer("emoji.ts", 1, vec![edit(1, 3, "😀")])
            .unwrap()
            .revision,
        2
    );
    assert_eq!(
        core.edit_buffer("emoji.ts", 2, vec![edit(1, 3, "😎")])
            .unwrap()
            .revision,
        3
    );
}

#[test]
fn proposals_read_unsaved_content_reject_without_mutation_and_guard_stale_accepts() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("a.rs"), "saved").unwrap();
    let mut core = CoreWorkspace::open(dir.path()).unwrap();
    core.open_buffer("a.rs").unwrap();
    core.edit_buffer("a.rs", 0, vec![edit(0, 5, "unsaved")])
        .unwrap();
    assert_eq!(core.agent_read("a.rs").unwrap().text, "unsaved");
    let proposal = core.stage_proposal("a.rs", 1, "agent".into()).unwrap();
    assert_eq!(proposal.hunks[0].before, "unsaved");
    assert_eq!(core.agent_read("a.rs").unwrap().text, "unsaved");
    core.resolve_proposal(&proposal.id, false, 1).unwrap();
    assert_eq!(core.agent_read("a.rs").unwrap().text, "unsaved");
    assert_eq!(
        fs::read_to_string(dir.path().join("a.rs")).unwrap(),
        "saved"
    );
    let stale = core.stage_proposal("a.rs", 1, "agent".into()).unwrap();
    core.edit_buffer("a.rs", 1, vec![edit(0, 0, "user ")])
        .unwrap();
    assert!(matches!(
        core.resolve_proposal(&stale.id, true, 2),
        Err(CoreError::StaleRevision { .. })
    ));
    core.resolve_proposal(&stale.id, false, 2).unwrap();
    let proposal = core.stage_proposal("a.rs", 2, "accepted".into()).unwrap();
    let accepted = core.resolve_proposal(&proposal.id, true, 2).unwrap();
    assert_eq!(accepted.text, "accepted");
    assert_ne!(accepted.revision, accepted.saved_revision);
    core.save_buffer("a.rs", accepted.revision).unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("a.rs")).unwrap(),
        "accepted"
    );
}

#[test]
fn save_rejects_external_modification_and_handles_new_files() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("a.txt");
    fs::write(&file, "initial").unwrap();
    let mut core = CoreWorkspace::open(dir.path()).unwrap();
    core.open_buffer("a.txt").unwrap();
    core.edit_buffer("a.txt", 0, vec![edit(0, 7, "mine")])
        .unwrap();
    fs::write(&file, "external").unwrap();
    assert!(matches!(
        core.save_buffer("a.txt", 1),
        Err(CoreError::SaveConflict(_))
    ));
    assert_eq!(fs::read_to_string(&file).unwrap(), "external");
    assert_eq!(core.agent_read("a.txt").unwrap().text, "mine");
    core.open_buffer("new.txt").unwrap();
    core.edit_buffer("new.txt", 0, vec![edit(0, 0, "created")])
        .unwrap();
    let saved = core.save_buffer("new.txt", 1).unwrap();
    assert_eq!(saved.saved_revision, saved.revision);
    assert_eq!(
        fs::read_to_string(dir.path().join("new.txt")).unwrap(),
        "created"
    );
}

#[test]
fn sandbox_blocks_parent_and_absolute_escape() {
    let dir = tempdir().unwrap();
    let other = tempdir().unwrap();
    fs::write(other.path().join("private.txt"), "secret").unwrap();
    let mut core = CoreWorkspace::open(dir.path()).unwrap();
    assert!(matches!(
        core.open_buffer("../private.txt"),
        Err(CoreError::OutsideWorkspace(_))
    ));
    assert!(matches!(
        core.open_buffer(&other.path().join("private.txt").to_string_lossy()),
        Err(CoreError::OutsideWorkspace(_))
    ));
}

#[cfg(unix)]
#[test]
fn sandbox_blocks_symlinks_for_read_write_walk_and_settings() {
    use std::os::unix::fs::symlink;
    let dir = tempdir().unwrap();
    let other = tempdir().unwrap();
    fs::write(other.path().join("private.txt"), "secret").unwrap();
    symlink(other.path(), dir.path().join("escape")).unwrap();
    symlink(other.path(), dir.path().join(".span")).unwrap();
    let mut core = CoreWorkspace::open(dir.path()).unwrap();
    assert!(matches!(
        core.agent_read("escape/private.txt"),
        Err(CoreError::OutsideWorkspace(_))
    ));
    assert!(matches!(
        core.open_buffer("escape/new.txt"),
        Err(CoreError::OutsideWorkspace(_))
    ));
    assert!(!core
        .list_files()
        .unwrap()
        .iter()
        .any(|f| f.path.starts_with("escape")));
    assert!(matches!(
        core.update_settings(Settings::default()),
        Err(CoreError::OutsideWorkspace(_))
    ));
}

#[test]
fn search_and_tree_respect_ignores_and_stream_before_finishing() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join(".gitignore"), "ignored/\n").unwrap();
    fs::create_dir(dir.path().join("ignored")).unwrap();
    fs::write(dir.path().join("ignored/no.txt"), "needle").unwrap();
    fs::write(dir.path().join("a.txt"), "😀 needle\nneedle two\n").unwrap();
    let mut core = CoreWorkspace::open(dir.path()).unwrap();
    assert!(!core
        .list_files()
        .unwrap()
        .iter()
        .any(|f| f.path.starts_with("ignored")));
    assert!(!core
        .list_directory("")
        .unwrap()
        .iter()
        .any(|f| f.name == "ignored"));
    let query = SearchQuery {
        text: "needle".into(),
        ..Default::default()
    };
    let found = core.search(query.clone()).unwrap();
    assert_eq!(found.len(), 2);
    assert_eq!(found[0].column, 4);
    let cancel = CancellationToken::default();
    let total = core
        .search_stream(query.clone(), &cancel, |_| {
            cancel.cancel();
            true
        })
        .unwrap();
    assert_eq!(total, 1);
    core.open_buffer("a.txt").unwrap();
    core.edit_buffer("a.txt", 0, vec![edit(0, 0, "unsaved ")])
        .unwrap();
    let unsaved = core
        .search(SearchQuery {
            text: "unsaved".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(unsaved.len(), 1);
    assert_eq!(
        core.search_stream(query, &CancellationToken::default(), |_| false)
            .unwrap(),
        1
    );
    assert!(core
        .search(SearchQuery {
            text: "[".into(),
            is_regex: true,
            ..Default::default()
        })
        .is_err());
}

#[test]
fn jsonc_user_workspace_settings_merge_validate_and_persist() {
    let dir = tempdir().unwrap();
    let user_dir = tempdir().unwrap();
    let user = user_dir.path().join("settings.jsonc");
    fs::write(
        &user,
        "{ // font\n\"fontSize\": 15, \"theme\": \"Light\", }",
    )
    .unwrap();
    fs::create_dir(dir.path().join(".span")).unwrap();
    fs::write(
        dir.path().join(".span/settings.jsonc"),
        "{ /* override */ \"theme\": \"Purple\", }",
    )
    .unwrap();
    let core = CoreWorkspace::open(dir.path())
        .unwrap()
        .with_user_settings(Some(user));
    let settings = core.get_settings().unwrap();
    assert_eq!(settings.theme, Theme::Purple);
    assert_eq!(settings.font_size, 15);
    assert_eq!(settings.tab_size, 2);
    core.update_settings(Settings {
        theme: Theme::Dark,
        ..settings
    })
    .unwrap();
    assert_eq!(core.get_settings().unwrap().theme, Theme::Dark);
    assert!(core
        .update_settings(Settings {
            tab_size: 0,
            ..Default::default()
        })
        .is_err());
    fs::write(dir.path().join(".span/settings.jsonc"), "{ /* unclosed").unwrap();
    assert!(core.get_settings().is_err());
}

#[test]
fn discard_restores_disk_and_invalidates_inflight_edits() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("a.txt"), "disk").unwrap();
    let mut core = CoreWorkspace::open(dir.path()).unwrap();
    core.open_buffer("a.txt").unwrap();
    let updated = core
        .edit_buffer_delta("a.txt", 0, vec![edit(0, 4, "dirty")])
        .unwrap();
    assert_eq!(updated.revision, 1);
    assert_eq!(core.agent_read("a.txt").unwrap().text, "dirty");
    let restored = core.discard_buffer("a.txt").unwrap();
    assert_eq!(restored.text, "disk");
    assert_eq!(restored.revision, 2);
    assert_eq!(restored.saved_revision, 2);
    assert!(matches!(
        core.edit_buffer_delta("a.txt", 1, vec![edit(0, 0, "stale")]),
        Err(CoreError::StaleRevision { .. })
    ));
}

#[test]
fn search_reads_new_unsaved_buffers() {
    let dir = tempdir().unwrap();
    let mut core = CoreWorkspace::open(dir.path()).unwrap();
    core.open_buffer("new.txt").unwrap();
    core.edit_buffer_delta("new.txt", 0, vec![edit(0, 0, "new unsaved content")])
        .unwrap();
    let found = core
        .search(SearchQuery {
            text: "unsaved".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].path, "new.txt");
}

#[test]
fn jsonc_updates_preserve_comments_and_validate_before_writing() {
    let dir = tempdir().unwrap();
    let core = CoreWorkspace::open(dir.path())
        .unwrap()
        .with_user_settings(None);
    let original = "{ // personal preference\n\"theme\": \"Light\", }\n";
    assert_eq!(
        core.update_settings_jsonc(original).unwrap().theme,
        Theme::Light
    );
    let path = dir.path().join(".span/settings.jsonc");
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    assert!(core.update_settings_jsonc("{\"fontSize\": 1}").is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), original);
}

#[test]
fn bounded_snapshots_reject_large_document_before_materializing() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("a.ts"), "let value = 1;").unwrap();
    let mut core = CoreWorkspace::open(dir.path()).unwrap();
    core.open_buffer("a.ts").unwrap();
    assert!(matches!(
        core.buffer_snapshot_bounded("a.ts", 2),
        Err(CoreError::InvalidEdit(_))
    ));
    assert_eq!(
        core.buffer_snapshot_bounded("a.ts", 100).unwrap().text,
        "let value = 1;"
    );
}

#[test]
fn proposal_hunk_selection_accepts_only_selected_changes() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("a.txt"), "one two three").unwrap();
    let mut core = CoreWorkspace::open(dir.path()).unwrap();
    let proposal = core
        .stage_edit_proposal("a.txt", 0, vec![edit(0, 3, "ONE"), edit(8, 13, "THREE")])
        .unwrap();
    assert!(core
        .resolve_proposal_hunks(&proposal.id, &["missing".into()], 0)
        .is_err());
    assert_eq!(core.agent_read("a.txt").unwrap().text, "one two three");
    let result = core
        .resolve_proposal_hunks(&proposal.id, &[proposal.hunks[1].id.clone()], 0)
        .unwrap();
    assert_eq!(result.text, "one two THREE");
    assert_eq!(result.revision, 1);
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "one two three"
    );
}

#[test]
fn search_snapshot_keeps_start_state_while_editor_continues() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("a.txt"), "disk").unwrap();
    let mut core = CoreWorkspace::open(dir.path()).unwrap();
    core.open_buffer("a.txt").unwrap();
    core.edit_buffer_delta("a.txt", 0, vec![edit(0, 4, "search start")])
        .unwrap();
    let search = core.search_snapshot();
    core.edit_buffer_delta("a.txt", 1, vec![edit(0, 12, "later edit")])
        .unwrap();
    let query = SearchQuery {
        text: "search start".into(),
        ..Default::default()
    };
    assert_eq!(search.search(query.clone()).unwrap().len(), 1);
    assert!(core.search(query).unwrap().is_empty());
    assert_eq!(core.agent_read("a.txt").unwrap().text, "later edit");
}

#[test]
fn rejecting_stale_proposal_always_unblocks_review_without_mutation() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("a.txt"), "original").unwrap();
    let mut core = CoreWorkspace::open(dir.path()).unwrap();
    let proposal = core.stage_proposal("a.txt", 0, "agent".into()).unwrap();
    core.edit_buffer_delta("a.txt", 0, vec![edit(0, 8, "user typed")])
        .unwrap();
    let rejected = core.resolve_proposal(&proposal.id, false, 0).unwrap();
    assert_eq!(rejected.text, "user typed");
    assert_eq!(rejected.revision, 1);
    assert!(matches!(
        core.resolve_proposal(&proposal.id, true, 1),
        Err(CoreError::UnknownProposal(_))
    ));
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "original"
    );
}

#[test]
fn full_file_proposal_separates_changes_and_partial_accept_preserves_rejected_lines() {
    let dir = tempdir().unwrap();
    let original = "first old\nkeep one\nkeep two\nlast old\n";
    fs::write(dir.path().join("a.txt"), original).unwrap();
    let mut core = CoreWorkspace::open(dir.path()).unwrap();
    let proposal = core
        .stage_proposal(
            "a.txt",
            0,
            "first new\nkeep one\nkeep two\nlast new\n".into(),
        )
        .unwrap();
    assert_eq!(proposal.hunks.len(), 2);
    assert_eq!(proposal.hunks[0].from, 0);
    assert_eq!(proposal.hunks[0].to, 10);
    assert_eq!(proposal.hunks[0].before, "first old\n");
    assert_eq!(proposal.hunks[0].after, "first new\n");
    assert_eq!(proposal.hunks[1].from, 28);
    let accepted = core
        .resolve_proposal_hunks(&proposal.id, &[proposal.hunks[1].id.clone()], 0)
        .unwrap();
    assert_eq!(accepted.text, "first old\nkeep one\nkeep two\nlast new\n");
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        original
    );
}

#[test]
fn full_file_hunks_preserve_unicode_crlf_and_missing_final_newline() {
    let dir = tempdir().unwrap();
    let original = "😀 old\r\nunchanged\r\n尾 old";
    fs::write(dir.path().join("a.txt"), original).unwrap();
    let mut core = CoreWorkspace::open(dir.path()).unwrap();
    let proposed = "😎 new\r\nunchanged\r\n尾 new";
    let proposal = core.stage_proposal("a.txt", 0, proposed.into()).unwrap();
    assert_eq!(proposal.hunks.len(), 2);
    assert_eq!(
        proposal.hunks[0].to,
        "😀 old\r\n".encode_utf16().count() as u32
    );
    assert_eq!(
        proposal.hunks[1].from,
        "😀 old\r\nunchanged\r\n".encode_utf16().count() as u32
    );
    assert_eq!(proposal.hunks[1].before, "尾 old");
    assert_eq!(proposal.hunks[1].after, "尾 new");
    let result = core
        .resolve_proposal_hunks(&proposal.id, &[proposal.hunks[0].id.clone()], 0)
        .unwrap();
    assert_eq!(result.text, "😎 new\r\nunchanged\r\n尾 old");
    let remaining = core.stage_proposal("a.txt", 1, proposed.into()).unwrap();
    assert_eq!(
        core.resolve_proposal(&remaining.id, true, 1).unwrap().text,
        proposed
    );
}

#[test]
fn full_file_diff_accept_all_reconstructs_exact_proposal_for_insert_delete_and_repetition() {
    let dir = tempdir().unwrap();
    let examples = [
        ("", "😀\nnew"),
        ("removed\n", ""),
        ("same\nsame\nend", "same\ninsert\nsame\nend\n"),
        ("a\nb\nc\nd\n", "intro\na\nc\nchanged\nd\noutro"),
        ("a\r\nb", "a\nb\n"),
        ("unchanged", "unchanged"),
    ];
    for (index, (before, after)) in examples.iter().enumerate() {
        let path = format!("case{index}.txt");
        fs::write(dir.path().join(&path), before).unwrap();
        let mut core = CoreWorkspace::open(dir.path()).unwrap();
        let proposal = core.stage_proposal(&path, 0, (*after).into()).unwrap();
        if before == after {
            assert!(proposal.hunks.is_empty());
        }
        let result = core.resolve_proposal(&proposal.id, true, 0).unwrap();
        assert_eq!(&result.text, after, "case {index}");
        assert_eq!(fs::read_to_string(dir.path().join(&path)).unwrap(), *before);
    }
}

#[test]
fn separated_hunks_cannot_accept_after_user_changes_but_can_always_reject() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("a.txt"), "old one\nkeep\nold two\n").unwrap();
    let mut core = CoreWorkspace::open(dir.path()).unwrap();
    let proposal = core
        .stage_proposal("a.txt", 0, "new one\nkeep\nnew two\n".into())
        .unwrap();
    assert_eq!(proposal.hunks.len(), 2);
    core.edit_buffer_delta("a.txt", 0, vec![edit(0, 0, "user\n")])
        .unwrap();
    assert!(matches!(
        core.resolve_proposal_hunks(&proposal.id, &[proposal.hunks[0].id.clone()], 1),
        Err(CoreError::StaleRevision { .. })
    ));
    assert_eq!(
        core.agent_read("a.txt").unwrap().text,
        "user\nold one\nkeep\nold two\n"
    );
    let rejected = core.resolve_proposal(&proposal.id, false, 0).unwrap();
    assert_eq!(rejected.text, "user\nold one\nkeep\nold two\n");
}

#[cfg(unix)]
#[test]
fn dangling_dependency_link_does_not_abort_workspace_tree_or_search() {
    use std::os::unix::fs::symlink;
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("source.ts"), "const usable = true;\n").unwrap();
    // Reproduces a real workspace linking to a sibling dependency directory that is absent.
    symlink("../Gateway/node_modules", dir.path().join("node_modules")).unwrap();
    symlink("missing-target", dir.path().join("broken-link")).unwrap();
    let core = CoreWorkspace::open(dir.path()).unwrap();
    let tree = core.list_directory("").unwrap();
    assert!(tree.iter().any(|entry| entry.path == "source.ts"));
    assert!(!tree.iter().any(|entry| entry.path == "broken-link"));
    let files = core.list_files().unwrap();
    assert!(files.iter().any(|entry| entry.path == "source.ts"));
    assert_eq!(
        core.search(SearchQuery {
            text: "usable".into(),
            ..Default::default()
        })
        .unwrap()
        .len(),
        1
    );
}

#[test]
fn dependency_directories_are_skipped_but_named_files_and_explicit_reads_still_work() {
    let dir = tempdir().unwrap();
    fs::create_dir_all(dir.path().join("node_modules/package")).unwrap();
    fs::create_dir(dir.path().join("notes")).unwrap();
    fs::write(
        dir.path().join("node_modules/package/index.js"),
        "needle dependency",
    )
    .unwrap();
    fs::write(dir.path().join("notes/node_modules"), "needle user file").unwrap();
    fs::write(dir.path().join("node_modules-notes.md"), "needle notes").unwrap();
    let mut core = CoreWorkspace::open(dir.path()).unwrap();
    assert!(!core
        .list_directory("")
        .unwrap()
        .iter()
        .any(|entry| entry.path == "node_modules"));
    let files = core.list_files().unwrap();
    assert!(files.iter().any(|entry| entry.path == "notes/node_modules"));
    assert!(files
        .iter()
        .any(|entry| entry.path == "node_modules-notes.md"));
    assert!(!files
        .iter()
        .any(|entry| entry.path.starts_with("node_modules/")));
    let matches = core
        .search(SearchQuery {
            text: "needle".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(matches.len(), 2);
    assert_eq!(
        core.open_buffer("node_modules/package/index.js")
            .unwrap()
            .text,
        "needle dependency"
    );
}

#[test]
fn search_continues_when_another_entry_disappears_after_first_result() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("first.txt"), "needle\n").unwrap();
    fs::write(dir.path().join("other.txt"), "needle\n").unwrap();
    fs::create_dir(dir.path().join("subdirectory")).unwrap();
    fs::write(dir.path().join("subdirectory/nested.txt"), "needle\n").unwrap();
    let core = CoreWorkspace::open(dir.path()).unwrap();
    let mut first = true;
    let count = core
        .search_stream(
            SearchQuery {
                text: "needle".into(),
                ..Default::default()
            },
            &CancellationToken::default(),
            |found| {
                if first {
                    first = false;
                    for name in ["first.txt", "other.txt"] {
                        if found.path != name {
                            fs::remove_file(dir.path().join(name)).unwrap();
                        }
                    }
                    if !found.path.starts_with("subdirectory/") {
                        fs::remove_dir_all(dir.path().join("subdirectory")).unwrap();
                    }
                }
                true
            },
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn missing_or_invalid_scan_root_still_returns_contextual_error() {
    let dir = tempdir().unwrap();
    let path = dir.path().to_owned();
    let core = CoreWorkspace::open(&path).unwrap();
    drop(dir);
    assert!(matches!(core.list_directory(""), Err(CoreError::Io { .. })));
    assert!(matches!(core.list_files(), Err(CoreError::Io { .. })));
    assert!(matches!(
        core.search(SearchQuery {
            text: "needle".into(),
            ..Default::default()
        }),
        Err(CoreError::Io { .. })
    ));
    assert!(matches!(
        CoreWorkspace::open(&path),
        Err(CoreError::Io { .. })
    ));
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("file.txt"), "text").unwrap();
    let core = CoreWorkspace::open(dir.path()).unwrap();
    assert!(matches!(
        core.list_directory("file.txt"),
        Err(CoreError::InvalidEdit(_))
    ));
    assert!(matches!(
        core.list_directory("missing"),
        Err(CoreError::Io { .. })
    ));
}
