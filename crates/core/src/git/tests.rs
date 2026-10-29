use super::*;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;

struct Fixture {
    _temp: TempDir,
    root: PathBuf,
    hooks: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().expect("create temporary Git fixture");
        let root = temp.path().join("repo");
        let hooks = temp.path().join("private-hooks");
        fs::create_dir_all(&root).expect("create repository directory");
        fs::create_dir_all(&hooks).expect("create private hooks directory");
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "--local", "user.name", "Span Test"]);
        git(
            &root,
            &[
                "config",
                "--local",
                "user.email",
                "span-test@example.invalid",
            ],
        );
        git(&root, &["config", "--local", "commit.gpgsign", "false"]);
        git(&root, &["config", "--local", "core.fsmonitor", "false"]);
        git(
            &root,
            &[
                "config",
                "--local",
                "core.hooksPath",
                hooks.to_str().expect("UTF-8 fixture path"),
            ],
        );
        Self {
            _temp: temp,
            root,
            hooks,
        }
    }

    fn write(&self, path: &str, text: &str) {
        let full = self.root.join(path);
        fs::create_dir_all(full.parent().expect("fixture parent")).expect("create fixture parent");
        fs::write(full, text).expect("write fixture file");
    }

    fn initial_commit(&self, files: &[(&str, &str)]) {
        for (path, contents) in files {
            self.write(path, contents);
        }
        git(&self.root, &["add", "--all"]);
        git(&self.root, &["commit", "-m", "initial"]);
    }

    fn service(&self, root: &Path) -> GitService {
        GitService::new(root.to_path_buf()).expect("create Git service")
    }

    async fn repo_id(service: &GitService) -> String {
        let id = service
            .context(CancellationToken::default())
            .await
            .expect("read Git context")
            .repository
            .expect("discover repository")
            .id;
        service
            .enable(&id, CancellationToken::default())
            .await
            .expect("explicitly enable fixture Git");
        id
    }
}

fn git(root: &Path, args: &[&str]) -> std::process::Output {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .expect("run fixture Git command");
    assert!(
        output.status.success(),
        "fixture git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn token() -> CancellationToken {
    CancellationToken::default()
}

#[tokio::test]
async fn reports_non_repository_and_unborn_repository() {
    let empty = tempfile::tempdir().expect("create empty directory");
    let service = GitService::new(empty.path().to_path_buf()).expect("create service");
    let context = service
        .context(token())
        .await
        .expect("read empty folder context");
    assert!(context.repository.is_none());

    let fixture = Fixture::new();
    let context = fixture
        .service(&fixture.root)
        .context(token())
        .await
        .expect("read unborn context");
    let repository = context.repository.expect("discover unborn repository");
    assert!(repository.unborn);
    assert_eq!(repository.branch.as_deref(), Some("main"));
    assert!(repository.head.is_none());
}

#[tokio::test]
async fn partial_stage_diff_and_commit_keep_later_disk_edit_out_of_commit() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("note.txt", "base\n")]);
    let service = fixture.service(&fixture.root);
    let id = Fixture::repo_id(&service).await;
    fixture.write("note.txt", "staged version\n");
    let status = service
        .status(&id, token())
        .await
        .expect("read pre-stage status");
    let staged = service
        .stage(
            &id,
            vec!["note.txt".into()],
            &status.index_revision,
            token(),
        )
        .await
        .expect("stage file");
    fixture.write("note.txt", "later disk version\n");

    let staged_diff = service
        .diff(
            &id,
            "note.txt",
            GitDiffSide::Staged,
            &staged.index_revision,
            token(),
        )
        .await
        .expect("read staged diff");
    let working_diff = service
        .diff(
            &id,
            "note.txt",
            GitDiffSide::Working,
            &staged.index_revision,
            token(),
        )
        .await
        .expect("read working diff");
    assert!(staged_diff.patch.contains("staged version"));
    assert!(!staged_diff.patch.contains("later disk version"));
    assert!(working_diff.patch.contains("later disk version"));

    let result = service
        .commit(
            &id,
            "commit staged version".into(),
            &staged.index_revision,
            &staged.staged_snapshot,
            token(),
        )
        .await
        .expect("commit only staged content");
    assert!(
        result.warning.is_none(),
        "unexpected commit warning: {:?}",
        result.warning
    );
    let committed = git(&fixture.root, &["show", "HEAD:note.txt"]);
    assert_eq!(committed.stdout, b"staged version\n");
    assert_eq!(
        fs::read(fixture.root.join("note.txt")).expect("read worktree file"),
        b"later disk version\n"
    );
}

