use super::*;
use std::fs;
use std::process::Command;
use tempfile::TempDir;

struct Repo {
    _temp: TempDir,
    root: PathBuf,
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Span Test")
        .env("GIT_AUTHOR_EMAIL", "span-test@example.invalid")
        .env("GIT_COMMITTER_NAME", "Span Test")
        .env("GIT_COMMITTER_EMAIL", "span-test@example.invalid")
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

impl Repo {
    fn new() -> Self {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("repo").canonicalize_or_create();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "--local", "commit.gpgsign", "false"]);
        git(&root, &["config", "--local", "core.fsmonitor", "false"]);
        Self { _temp: temp, root }
    }
    fn write(&self, path: &str, text: &str) {
        let full = self.root.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, text).unwrap();
    }
    fn read(&self, path: &str) -> Option<String> {
        fs::read_to_string(self.root.join(path)).ok()
    }
    fn commit_all(&self, message: &str) {
        git(&self.root, &["add", "-A"]);
        git(&self.root, &["commit", "-q", "--no-verify", "-m", message]);
    }
    fn service(&self) -> Checkpoints {
        Checkpoints::new(GitService::new(self.root.clone()).expect("git service"))
    }
    /// Everything a capture must leave alone.
    fn user_state(&self) -> (String, String, String, String, Vec<u8>) {
        (
            git(
                &self.root,
                &[
                    "status",
                    "--porcelain=v2",
                    "--branch",
                    "--untracked-files=all",
                ],
            ),
            git(&self.root, &["stash", "list"]),
            git(&self.root, &["rev-parse", "HEAD"]),
            git(
                &self.root,
                &[
                    "for-each-ref",
                    "--format=%(refname) %(objectname)",
                    "refs/heads",
                    "refs/stash",
                    "refs/tags",
                ],
            ),
            fs::read(self.root.join(".git/index")).unwrap_or_default(),
        )
    }
}

trait CanonicalOrCreate {
    fn canonicalize_or_create(self) -> PathBuf;
}
impl CanonicalOrCreate for PathBuf {
    fn canonicalize_or_create(self) -> PathBuf {
        fs::create_dir_all(&self).unwrap();
        self.canonicalize().unwrap()
    }
}

fn token() -> CancellationToken {
    CancellationToken::default()
}

async fn turn(service: &Checkpoints, session: &str, edit: impl FnOnce()) -> u32 {
    let number = service.next_turn(session, token()).await.unwrap();
    let start = service
        .capture(session, number, CheckpointPhase::Start, token())
        .await
        .unwrap();
    assert!(
        matches!(start, CaptureOutcome::Captured { .. }),
        "{start:?}"
    );
    edit();
    let end = service
        .capture(session, number, CheckpointPhase::End, token())
        .await
        .unwrap();
    assert!(matches!(end, CaptureOutcome::Captured { .. }), "{end:?}");
    number
}

#[tokio::test]
async fn capture_leaves_index_branch_stash_and_head_untouched() {
    let repo = Repo::new();
    repo.write("a.txt", "one\n");
    repo.write("b.txt", "base\n");
    repo.commit_all("init");
    repo.write("b.txt", "stashed\n");
    git(&repo.root, &["stash", "push", "-q", "-m", "fixture"]);
    repo.write("a.txt", "staged\n");
    git(&repo.root, &["add", "a.txt"]);
    repo.write("a.txt", "staged then edited\n");
    repo.write("new.txt", "untracked\n");
    let before = repo.user_state();
    let service = repo.service();
    let outcome = service
        .capture("s1", 1, CheckpointPhase::Start, token())
        .await
        .unwrap();
    assert!(
        matches!(outcome, CaptureOutcome::Captured { files: 3, .. }),
        "{outcome:?}"
    );
    assert_eq!(repo.user_state(), before);
    let refs = git(
        &repo.root,
        &["for-each-ref", "--format=%(refname)", "refs/span"],
    );
    assert_eq!(refs.trim(), "refs/span/checkpoints/s1/turns/000001/start");
    let message = git(
        &repo.root,
        &[
            "log",
            "-1",
            "--format=%B",
            "refs/span/checkpoints/s1/turns/000001/start",
        ],
    );
    assert_eq!(message.trim(), "span checkpoint s1 1");
}

