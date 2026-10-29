use std::{fs, path::Path, path::PathBuf, time::Duration};

use super::*;

fn write(root: &Path, relative: &str, contents: &str) -> PathBuf {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, contents).unwrap();
    path
}

async fn indexed(root: &Path) -> (FileIndex, WorkspaceHandle) {
    let index = FileIndex::default();
    let workspace = index.open_workspace(root).await.unwrap();
    index.start_scan(&workspace).unwrap().await.unwrap();
    (index, workspace)
}

#[tokio::test]
async fn scan_respects_gitignore_and_fuzzy_query_is_bounded_and_deterministic() {
    let temp = tempfile::tempdir().unwrap();
    write(temp.path(), ".gitignore", "target/\n*.secret\n");
    write(temp.path(), "src/main.rs", "fn main() {}");
    write(temp.path(), "src/menu.rs", "fn menu() {}");
    write(temp.path(), "target/generated.rs", "generated");
    write(temp.path(), "keys.secret", "secret");
    for n in 0..130 {
        write(temp.path(), &format!("src/module_{n:03}.rs"), "module");
    }

    let (index, workspace) = indexed(temp.path()).await;
    let snapshot = index.snapshot(&workspace).unwrap();
    assert_eq!(snapshot.status, ScanStatus::Ready);
    assert_eq!(snapshot.indexed_files, 133);

    let first = index.query(&workspace, "s", 500).await.unwrap();
    let second = index.query(&workspace, "s", 500).await.unwrap();
    assert_eq!(first.results.len(), 100);
    assert_eq!(first.results, second.results);
    assert!(first
        .results
        .iter()
        .any(|item| item.relative_path == Path::new("src/main.rs")));
    assert!(first
        .results
        .iter()
        .all(|item| !item.relative_path.starts_with("target")));
    assert!(index
        .query(&workspace, "secret", 100)
        .await
        .unwrap()
        .results
        .is_empty());
}

#[tokio::test]
async fn watcher_deltas_are_replayed_after_scan_and_rename_remove_are_incremental() {
    let temp = tempfile::tempdir().unwrap();
    write(temp.path(), "before.rs", "old");
    let index = FileIndex::default();
    let workspace = index.open_workspace(temp.path()).await.unwrap();

    let created = write(temp.path(), "during.rs", "during");
    index
        .apply_event(&workspace, FileEvent::Upsert(created))
        .unwrap();
    let removed = temp.path().join("before.rs");
    fs::remove_file(&removed).unwrap();
    index
        .apply_event(&workspace, FileEvent::Remove(removed))
        .unwrap();

    index.start_scan(&workspace).unwrap().await.unwrap();
    let paths = index.query(&workspace, "", 100).await.unwrap();
    assert_eq!(paths.results.len(), 1);
    assert_eq!(paths.results[0].relative_path, Path::new("during.rs"));

    let destination = write(temp.path(), "after.rs", "renamed");
    index
        .apply_event(
            &workspace,
            FileEvent::Rename {
                from: destination.with_file_name("during.rs"),
                to: destination,
            },
        )
        .unwrap();
    let paths = index.query(&workspace, "", 100).await.unwrap();
    assert_eq!(paths.results.len(), 1);
    assert_eq!(paths.results[0].relative_path, Path::new("after.rs"));
}

#[tokio::test]
async fn new_generation_cancels_old_scan_and_old_handles_cannot_mutate_it() {
    let first = tempfile::tempdir().unwrap();
    for n in 0..2000 {
        write(first.path(), &format!("tree/{n:04}.txt"), "file");
    }
    let second = tempfile::tempdir().unwrap();
    write(second.path(), "only.rs", "only");

    let index = FileIndex::default();
    let old = index.open_workspace(first.path()).await.unwrap();
    let old_scan = index.start_scan(&old).unwrap();
    tokio::time::sleep(Duration::from_millis(2)).await;

    let current = index.open_workspace(second.path()).await.unwrap();
    index.start_scan(&current).unwrap().await.unwrap();
    old_scan.await.unwrap();

    assert!(matches!(
        index.snapshot(&old),
        Err(IndexError::OutsideWorkspace)
    ));
    assert_eq!(index.snapshot(&current).unwrap().indexed_files, 1);
    assert!(matches!(
        index.apply_event(&old, FileEvent::Remove(PathBuf::from("only.rs"))),
        Err(IndexError::OutsideWorkspace)
    ));
}

// Creating symlinks needs elevated rights on Windows, so this boundary test only runs on unix.
#[cfg(unix)]
#[tokio::test]
async fn canonical_boundary_rejects_external_symlink_and_dangling_links_are_skipped() {
    let temp = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let outside = write(external.path(), "outside.rs", "outside");
    let (index, workspace) = indexed(temp.path()).await;

    {
        std::os::unix::fs::symlink(&outside, temp.path().join("external.rs")).unwrap();
        std::os::unix::fs::symlink(
            temp.path().join("missing.rs"),
            temp.path().join("dangling.rs"),
        )
        .unwrap();
        assert!(matches!(
            index.apply_event(
                &workspace,
                FileEvent::Upsert(temp.path().join("external.rs"))
            ),
            Err(IndexError::OutsideWorkspace)
        ));
        index.start_scan(&workspace).unwrap().await.unwrap();
        assert!(index
            .query(&workspace, "outside", 10)
            .await
            .unwrap()
            .results
            .is_empty());
        assert!(index
            .query(&workspace, "dangling", 10)
            .await
            .unwrap()
            .results
            .is_empty());
    }
}