#[tokio::test]
async fn stale_external_index_and_index_lock_reject_without_overwriting_index() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("a.txt", "a\n"), ("b.txt", "b\n")]);
    let service = fixture.service(&fixture.root);
    let id = Fixture::repo_id(&service).await;
    fixture.write("a.txt", "changed a\n");
    fixture.write("b.txt", "changed b\n");
    let original = service
        .status(&id, token())
        .await
        .expect("status before external index change");
    git(&fixture.root, &["add", "--", "b.txt"]);
    let bytes = fs::read(fixture.root.join(".git/index")).expect("read externally changed index");
    assert!(service
        .stage(&id, vec!["a.txt".into()], &original.index_revision, token())
        .await
        .is_err());
    assert_eq!(
        fs::read(fixture.root.join(".git/index")).expect("re-read index"),
        bytes
    );

    let current = service.status(&id, token()).await.expect("refresh status");
    fs::write(
        fixture.root.join(".git/index.lock"),
        b"held by another Git process",
    )
    .expect("create lock fixture");
    let before =
        fs::read(fixture.root.join(".git/index")).expect("read index before lock rejection");
    assert!(service
        .stage(&id, vec!["a.txt".into()], &current.index_revision, token())
        .await
        .is_err());
    assert_eq!(
        fs::read(fixture.root.join(".git/index")).expect("read index after lock rejection"),
        before
    );
}

#[tokio::test]
async fn special_paths_are_literal_and_parent_workspace_reports_whole_repository() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("existing.txt", "base\n")]);
    let nested = fixture.root.join("nested");
    fs::create_dir_all(&nested).expect("create nested folder");
    let service = fixture.service(&nested);
    let id = Fixture::repo_id(&service).await;
    let paths = ["-dash.txt", "日本語.txt", "space name.txt"]
        .into_iter()
        .chain(if cfg!(unix) {
            vec![":(glob)*.txt", "line\nbreak.txt"]
        } else {
            Vec::new()
        })
        .collect::<Vec<_>>();
    for path in &paths {
        fixture.write(path, "new content\n");
    }
    fixture.write("existing.txt", "changed outside nested workspace\n");
    let status = service
        .status(&id, token())
        .await
        .expect("status from nested workspace");
    assert_eq!(status.repository.workspace_prefix, "nested");
    for path in paths.iter().copied().chain(std::iter::once("existing.txt")) {
        assert!(
            status
                .entries
                .iter()
                .any(|entry| entry.path.as_deref() == Some(path)),
            "missing status entry for {path:?}"
        );
    }
    let staged = service
        .stage(
            &id,
            paths.iter().map(|path| (*path).to_owned()).collect(),
            &status.index_revision,
            token(),
        )
        .await
        .expect("stage exact special paths");
    assert_eq!(
        staged
            .entries
            .iter()
            .filter(|entry| !entry.untracked && entry.index_status != ".")
            .count(),
        paths.len()
    );
    assert!(staged
        .entries
        .iter()
        .any(|entry| entry.path.as_deref() == Some("existing.txt") && entry.index_status == "."));
}

