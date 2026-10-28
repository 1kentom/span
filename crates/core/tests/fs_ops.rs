use span_core::{CancellationToken, CoreError, CoreWorkspace, TextEdit};
use std::fs;
use tempfile::tempdir;

#[test]
fn create_file_and_folder_persist_without_overwriting_existing_data() {
    let directory = tempdir().unwrap();
    let mut core = CoreWorkspace::open(directory.path()).unwrap();
    let folder = core.new_directory("created").unwrap();
    assert!(folder.is_dir);
    let file = core.new_file("created/file.txt").unwrap();
    assert_eq!(file.path, "created/file.txt");
    assert!(directory.path().join("created/file.txt").is_file());
    assert_eq!(file.revision, file.saved_revision);
    core.edit_buffer_delta(
        "created/file.txt",
        0,
        vec![TextEdit {
            from: 0,
            to: 0,
            insert: "unsaved".into(),
        }],
    )
    .unwrap();
    assert!(core.new_file("created/file.txt").is_err());
    assert_eq!(core.agent_read("created/file.txt").unwrap().text, "unsaved");
    assert_eq!(
        fs::read_to_string(directory.path().join("created/file.txt")).unwrap(),
        ""
    );
    assert!(core.new_directory("created").is_err());
}

#[test]
fn rename_repaths_clean_open_buffers_and_never_replaces_a_destination() {
    let directory = tempdir().unwrap();
    fs::create_dir(directory.path().join("old")).unwrap();
    fs::write(directory.path().join("old/a.txt"), "original").unwrap();
    fs::write(directory.path().join("other.txt"), "do not overwrite").unwrap();
    let mut core = CoreWorkspace::open(directory.path()).unwrap();
    core.open_buffer("old/a.txt").unwrap();
    assert!(core.rename_path("old/a.txt", "other.txt").is_err());
    assert_eq!(
        fs::read_to_string(directory.path().join("other.txt")).unwrap(),
        "do not overwrite"
    );
    let renamed = core.rename_path("old", "new").unwrap();
    assert_eq!(renamed.path, "new");
    assert!(!directory.path().join("old").exists());
    let buffer = core.buffer_snapshot("new/a.txt").unwrap();
    assert_eq!(buffer.text, "original");
    assert_eq!(buffer.revision, 1);
    assert_eq!(buffer.saved_revision, 1);
    assert!(core.buffer_snapshot("old/a.txt").is_err());
    assert!(matches!(
        core.edit_buffer_delta("new/a.txt", 0, vec![]),
        Err(CoreError::StaleRevision { .. })
    ));
}

#[test]
fn dirty_buffers_and_pending_agent_proposals_block_path_mutations() {
    let directory = tempdir().unwrap();
    fs::create_dir(directory.path().join("folder")).unwrap();
    fs::write(directory.path().join("folder/a.txt"), "disk").unwrap();
    let mut core = CoreWorkspace::open(directory.path()).unwrap();
    core.open_buffer("folder/a.txt").unwrap();
    core.edit_buffer_delta(
        "folder/a.txt",
        0,
        vec![TextEdit {
            from: 0,
            to: 0,
            insert: "dirty ".into(),
        }],
    )
    .unwrap();
    assert!(core.rename_path("folder", "renamed").is_err());
    assert!(core.trash_path("folder").is_err());
    assert!(core.duplicate_path("folder", "copy").is_err());
    assert_eq!(core.agent_read("folder/a.txt").unwrap().text, "dirty disk");
    core.discard_buffer("folder/a.txt").unwrap();
    let proposal = core
        .stage_proposal("folder/a.txt", 2, "agent".into())
        .unwrap();
    assert!(core.rename_path("folder", "renamed").is_err());
    assert!(core.trash_path("folder").is_err());
    core.resolve_proposal(&proposal.id, false, 2).unwrap();
    assert!(core.rename_path("folder", "renamed").is_ok());
}