#[tokio::test]
async fn snapshot_includes_untracked_and_skips_ignored_and_span_internals() {
    let repo = Repo::new();
    repo.write(".gitignore", "build/\n*.log\n");
    repo.write("src/main.rs", "fn main() {}\n");
    repo.commit_all("init");
    repo.write("notes.md", "untracked\n");
    repo.write("build/out.bin", "ignored\n");
    repo.write("debug.log", "ignored\n");
    repo.write(".span/state.json", "{}\n");
    let service = repo.service();
    service
        .capture("s", 1, CheckpointPhase::Start, token())
        .await
        .unwrap();
    let listed = git(
        &repo.root,
        &[
            "ls-tree",
            "-r",
            "--name-only",
            "refs/span/checkpoints/s/turns/000001/start",
        ],
    );
    let names: Vec<&str> = listed.lines().collect();
    assert_eq!(names, vec![".gitignore", "notes.md", "src/main.rs"]);
}

#[tokio::test]
async fn non_git_workspace_is_unavailable() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plain").canonicalize_or_create();
    fs::write(root.join("a.txt"), "x").unwrap();
    let service = Checkpoints::new(GitService::new(root.clone()).unwrap());
    let outcome = service
        .capture("s", 1, CheckpointPhase::Start, token())
        .await
        .unwrap();
    assert!(
        matches!(outcome, CaptureOutcome::Unavailable { .. }),
        "{outcome:?}"
    );
    let status = service.status(token()).await;
    assert!(!status.available && status.can_init);
    assert!(service.list("s", token()).await.unwrap().is_empty());
    assert!(
        !root.join(".git").exists(),
        "checkpoints never run git init on their own"
    );
}

#[tokio::test]
async fn turn_changes_report_hunks_and_revert_one_hunk() {
    let repo = Repo::new();
    let original = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
    repo.write("f.txt", original);
    repo.commit_all("init");
    let service = repo.service();
    let number = turn(&service, "s", || {
        repo.write("f.txt", "a\nB\nc\nd\ne\nf\ng\nh\nI\nj\n");
        repo.write("added.txt", "new\n");
    })
    .await;
    let changes = service.changes("s", Some(number), token()).await.unwrap();
    assert_eq!(changes.files.len(), 2);
    let file = changes.files.iter().find(|f| f.path == "f.txt").unwrap();
    assert_eq!(file.kind, CheckpointFileKind::Modified);
    assert_eq!((file.additions, file.deletions), (2, 2));
    assert_eq!(file.hunks.len(), 2);
    assert_eq!(file.hunks[1].before, "i\n");
    assert_eq!(file.hunks[1].after, "I\n");
    let revision = changes.revision.clone().unwrap();
    let report = service
        .revert_hunks(
            "s",
            &revision,
            vec![CheckpointHunkRef {
                path: "f.txt".into(),
                hunk_id: "h1".into(),
            }],
            token(),
        )
        .await
        .unwrap();
    assert!(report.conflicts.is_empty(), "{report:?}");
    assert!(report.undo_id.is_some());
    assert_eq!(
        repo.read("f.txt").unwrap(),
        "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n"
    );
    // The other hunk still applies after the first was reverted.
    let report = service
        .revert_hunks(
            "s",
            &revision,
            vec![CheckpointHunkRef {
                path: "f.txt".into(),
                hunk_id: "h0".into(),
            }],
            token(),
        )
        .await
        .unwrap();
    assert!(report.conflicts.is_empty(), "{report:?}");
    assert_eq!(repo.read("f.txt").unwrap(), original);
    // Added files revert as a whole.
    let report = service
        .revert_files("s", &revision, vec!["added.txt".into()], token())
        .await
        .unwrap();
    assert_eq!(report.reverted_files, vec!["added.txt".to_owned()]);
    assert!(repo.read("added.txt").is_none());
}