#[tokio::test]
async fn unstage_removes_both_staged_rename_paths_and_preserves_working_file() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("old name.txt", "content\n")]);
    let service = fixture.service(&fixture.root);
    let id = Fixture::repo_id(&service).await;
    git(&fixture.root, &["mv", "--", "old name.txt", "new name.txt"]);
    let status = service
        .status(&id, token())
        .await
        .expect("read staged rename");
    let rename = status
        .entries
        .iter()
        .find(|entry| entry.path.as_deref() == Some("new name.txt"))
        .expect("rename entry");
    assert_eq!(rename.old_path.as_deref(), Some("old name.txt"));
    let unstaged = service
        .unstage(
            &id,
            vec!["new name.txt".into()],
            &status.index_revision,
            token(),
        )
        .await
        .expect("unstage rename endpoints");
    assert!(fs::read(fixture.root.join("new name.txt")).is_ok());
    assert!(unstaged
        .entries
        .iter()
        .any(|entry| entry.path.as_deref() == Some("new name.txt")));

    let empty = Fixture::new();
    let empty_service = empty.service(&empty.root);
    let empty_id = Fixture::repo_id(&empty_service).await;
    empty.write("unborn.txt", "keep me\n");
    let before = empty_service
        .status(&empty_id, token())
        .await
        .expect("unborn status");
    let added = empty_service
        .stage(
            &empty_id,
            vec!["unborn.txt".into()],
            &before.index_revision,
            token(),
        )
        .await
        .expect("stage unborn file");
    let after = empty_service
        .unstage(
            &empty_id,
            vec!["unborn.txt".into()],
            &added.index_revision,
            token(),
        )
        .await
        .expect("unstage unborn file");
    assert_eq!(
        fs::read(empty.root.join("unborn.txt")).expect("working file survives unstage"),
        b"keep me\n"
    );
    assert!(after
        .entries
        .iter()
        .any(|entry| entry.path.as_deref() == Some("unborn.txt") && entry.untracked));
}

#[tokio::test]
async fn history_pages_are_anchored_and_linked_worktree_has_its_own_identity() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("file.txt", "one\n")]);
    fixture.write("file.txt", "two\n");
    git(&fixture.root, &["add", "--", "file.txt"]);
    git(&fixture.root, &["commit", "-m", "second"]);
    fixture.write("file.txt", "three\n");
    git(&fixture.root, &["add", "--", "file.txt"]);
    git(&fixture.root, &["commit", "-m", "third"]);

    let service = fixture.service(&fixture.root);
    let id = Fixture::repo_id(&service).await;
    let first = service
        .history(
            &id,
            GitHistoryQuery {
                anchor: None,
                skip: 0,
                limit: 1,
                path: None,
            },
            token(),
        )
        .await
        .expect("history first page");
    let anchor = first.commits.first().expect("first commit").id.clone();
    let second = service
        .history(
            &id,
            GitHistoryQuery {
                anchor: Some(anchor.clone()),
                skip: 1,
                limit: 1,
                path: None,
            },
            token(),
        )
        .await
        .expect("anchored next history page");
    assert_eq!(second.anchor.as_deref(), Some(anchor.as_str()));
    assert_ne!(first.commits[0].id, second.commits[0].id);

    git(
        &fixture.root,
        &["worktree", "add", "--detach", "../linked", "HEAD"],
    );
    let linked_root = fixture
        .root
        .parent()
        .expect("fixture parent")
        .join("linked");
    let linked = GitService::new(linked_root).expect("open linked worktree service");
    let linked_repo = linked
        .context(token())
        .await
        .expect("discover linked worktree")
        .repository
        .expect("linked worktree repository");
    assert_ne!(id, linked_repo.id);
    assert!(linked_repo.detached);
    linked
        .enable(&linked_repo.id, token())
        .await
        .expect("enable linked worktree session");
    assert!(!linked
        .history(&linked_repo.id, GitHistoryQuery::default(), token())
        .await
        .expect("linked history")
        .commits
        .is_empty());
}