#[test]
fn duplicate_is_complete_preserves_files_and_rolls_back_cancelled_copy() {
    let directory = tempdir().unwrap();
    fs::create_dir_all(directory.path().join("source/child")).unwrap();
    fs::write(
        directory.path().join("source/child/data.bin"),
        [0, 1, 2, 255],
    )
    .unwrap();
    fs::write(directory.path().join("existing.txt"), "preserved").unwrap();
    let mut core = CoreWorkspace::open(directory.path()).unwrap();
    assert!(core.duplicate_path("source", "source/recursive").is_err());
    core.duplicate_path("source", "copy").unwrap();
    assert_eq!(
        fs::read(directory.path().join("copy/child/data.bin")).unwrap(),
        [0, 1, 2, 255]
    );
    assert!(core
        .duplicate_path("source/child/data.bin", "existing.txt")
        .is_err());
    assert_eq!(
        fs::read_to_string(directory.path().join("existing.txt")).unwrap(),
        "preserved"
    );
    let cancellation = CancellationToken::default();
    cancellation.cancel();
    assert!(core
        .duplicate_path_cancellable("source", "cancelled", &cancellation)
        .is_err());
    assert!(!directory.path().join("cancelled").exists());
    assert!(!fs::read_dir(directory.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".span-copy-")));
}

#[test]
fn all_operations_refuse_parent_escape_absolute_escape_and_root_mutation() {
    let directory = tempdir().unwrap();
    let outside = tempdir().unwrap();
    fs::write(directory.path().join("source.txt"), "inside").unwrap();
    fs::write(outside.path().join("private.txt"), "outside").unwrap();
    let mut core = CoreWorkspace::open(directory.path()).unwrap();
    assert!(core.new_file("../escape.txt").is_err());
    assert!(core
        .new_directory(&outside.path().join("new").to_string_lossy())
        .is_err());
    assert!(core.rename_path("source.txt", "../escape.txt").is_err());
    assert!(core.duplicate_path("source.txt", "../escape.txt").is_err());
    assert!(core.trash_path("").is_err());
    assert!(core.rename_path("", "renamed-root").is_err());
    assert_eq!(
        fs::read_to_string(outside.path().join("private.txt")).unwrap(),
        "outside"
    );
}

#[cfg(unix)]
#[test]
fn symbolic_links_cannot_redirect_duplicate_rename_or_trash_operations() {
    use std::os::unix::fs::symlink;
    let directory = tempdir().unwrap();
    let outside = tempdir().unwrap();
    fs::write(outside.path().join("private.txt"), "outside").unwrap();
    fs::write(directory.path().join("inside.txt"), "inside").unwrap();
    symlink(outside.path(), directory.path().join("escape")).unwrap();
    symlink("inside.txt", directory.path().join("alias")).unwrap();
    fs::create_dir(directory.path().join("source")).unwrap();
    symlink(
        outside.path().join("private.txt"),
        directory.path().join("source/link"),
    )
    .unwrap();
    let mut core = CoreWorkspace::open(directory.path()).unwrap();
    assert!(core.new_file("escape/new.txt").is_err());
    assert!(core.rename_path("alias", "renamed.txt").is_err());
    assert!(core.trash_path("alias").is_err());
    assert!(core.trash_path("escape").is_err());
    assert!(core.duplicate_path("source", "copy").is_err());
    assert!(!directory.path().join("copy").exists());
    assert_eq!(
        fs::read_to_string(directory.path().join("inside.txt")).unwrap(),
        "inside"
    );
    assert_eq!(
        fs::read_to_string(outside.path().join("private.txt")).unwrap(),
        "outside"
    );
}

#[test]
fn bounded_duplicate_rejects_large_files_and_overdeep_trees_without_publishing_partial_data() {
    let directory = tempdir().unwrap();
    let file = fs::File::create(directory.path().join("large.bin")).unwrap();
    file.set_len(64 * 1024 * 1024 + 1).unwrap();
    drop(file);
    let mut core = CoreWorkspace::open(directory.path()).unwrap();
    assert!(core
        .duplicate_path("large.bin", "large-copy.bin")
        .unwrap_err()
        .to_string()
        .contains("64 MiB"));
    assert!(!directory.path().join("large-copy.bin").exists());
    let mut path = directory.path().join("deep");
    fs::create_dir(&path).unwrap();
    for _ in 0..65 {
        path = path.join("d");
        fs::create_dir(&path).unwrap();
    }
    assert!(core
        .duplicate_path("deep", "deep-copy")
        .unwrap_err()
        .to_string()
        .contains("64 level"));
    assert!(!directory.path().join("deep-copy").exists());
    assert!(!fs::read_dir(directory.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".span-copy-")));
}
