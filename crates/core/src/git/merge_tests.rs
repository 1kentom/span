use super::*;
use std::process::{Command, Output};
use tempfile::TempDir;

struct Repo {
    _temp: TempDir,
    root: PathBuf,
}
impl Repo {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        fs::create_dir(&root).unwrap();
        let repo = Self { _temp: temp, root };
        repo.git(&["init", "-b", "main"]);
        repo.git(&["config", "user.name", "Span Git Test"]);
        repo.git(&["config", "user.email", "span@example.invalid"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo.git(&["config", "--local", "core.autocrlf", "false"]);
        repo.git(&["config", "--local", "core.eol", "lf"]);
        repo
    }
    fn git(&self, args: &[&str]) -> Output {
        let result = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        result
    }
    fn text(&self, args: &[&str]) -> String {
        String::from_utf8(self.git(args).stdout).unwrap()
    }
    fn write(&self, path: &str, text: &str) {
        fs::write(self.root.join(path), text).unwrap();
    }
    fn commit(&self) {
        self.git(&["add", "."]);
        self.git(&["commit", "-m", "fixture"]);
    }
    async fn service(&self) -> (GitService, GitStatus) {
        let service = GitService::new(self.root.clone()).unwrap();
        let context = service.context(CancellationToken::default()).await.unwrap();
        let status = service
            .enable(
                &context.repository.unwrap().id,
                CancellationToken::default(),
            )
            .await
            .unwrap();
        (service, status)
    }
}
fn token() -> CancellationToken {
    CancellationToken::default()
}

fn diverged() -> (Repo, String) {
    let repo = Repo::new();
    repo.write("file.txt", "base\n");
    repo.commit();
    repo.git(&["checkout", "-b", "incoming"]);
    repo.write("file.txt", "incoming\n");
    repo.commit();
    let target = repo.text(&["rev-parse", "HEAD"]).trim().to_owned();
    repo.git(&["checkout", "main"]);
    repo.write("file.txt", "local\n");
    repo.commit();
    (repo, target)
}

#[tokio::test]
async fn merge_exposes_three_stages_saves_reviewed_resolution_and_continues() {
    let (repo, target) = diverged();
    let (service, initial) = repo.service().await;
    let id = initial.repository.id.clone();
    let result = service
        .integration_start(
            &id,
            GitIntegrationKind::Merge,
            &target,
            &initial.index_revision,
            token(),
        )
        .await
        .unwrap();
    assert!(!result.completed);
    let resource = service
        .conflict_resource(
            &id,
            "file.txt",
            &result.state.status.index_revision,
            token(),
        )
        .await
        .unwrap();
    assert_eq!(resource.base.as_deref(), Some("base\n"));
    assert_eq!(resource.ours.as_deref(), Some("local\n"));
    assert_eq!(resource.theirs.as_deref(), Some("incoming\n"));
    let saved = service
        .save_conflict_resolution(
            &id,
            "file.txt",
            "resolved\n",
            &resource.state.status.index_revision,
            &resource.state.worktree_snapshot,
            token(),
        )
        .await
        .unwrap();
    assert!(service
        .save_conflict_resolution(
            &id,
            "file.txt",
            "stale\n",
            &resource.state.status.index_revision,
            &resource.state.worktree_snapshot,
            token()
        )
        .await
        .is_err());
    assert_eq!(
        fs::read_to_string(repo.root.join("file.txt")).unwrap(),
        "resolved\n"
    );
    let staged = service
        .mark_resolved(
            &id,
            "file.txt",
            &saved.status.index_revision,
            &saved.worktree_snapshot,
            token(),
        )
        .await
        .unwrap();
    let done = service
        .integration_control(
            &id,
            GitIntegrationKind::Merge,
            GitRebaseAction::Continue,
            &staged.status.index_revision,
            &staged.worktree_snapshot,
            token(),
        )
        .await
        .unwrap();
    assert!(done.completed);
}

#[tokio::test]
async fn abort_refuses_post_conflict_edits_but_accepts_unchanged_conflict() {
    let (repo, target) = diverged();
    let (service, initial) = repo.service().await;
    let id = initial.repository.id.clone();
    let result = service
        .integration_start(
            &id,
            GitIntegrationKind::Merge,
            &target,
            &initial.index_revision,
            token(),
        )
        .await
        .unwrap();
    repo.write("file.txt", "precious edit\n");
    let state = service.integration_state(&id, token()).await.unwrap();
    assert!(service
        .integration_control(
            &id,
            GitIntegrationKind::Merge,
            GitRebaseAction::Abort,
            &state.status.index_revision,
            &state.worktree_snapshot,
            token()
        )
        .await
        .is_err());
    assert_eq!(
        fs::read_to_string(repo.root.join("file.txt")).unwrap(),
        "precious edit\n"
    );
    assert!(service
        .integration_control(
            &id,
            GitIntegrationKind::Merge,
            GitRebaseAction::Abort,
            &result.state.status.index_revision,
            &result.state.worktree_snapshot,
            token()
        )
        .await
        .is_err());
    let (repo, target) = diverged();
    let (service, initial) = repo.service().await;
    let id = initial.repository.id.clone();
    let state = service
        .integration_start(
            &id,
            GitIntegrationKind::Merge,
            &target,
            &initial.index_revision,
            token(),
        )
        .await
        .unwrap()
        .state;
    assert!(
        service
            .integration_control(
                &id,
                GitIntegrationKind::Merge,
                GitRebaseAction::Abort,
                &state.status.index_revision,
                &state.worktree_snapshot,
                token()
            )
            .await
            .unwrap()
            .completed
    );
}

#[tokio::test]
async fn cherry_pick_and_revert_keep_real_conflicts() {
    for kind in [GitIntegrationKind::CherryPick, GitIntegrationKind::Revert] {
        let (repo, mut target) = diverged();
        if kind == GitIntegrationKind::Revert {
            // Reverting the incoming edit against a different local edit conflicts.
            target = repo.text(&["rev-parse", "incoming"]).trim().to_owned();
        }
        let (service, initial) = repo.service().await;
        let id = initial.repository.id.clone();
        let result = service
            .integration_start(&id, kind, &target, &initial.index_revision, token())
            .await
            .unwrap();
        assert!(!result.completed);
        assert!(result
            .state
            .status
            .entries
            .iter()
            .any(|entry| entry.conflicted));
        let done = service
            .integration_control(
                &id,
                kind,
                GitRebaseAction::Abort,
                &result.state.status.index_revision,
                &result.state.worktree_snapshot,
                token(),
            )
            .await
            .unwrap();
        assert!(done.completed);
        assert_eq!(
            fs::read_to_string(repo.root.join("file.txt")).unwrap(),
            "local\n"
        );
    }
}

#[tokio::test]
async fn integration_refuses_incoming_ignored_file() {
    let repo = Repo::new();
    repo.write(".gitignore", "local.txt\n");
    repo.write("file.txt", "base\n");
    repo.commit();
    repo.git(&["checkout", "-b", "incoming"]);
    repo.write("local.txt", "incoming\n");
    repo.git(&["add", "-f", "local.txt"]);
    repo.git(&["commit", "-m", "incoming ignored path"]);
    let target = repo.text(&["rev-parse", "HEAD"]).trim().to_owned();
    repo.git(&["checkout", "main"]);
    repo.write("local.txt", "precious ignored bytes\n");
    let (service, initial) = repo.service().await;
    assert!(service
        .integration_start(
            &initial.repository.id,
            GitIntegrationKind::Merge,
            &target,
            &initial.index_revision,
            token()
        )
        .await
        .is_err());
    assert_eq!(
        fs::read_to_string(repo.root.join("local.txt")).unwrap(),
        "precious ignored bytes\n"
    );
}

#[tokio::test]
async fn merge_commit_cherry_pick_and_revert_are_errors_without_active_operation() {
    let repo = Repo::new();
    repo.write("base.txt", "base\n");
    repo.commit();
    repo.git(&["checkout", "-b", "incoming"]);
    repo.write("incoming.txt", "incoming\n");
    repo.commit();
    repo.git(&["checkout", "main"]);
    repo.write("local.txt", "local\n");
    repo.commit();
    repo.git(&["merge", "--no-ff", "--no-edit", "incoming"]);
    let target = repo.text(&["rev-parse", "HEAD"]).trim().to_owned();
    repo.git(&["checkout", "-b", "destination", "HEAD^1"]);
    let original = repo.text(&["rev-parse", "HEAD"]);
    let (service, status) = repo.service().await;
    for kind in [GitIntegrationKind::CherryPick, GitIntegrationKind::Revert] {
        assert!(service
            .integration_start(
                &status.repository.id,
                kind,
                &target,
                &status.index_revision,
                token()
            )
            .await
            .is_err());
        assert_eq!(repo.text(&["rev-parse", "HEAD"]), original);
        let state = service
            .integration_state(&status.repository.id, token())
            .await
            .unwrap();
        assert!(state.status.operation.is_none());
        assert!(state.status.entries.is_empty());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn pre_rebase_hook_failure_without_operation_is_an_error() {
    use std::os::unix::fs::PermissionsExt;
    let (repo, target) = diverged();
    let hook = repo.root.join(".git/hooks/pre-rebase");
    fs::write(
        &hook,
        "#!/bin/sh\nprintf 'intentional pre-rebase refusal\\n' >&2\nexit 1\n",
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    repo.git(&["config", "core.hooksPath", ".git/hooks"]);
    let (service, status) = repo.service().await;
    let result = service
        .rebase(
            &status.repository.id,
            &target,
            &status.index_revision,
            token(),
        )
        .await;
    assert!(result.is_err());
    let state = service
        .integration_state(&status.repository.id, token())
        .await
        .unwrap();
    assert!(state.status.operation.is_none());
    assert!(state.status.entries.is_empty());
    assert_eq!(state.status.repository.head, status.repository.head);
}

#[tokio::test]
async fn delete_modify_conflict_is_rejected_with_external_git_guidance() {
    let repo = Repo::new();
    repo.write("file.txt", "base\n");
    repo.commit();
    repo.git(&["checkout", "-b", "incoming"]);
    repo.write("file.txt", "incoming edit\n");
    repo.commit();
    let target = repo.text(&["rev-parse", "HEAD"]).trim().to_owned();
    repo.git(&["checkout", "main"]);
    repo.git(&["rm", "file.txt"]);
    repo.commit();
    let (service, status) = repo.service().await;
    let result = service
        .integration_start(
            &status.repository.id,
            GitIntegrationKind::Merge,
            &target,
            &status.index_revision,
            token(),
        )
        .await
        .unwrap();
    assert!(!result.completed);
    let error = service
        .conflict_resource(
            &status.repository.id,
            "file.txt",
            &result.state.status.index_revision,
            token(),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("external Git"));
    assert_eq!(
        fs::read_to_string(repo.root.join("file.txt")).unwrap(),
        "incoming edit\n"
    );
}