#[tokio::test]
async fn watcher_upserts_apply_ignore_rules_and_invalid_rename_keeps_old_path() {
    let temp = tempfile::tempdir().unwrap();
    write(temp.path(), ".gitignore", "ignored/\n");
    let existing = write(temp.path(), "kept.rs", "ok");
    let (index, workspace) = indexed(temp.path()).await;

    let ignored = write(temp.path(), "ignored/hidden.rs", "hidden");
    index
        .apply_event(&workspace, FileEvent::Upsert(ignored))
        .unwrap();
    let results = index.query(&workspace, "hidden", 10).await.unwrap();
    assert!(results.results.is_empty());

    let external = tempfile::tempdir().unwrap();
    let outside = write(external.path(), "outside.rs", "outside");
    assert!(matches!(
        index.apply_event(
            &workspace,
            FileEvent::Rename {
                from: existing,
                to: outside,
            }
        ),
        Err(IndexError::OutsideWorkspace)
    ));
    let results = index.query(&workspace, "kept", 10).await.unwrap();
    assert_eq!(results.results.len(), 1);
    assert_eq!(results.results[0].relative_path, Path::new("kept.rs"));
}

#[test]
fn superseded_fuzzy_query_stops_before_matching_candidates() {
    let file = IndexedFile {
        relative_path: PathBuf::from("one.rs"),
        absolute_path: PathBuf::from("/workspace/one.rs"),
        size_bytes: 1,
        modified_unix_ms: None,
    };
    let files = BTreeMap::from([(file.relative_path.clone(), file)]);
    let active_query_id = std::sync::atomic::AtomicU64::new(2);
    assert!(matches!(
        fuzzy_query(&files, "one", 20, &active_query_id, 1),
        Err(IndexError::Superseded)
    ));
}

#[tokio::test]
async fn bad_scan_root_does_not_poison_a_later_workspace() {
    let index = FileIndex::default();
    assert!(index
        .open_workspace("/path/that/does/not/exist")
        .await
        .is_err());
    let temp = tempfile::tempdir().unwrap();
    write(temp.path(), "healthy.txt", "ok");
    let (index, workspace) = indexed(temp.path()).await;
    assert_eq!(
        index.snapshot(&workspace).unwrap().status,
        ScanStatus::Ready
    );
    assert_eq!(index.snapshot(&workspace).unwrap().indexed_files, 1);
}

#[tokio::test]
async fn visibility_reconfiguration_preserves_handle_but_cancels_old_scan_and_query_snapshots() {
    let temp = tempfile::tempdir().unwrap();
    write(temp.path(), ".env.example", "example");
    let ignored = write(temp.path(), "ignored/source.rs", "ignored");
    write(
        temp.path(),
        ".gitignore",
        "ignored/\nnode_modules/\ntarget/\n",
    );
    write(temp.path(), "Cargo.toml", "[package]\n");
    let dependency = write(temp.path(), "node_modules/pkg/index.js", "dependency");
    let output = write(temp.path(), "target/debug/output.rs", "generated");
    let (index, handle) = indexed(temp.path()).await;
    let generation = handle.generation();
    let request = index.inner.active_query_id.load(AtomicOrdering::Acquire);
    let (old_token, old_scan) = index.begin_scan(&handle).unwrap();
    let visible = ScanVisibility {
        show_hidden_files: false,
        show_ignored_files: true,
    };
    assert!(index.set_visibility(&handle, visible).unwrap());
    assert!(old_token.is_cancelled());
    assert_ne!(
        index.inner.active_query_id.load(AtomicOrdering::Acquire),
        request
    );
    index.scan_blocking(&handle, old_token, old_scan);
    assert_eq!(index.snapshot(&handle).unwrap().status, ScanStatus::Idle);
    assert_eq!(index.snapshot(&handle).unwrap().indexed_files, 0);
    index.start_scan(&handle).unwrap().await.unwrap();
    assert_eq!(index.snapshot(&handle).unwrap().generation, generation);
    assert!(!index.set_visibility(&handle, visible).unwrap());
    for path in [
        ignored,
        dependency,
        output,
        temp.path().join(".env.example"),
    ] {
        index.apply_event(&handle, FileEvent::Upsert(path)).unwrap();
    }
    let results = index.query(&handle, "", 100).await.unwrap();
    let paths: Vec<_> = results
        .results
        .iter()
        .map(|entry| entry.relative_path.to_string_lossy().into_owned())
        .collect();
    assert!(paths.contains(&"ignored/source.rs".into()));
    assert!(!paths.iter().any(|path| path.starts_with("node_modules/")
        || path.starts_with("target/")
        || path.starts_with('.')));
}

#[tokio::test]
async fn regular_file_named_node_modules_remains_a_source_file_in_scan_and_events() {
    let temp = tempfile::tempdir().unwrap();
    let path = write(temp.path(), "node_modules", "ordinary file");
    let (index, handle) = indexed(temp.path()).await;
    assert_eq!(
        index
            .query(&handle, "node_modules", 100)
            .await
            .unwrap()
            .results
            .len(),
        1
    );
    index.apply_event(&handle, FileEvent::Upsert(path)).unwrap();
    assert_eq!(
        index
            .query(&handle, "node_modules", 100)
            .await
            .unwrap()
            .results
            .len(),
        1
    );
}