#[tokio::test]
async fn revert_refuses_a_hunk_whose_text_changed_since() {
    let repo = Repo::new();
    repo.write("f.txt", "one\ntwo\nthree\n");
    repo.commit_all("init");
    let service = repo.service();
    let number = turn(&service, "s", || repo.write("f.txt", "one\nTWO\nthree\n")).await;
    let changes = service.changes("s", Some(number), token()).await.unwrap();
    repo.write("f.txt", "one\nchanged by the user\nthree\n");
    let report = service
        .revert_hunks(
            "s",
            changes.revision.as_deref().unwrap(),
            vec![CheckpointHunkRef {
                path: "f.txt".into(),
                hunk_id: "h0".into(),
            }],
            token(),
        )
        .await
        .unwrap();
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(report.conflicts[0].hunk_id.as_deref(), Some("h0"));
    assert!(report.reverted.is_empty());
    assert!(report.undo_id.is_none());
    assert_eq!(
        repo.read("f.txt").unwrap(),
        "one\nchanged by the user\nthree\n"
    );
    // A whole-file revert refuses too.
    let report = service
        .revert_files(
            "s",
            changes.revision.as_deref().unwrap(),
            vec!["f.txt".into()],
            token(),
        )
        .await
        .unwrap();
    assert_eq!(report.conflicts.len(), 1);
}

#[tokio::test]
async fn restore_takes_a_snapshot_first_and_undo_puts_files_back_exactly() {
    let repo = Repo::new();
    repo.write("keep.txt", "keep\n");
    repo.write("f.txt", "v1\n");
    repo.commit_all("init");
    let service = repo.service();
    let first = turn(&service, "s", || {
        repo.write("f.txt", "v2\n");
        repo.write("made.txt", "agent file\n");
    })
    .await;
    turn(&service, "s", || repo.write("f.txt", "v3\n")).await;
    repo.write("user.txt", "user work after the turns\n");
    let index_before = fs::read(repo.root.join(".git/index")).unwrap();

    let report = service.restore("s", first, token()).await.unwrap();
    let undo = report.undo_id.clone().expect("undo point");
    assert_eq!(repo.read("f.txt").unwrap(), "v1\n");
    assert!(repo.read("made.txt").is_none());
    assert!(
        repo.read("user.txt").is_none(),
        "restore returns the folder to the turn's start"
    );
    assert_eq!(repo.read("keep.txt").unwrap(), "keep\n");
    let restores = git(
        &repo.root,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/span/checkpoints/s/restores",
        ],
    );
    assert_eq!(restores.lines().count(), 1);

    let undone = service.undo_restore("s", &undo, token()).await.unwrap();
    assert!(undone.skipped.is_empty(), "{undone:?}");
    assert_eq!(repo.read("f.txt").unwrap(), "v3\n");
    assert_eq!(repo.read("made.txt").unwrap(), "agent file\n");
    assert_eq!(
        repo.read("user.txt").unwrap(),
        "user work after the turns\n"
    );
    assert_eq!(
        fs::read(repo.root.join(".git/index")).unwrap(),
        index_before
    );
}

#[tokio::test]
async fn undo_leaves_files_changed_after_the_restore() {
    let repo = Repo::new();
    repo.write("f.txt", "v1\n");
    repo.commit_all("init");
    let service = repo.service();
    let first = turn(&service, "s", || repo.write("f.txt", "v2\n")).await;
    let undo = service
        .restore("s", first, token())
        .await
        .unwrap()
        .undo_id
        .unwrap();
    repo.write("f.txt", "edited after restore\n");
    let report = service.undo_restore("s", &undo, token()).await.unwrap();
    assert_eq!(report.skipped.len(), 1);
    assert_eq!(repo.read("f.txt").unwrap(), "edited after restore\n");
}

#[tokio::test]
async fn prune_keeps_the_newest_turns_and_delete_drops_the_session() {
    let repo = Repo::new();
    repo.write("f.txt", "0\n");
    repo.commit_all("init");
    let service = repo.service();
    let git_service = GitService::new(repo.root.clone()).unwrap();
    let cp_repo = git_service.repo(&token()).await.unwrap().unwrap();
    for n in 1..=5u32 {
        repo.write("f.txt", &format!("{n}\n"));
        service
            .capture("s", n, CheckpointPhase::Start, token())
            .await
            .unwrap();
    }
    prune(&git_service, &cp_repo, "s", 2, &token())
        .await
        .unwrap();
    let turns: Vec<u32> = service
        .list("s", token())
        .await
        .unwrap()
        .iter()
        .map(|t| t.turn)
        .collect();
    assert_eq!(turns, vec![4, 5]);
    service
        .capture("other", 1, CheckpointPhase::Start, token())
        .await
        .unwrap();
    service.delete_session("s", token()).await.unwrap();
    assert!(service.list("s", token()).await.unwrap().is_empty());
    assert_eq!(service.list("other", token()).await.unwrap().len(), 1);
}