#[tokio::test]
async fn failing_pre_commit_hook_and_missing_identity_preserve_worktree_and_index() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("file.txt", "base\n")]);
    let service = fixture.service(&fixture.root);
    let id = Fixture::repo_id(&service).await;
    fixture.write("file.txt", "staged content\n");
    let initial = service
        .status(&id, token())
        .await
        .expect("status before stage");
    let staged = service
        .stage(
            &id,
            vec!["file.txt".into()],
            &initial.index_revision,
            token(),
        )
        .await
        .expect("stage before hook");
    let index_before = fs::read(fixture.root.join(".git/index")).expect("read staged index");
    let head_before = git(&fixture.root, &["rev-parse", "HEAD"]).stdout;

    let hook = fixture.hooks.join("pre-commit");
    fs::write(
        &hook,
        b"#!/bin/sh\nprintf 'hook-added\\n' > hook-added.txt\ngit add -- hook-added.txt\nexit 0\n",
    )
    .expect("write private hook");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755))
            .expect("make hook executable");
    }
    assert!(service
        .commit(
            &id,
            "must reject hook index mutation".into(),
            &staged.index_revision,
            &staged.staged_snapshot,
            token()
        )
        .await
        .is_err());
    assert_eq!(
        fs::read(fixture.root.join(".git/index")).expect("index after rejected hook"),
        index_before
    );
    assert_eq!(
        git(&fixture.root, &["rev-parse", "HEAD"]).stdout,
        head_before
    );
    assert_eq!(
        fs::read(fixture.root.join("file.txt")).expect("working file after rejected hook"),
        b"staged content\n"
    );
    assert_eq!(
        fs::read(fixture.root.join("hook-added.txt")).expect("hook working file"),
        b"hook-added\n"
    );

    fs::remove_file(&hook).expect("remove private hook");
    git(&fixture.root, &["config", "--local", "user.name", ""]);
    let index_before =
        fs::read(fixture.root.join(".git/index")).expect("read index before identity rejection");
    assert!(service
        .commit(
            &id,
            "missing identity".into(),
            &staged.index_revision,
            &staged.staged_snapshot,
            token()
        )
        .await
        .is_err());
    assert_eq!(
        fs::read(fixture.root.join(".git/index")).expect("index after identity rejection"),
        index_before
    );
    assert_eq!(
        fs::read(fixture.root.join("file.txt")).expect("working file after identity rejection"),
        b"staged content\n"
    );

    git(
        &fixture.root,
        &["config", "--local", "user.name", "Span Test"],
    );
    git(
        &fixture.root,
        &["config", "--local", "commit.gpgsign", "true"],
    );
    git(
        &fixture.root,
        &["config", "--local", "gpg.format", "openpgp"],
    );
    git(
        &fixture.root,
        &[
            "config",
            "--local",
            "gpg.program",
            "/no-such-span-test-signer",
        ],
    );
    let index_before =
        fs::read(fixture.root.join(".git/index")).expect("read index before signing rejection");
    assert!(service
        .commit(
            &id,
            "signing must be rejected".into(),
            &staged.index_revision,
            &staged.staged_snapshot,
            token()
        )
        .await
        .is_err());
    assert_eq!(
        fs::read(fixture.root.join(".git/index")).expect("index after signing rejection"),
        index_before
    );
    assert_eq!(
        fs::read(fixture.root.join("file.txt")).expect("working file after signing rejection"),
        b"staged content\n"
    );
}

fn install_fixture_hook(fixture: &Fixture, name: &str, script: &str) -> PathBuf {
    let path = fixture.hooks.join(name);
    fs::write(&path, script).expect("write owned hook fixture");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .expect("make fixture hook executable");
    }
    path
}

#[cfg(unix)]
#[tokio::test]
async fn discovery_and_denied_reads_never_invoke_configured_clean_filter() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[
        ("file.txt", "base\n"),
        (".gitattributes", "file.txt filter=trip\n"),
    ]);
    let marker = fixture._temp.path().join("filter-called");
    let filter = install_fixture_hook(
        &fixture,
        "clean-filter",
        &format!(
            "#!/bin/sh\nprintf called > '{}'\n/bin/cat\n",
            marker.display()
        ),
    );
    git(
        &fixture.root,
        &[
            "config",
            "filter.trip.clean",
            filter.to_str().expect("fixture path"),
        ],
    );
    fixture.write("file.txt", "edit\n");
    let service = fixture.service(&fixture.root);
    let context = service
        .context(token())
        .await
        .expect("discover without status");
    assert!(!context.enabled);
    let id = context.repository.expect("repo").id;
    assert!(!marker.exists(), "discovery invoked a clean filter");
    assert!(service.status(&id, token()).await.is_err());
    assert!(!marker.exists(), "a denied read invoked a clean filter");
    service
        .enable(&id, token())
        .await
        .expect("explicit session enable");
    assert!(
        marker.exists(),
        "explicitly enabled status should retain normal Git filters"
    );
    let reopened = fixture.service(&fixture.root);
    let reopened_context = reopened.context(token()).await.expect("reopened discovery");
    assert!(!reopened_context.enabled);
    assert_ne!(id, reopened_context.repository.expect("new session").id);
    assert!(reopened.status(&id, token()).await.is_err());
}

#[tokio::test]
async fn successful_commit_survives_oversized_hook_message_metadata() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("file.txt", "base\n")]);
    let service = fixture.service(&fixture.root);
    let id = Fixture::repo_id(&service).await;
    fixture.write("file.txt", "change\n");
    let before = service.status(&id, token()).await.expect("status");
    let staged = service
        .stage(
            &id,
            vec!["file.txt".into()],
            &before.index_revision,
            token(),
        )
        .await
        .expect("stage");
    install_fixture_hook(&fixture, "prepare-commit-msg", "#!/bin/sh\n{ printf 'Hook subject\n\n'; i=0; while [ \"$i\" -lt 70 ]; do printf '%01000d\n' 0; i=$((i+1)); done; } > \"$1\"\n");
    let result = service
        .commit(
            &id,
            "submitted".into(),
            &staged.index_revision,
            &staged.staged_snapshot,
            token(),
        )
        .await
        .expect("actual commit remains success");
    assert_eq!(
        git(&fixture.root, &["rev-parse", "HEAD"]).stdout,
        format!("{}\n", result.commit_id).as_bytes()
    );
    assert!(result.commit.is_none());
    assert!(result.status.is_some());
    assert!(result
        .warning
        .as_deref()
        .is_some_and(|value| value.contains("metadata")));
}

#[tokio::test]
async fn original_reference_hook_receives_stdin_and_post_commit_index_changes_survive() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("file.txt", "base\n")]);
    git(
        &fixture.root,
        &["config", "core.hooksPath", "../private-hooks"],
    );
    let log = fixture._temp.path().join("reference-log");
    install_fixture_hook(&fixture, "reference-transaction", &format!("#!/bin/sh\nprintf 'phase:%s\n' \"$1\" >> '{}'\nwhile IFS= read -r line; do printf '%s\n' \"$line\" >> '{}'; done\n", log.display(), log.display()));
    install_fixture_hook(
        &fixture,
        "post-commit",
        "#!/bin/sh\nprintf 'after-hook\n' > file.txt\ngit add -- file.txt\n",
    );
    let service = fixture.service(&fixture.root);
    let id = Fixture::repo_id(&service).await;
    fixture.write("file.txt", "reviewed\n");
    let before = service.status(&id, token()).await.expect("status");
    let staged = service
        .stage(
            &id,
            vec!["file.txt".into()],
            &before.index_revision,
            token(),
        )
        .await
        .expect("stage");
    let result = service
        .commit(
            &id,
            "reviewed commit".into(),
            &staged.index_revision,
            &staged.staged_snapshot,
            token(),
        )
        .await
        .expect("commit");
    assert_eq!(
        git(&fixture.root, &["show", "HEAD:file.txt"]).stdout,
        b"reviewed\n"
    );
    assert_eq!(
        git(&fixture.root, &["show", ":file.txt"]).stdout,
        b"after-hook\n"
    );
    let text = fs::read_to_string(log).expect("read hook input log");
    assert!(text.contains("phase:prepared") && text.contains("phase:committed"));
    assert!(text.contains(&format!("{} refs/heads/main", result.commit_id)));
}

#[tokio::test]
async fn expanded_reads_pin_baselines_blame_branches_and_commit_files() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("tracked.txt", "one\ntwo\n")]);
    let service = fixture.service(&fixture.root);
    let id = Fixture::repo_id(&service).await;
    fixture.write("tracked.txt", "one\nchanged\n");
    let baseline = service
        .file_baseline(&id, "tracked.txt", token())
        .await
        .unwrap();
    assert_eq!(baseline.index_text.as_deref(), Some("one\ntwo\n"));
    assert_eq!(baseline.head_text, baseline.index_text);
    assert!(!baseline.binary && !baseline.truncated);
    let blame = service.blame(&id, "tracked.txt", token()).await.unwrap();
    assert_eq!(blame.lines.len(), 2);
    assert_eq!(blame.lines[1].author, "Span Test");
    assert_eq!(blame.lines[1].line, 2);
    let branches = service.branches(&id, token()).await.unwrap();
    assert!(branches
        .iter()
        .any(|branch| branch.name == "main" && branch.current));
    let details = service
        .commit_details(&id, blame.head.as_deref().unwrap(), token())
        .await
        .unwrap();
    assert_eq!(details.files[0].path, "tracked.txt");
    assert_eq!(details.files[0].status, "A");
    assert!(service
        .file_baseline(&id, "../outside", token())
        .await
        .is_err());
    assert!(service.blame(&id, "../outside", token()).await.is_err());
}