#[tokio::test]
async fn identical_state_reuses_the_previous_commit_and_alias_points_at_it() {
    let repo = Repo::new();
    repo.write("f.txt", "x\n");
    repo.commit_all("init");
    let service = repo.service();
    service
        .capture("s", 1, CheckpointPhase::End, token())
        .await
        .unwrap();
    let again = service
        .capture("s", 2, CheckpointPhase::Start, token())
        .await
        .unwrap();
    assert!(
        matches!(again, CaptureOutcome::Captured { reused: true, .. }),
        "{again:?}"
    );
    assert!(service
        .alias(
            "s",
            3,
            CheckpointPhase::Start,
            1,
            CheckpointPhase::End,
            token()
        )
        .await
        .unwrap());
    let list = service.list("s", token()).await.unwrap();
    assert_eq!(list.len(), 3);
}

#[tokio::test]
async fn oversized_files_are_skipped_and_never_touched_by_restore() {
    let repo = Repo::new();
    repo.write("small.txt", "s1\n");
    repo.commit_all("init");
    let service = repo.service();
    let big = "x".repeat(usize::try_from(CHECKPOINT_MAX_FILE_BYTES).unwrap() + 1);
    let first = service.next_turn("s", token()).await.unwrap();
    service
        .capture("s", first, CheckpointPhase::Start, token())
        .await
        .unwrap();
    repo.write("small.txt", "s2\n");
    repo.write("big.bin", &big);
    let end = service
        .capture("s", first, CheckpointPhase::End, token())
        .await
        .unwrap();
    match end {
        CaptureOutcome::Captured { skipped, .. } => assert_eq!(skipped, vec!["big.bin".to_owned()]),
        other => panic!("{other:?}"),
    }
    let report = service.restore("s", first, token()).await.unwrap();
    assert_eq!(report.restored, vec!["small.txt".to_owned()]);
    assert_eq!(repo.read("big.bin").unwrap().len(), big.len());
}

#[tokio::test]
async fn workspace_in_a_subfolder_only_captures_that_folder() {
    let repo = Repo::new();
    repo.write("outside.txt", "o\n");
    repo.write("app/inside.txt", "i\n");
    repo.commit_all("init");
    let service = Checkpoints::new(GitService::new(repo.root.join("app")).unwrap());
    let number = turn(&service, "s", || {
        repo.write("app/inside.txt", "I\n");
        repo.write("outside.txt", "O\n");
    })
    .await;
    let changes = service.changes("s", Some(number), token()).await.unwrap();
    let paths: Vec<&str> = changes.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["inside.txt"]);
}

#[test]
fn session_ids_become_safe_ref_components() {
    assert_eq!(session_component("abc-123_X"), "abc-123_X");
    let odd = session_component("a/b..c");
    assert!(odd.starts_with('h') && odd.len() == 17);
    assert_eq!(odd, session_component("a/b..c"));
    assert_ne!(session_component("-x"), "-x");
}

#[test]
fn revert_in_uses_context_to_find_the_hunk() {
    let base = "a\nb\nc\n";
    let head = "a\nB\nc\n";
    let hunks = line_hunks(base, head).unwrap();
    assert_eq!(
        revert_in("z\na\nB\nc\n", base, head, &hunks, 0).unwrap(),
        "z\na\nb\nc\n"
    );
    assert!(revert_in("a\nb\nc\n", base, head, &hunks, 0).is_none());
    // Ambiguous text with no unique context is refused.
    let base = "x\n";
    let head = "y\n";
    let hunks = line_hunks(base, head).unwrap();
    assert!(revert_in("y\ny\n", base, head, &hunks, 0).is_none());
}