#[tokio::test]
async fn expanded_mutations_switch_stash_and_manage_real_worktrees_without_force() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("tracked.txt", "base\n")]);
    let service = fixture.service(&fixture.root);
    let id = Fixture::repo_id(&service).await;
    let status = service.status(&id, token()).await.unwrap();
    service
        .checkout(&id, "topic", true, &status.index_revision, token())
        .await
        .unwrap();
    fixture.write("tracked.txt", "draft\n");
    let status = service.status(&id, token()).await.unwrap();
    assert!(service
        .checkout(&id, "main", false, &status.index_revision, token())
        .await
        .is_err());
    assert!(service
        .checkout(&id, "-f", true, &status.index_revision, token())
        .await
        .is_err());
    service
        .stash(
            &id,
            GitStashAction::Save,
            None,
            Some("test stash".into()),
            &status.index_revision,
            token(),
        )
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(fixture.root.join("tracked.txt")).unwrap(),
        "base\n"
    );
    let stashes = service.stashes(&id, token()).await.unwrap();
    assert_eq!(stashes.len(), 1);
    let status = service.status(&id, token()).await.unwrap();
    assert!(service
        .stash(
            &id,
            GitStashAction::Pop,
            Some(stashes[0].id.clone()),
            None,
            &status.index_revision,
            token()
        )
        .await
        .is_err());
    service
        .stash(
            &id,
            GitStashAction::Apply,
            Some(stashes[0].id.clone()),
            None,
            &status.index_revision,
            token(),
        )
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(fixture.root.join("tracked.txt")).unwrap(),
        "draft\n"
    );
    assert_eq!(service.stashes(&id, token()).await.unwrap().len(), 1);
    git(&fixture.root, &["restore", "--", "tracked.txt"]);
    let status = service.status(&id, token()).await.unwrap();
    service
        .checkout(&id, "main", false, &status.index_revision, token())
        .await
        .unwrap();
    let target = fixture._temp.path().join("linked");
    service
        .worktree_add(&id, target.to_str().unwrap(), "topic", token())
        .await
        .unwrap();
    let trees = service.worktrees(&id, token()).await.unwrap();
    assert_eq!(trees.len(), 2);
    assert!(service
        .worktree_remove(&id, fixture.root.to_str().unwrap(), token())
        .await
        .is_err());
    fs::write(target.join("tracked.txt"), "keep me\n").unwrap();
    assert!(service
        .worktree_remove(&id, target.to_str().unwrap(), token())
        .await
        .is_err());
    assert!(target.join("tracked.txt").exists());
    git(&target, &["restore", "--", "tracked.txt"]);
    service
        .worktree_remove(&id, target.to_str().unwrap(), token())
        .await
        .unwrap();
    assert!(!target.exists());
}

#[tokio::test]
async fn remote_actions_use_explicit_upstream_and_fast_forward_only() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("tracked.txt", "base\n")]);
    let bare = fixture._temp.path().join("remote.git");
    let output = Command::new("git")
        .args(["init", "--bare", "--quiet"])
        .arg(&bare)
        .output()
        .unwrap();
    assert!(output.status.success());
    git(
        &fixture.root,
        &["remote", "add", "origin", bare.to_str().unwrap()],
    );
    git(&fixture.root, &["push", "-u", "origin", "main"]);
    let service = fixture.service(&fixture.root);
    let id = Fixture::repo_id(&service).await;
    let configuration = service
        .remotes(&id, token())
        .await
        .unwrap()
        .config_fingerprint;
    fixture.write("tracked.txt", "next\n");
    git(&fixture.root, &["commit", "-am", "next"]);
    service
        .remote(&id, GitRemoteAction::Push, &configuration, token())
        .await
        .unwrap();
    service
        .remote(&id, GitRemoteAction::Fetch, &configuration, token())
        .await
        .unwrap();
    service
        .remote(&id, GitRemoteAction::Pull, &configuration, token())
        .await
        .unwrap();
    fixture.write("tracked.txt", "unsaved disk\n");
    assert!(service
        .remote(&id, GitRemoteAction::Pull, &configuration, token())
        .await
        .is_err());
    assert_eq!(
        fs::read_to_string(fixture.root.join("tracked.txt")).unwrap(),
        "unsaved disk\n"
    );
    git(
        &fixture.root,
        &[
            "config",
            "remote.origin.pushurl",
            "https://name:secret@example.invalid/repo",
        ],
    );
    let redacted = service.remotes(&id, token()).await.unwrap();
    assert!(redacted.remotes[0]
        .push_url
        .contains("[redacted]@example.invalid"));
    assert!(!redacted.remotes[0].push_url.contains("secret"));
    let stale = service
        .remote(&id, GitRemoteAction::Fetch, &configuration, token())
        .await
        .unwrap_err();
    assert!(stale.to_string().contains("configuration changed"));
}

#[test]
fn remote_diagnostics_redact_url_credentials() {
    assert_eq!(
        redact_git_output(
            "fatal https://name:secret@example.test/repo and ssh://token@example.test/next"
        ),
        "fatal https://[redacted]@example.test/repo and ssh://[redacted]@example.test/next"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn remote_transport_allowlist_rejects_ext_even_when_repository_allows_it() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("tracked.txt", "base\n")]);
    let marker = fixture._temp.path().join("remote-helper-executed");
    let remote = format!("ext::sh -c touch% {}", marker.display());
    git(&fixture.root, &["remote", "add", "origin", &remote]);
    git(&fixture.root, &["config", "protocol.ext.allow", "always"]);
    let service = fixture.service(&fixture.root);
    let id = Fixture::repo_id(&service).await;
    let configuration = service
        .remotes(&id, token())
        .await
        .unwrap()
        .config_fingerprint;
    let result = service
        .remote(&id, GitRemoteAction::Fetch, &configuration, token())
        .await;
    assert!(result.is_err());
    assert!(
        !marker.exists(),
        "repository cannot widen the allowed transport protocols"
    );
}

#[tokio::test]
async fn checkout_and_pull_preserve_ignored_working_files() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("tracked.txt", "base\n"), (".gitignore", "ignored.txt\n")]);
    let bare = fixture._temp.path().join("remote.git");
    let initialized = Command::new("git")
        .args(["init", "--bare", "--quiet"])
        .arg(&bare)
        .output()
        .unwrap();
    assert!(initialized.status.success());
    git(
        &fixture.root,
        &["remote", "add", "origin", bare.to_str().unwrap()],
    );
    git(&fixture.root, &["push", "-u", "origin", "main"]);
    git(&fixture.root, &["switch", "-c", "topic"]);
    fixture.write("ignored.txt", "remote tracked bytes\n");
    git(&fixture.root, &["add", "--force", "--", "ignored.txt"]);
    git(&fixture.root, &["commit", "-m", "track ignored name"]);
    git(&fixture.root, &["push", "origin", "topic:main"]);
    git(&fixture.root, &["switch", "main"]);
    fixture.write("ignored.txt", "precious local ignored bytes\n");
    let service = fixture.service(&fixture.root);
    let id = Fixture::repo_id(&service).await;
    let status = service.status(&id, token()).await.unwrap();
    assert!(status.entries.is_empty());
    assert!(service
        .checkout(&id, "topic", false, &status.index_revision, token())
        .await
        .is_err());
    let configuration = service
        .remotes(&id, token())
        .await
        .unwrap()
        .config_fingerprint;
    assert!(service
        .remote(&id, GitRemoteAction::Pull, &configuration, token())
        .await
        .is_err());
    assert_eq!(
        fs::read_to_string(fixture.root.join("ignored.txt")).unwrap(),
        "precious local ignored bytes\n"
    );
    assert_eq!(
        service.status(&id, token()).await.unwrap().repository.head,
        status.repository.head
    );
    assert!(git(&fixture.root, &["for-each-ref", "refs/span/pull/"])
        .stdout
        .is_empty());
}
