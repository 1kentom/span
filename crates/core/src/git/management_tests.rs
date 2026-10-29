use super::*;
use std::process::Command;

fn run(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(root)
        .args(["-c", "core.hooksPath=", "-c", "core.fsmonitor=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    if args.first() == Some(&"init") {
        run(root, &["config", "--local", "core.autocrlf", "false"]);
        run(root, &["config", "--local", "core.eol", "lf"]);
    }
    String::from_utf8_lossy(&out.stdout)
        .trim_end_matches(['\r', '\n'])
        .into()
}

#[tokio::test]
async fn initialize_exact_workspace_and_refuse_parent_repository() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let service = GitService::new(root.clone()).unwrap();
    let context = service
        .initialize_repository(CancellationToken::default())
        .await
        .unwrap();
    assert!(context.repository.is_some());
    assert!(!context.enabled);
    assert!(service
        .initialize_repository(CancellationToken::default())
        .await
        .is_err());
    let child = root.join("child");
    fs::create_dir(&child).unwrap();
    let nested = GitService::new(child.clone()).unwrap();
    assert!(nested
        .initialize_repository(CancellationToken::default())
        .await
        .is_err());
    assert!(!child.join(".git").exists());
}

#[tokio::test]
async fn clone_local_repository_preserves_existing_destination() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let workspace = base.join("workspace");
    let source = base.join("source");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(&source).unwrap();
    run(&source, &["init", "-b", "main"]);
    let service = GitService::new(workspace).unwrap();
    let target = base.join("clone with spaces");
    let result = service
        .clone_repository(
            source.to_str().unwrap(),
            target.to_str().unwrap(),
            CancellationToken::default(),
        )
        .await
        .unwrap();
    assert_eq!(Path::new(&result.path), target);
    fs::write(target.join("keep"), b"retained").unwrap();
    assert!(service
        .clone_repository(
            source.to_str().unwrap(),
            target.to_str().unwrap(),
            CancellationToken::default()
        )
        .await
        .is_err());
    assert_eq!(fs::read(target.join("keep")).unwrap(), b"retained");
    assert!(service
        .clone_repository(
            "ext::sh danger",
            base.join("bad").to_str().unwrap(),
            CancellationToken::default()
        )
        .await
        .is_err());
}

#[tokio::test]
async fn remote_config_and_branch_management_require_current_review() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    run(&root, &["init", "-b", "main"]);
    run(
        &root,
        &[
            "-c",
            "user.name=Span",
            "-c",
            "user.email=span@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        ],
    );
    run(&root, &["branch", "topic"]);
    let service = GitService::new(root.clone()).unwrap();
    let context = service.context(CancellationToken::default()).await.unwrap();
    let id = context.repository.unwrap().id;
    service
        .enable(&id, CancellationToken::default())
        .await
        .unwrap();
    let remotes = service
        .remotes(&id, CancellationToken::default())
        .await
        .unwrap();
    let added = service
        .configure_remote(
            &id,
            GitRemoteConfigAction::Add,
            "origin",
            Some(root.to_str().unwrap()),
            &remotes.config_fingerprint,
            CancellationToken::default(),
        )
        .await
        .unwrap();
    assert_eq!(added.remotes.len(), 1);
    assert!(service
        .configure_remote(
            &id,
            GitRemoteConfigAction::Remove,
            "origin",
            None,
            &remotes.config_fingerprint,
            CancellationToken::default()
        )
        .await
        .is_err());
    let oid = run(&root, &["rev-parse", "HEAD"]);
    assert!(service
        .manage_branch(
            &id,
            GitBranchManagementAction::Delete,
            "main",
            None,
            &oid,
            Some(&oid),
            &added.config_fingerprint,
            CancellationToken::default()
        )
        .await
        .is_err());
    service
        .manage_branch(
            &id,
            GitBranchManagementAction::Rename,
            "topic",
            Some("renamed"),
            &oid,
            Some(&oid),
            &added.config_fingerprint,
            CancellationToken::default(),
        )
        .await
        .unwrap();
    assert_eq!(run(&root, &["rev-parse", "refs/heads/renamed"]), oid);
}

#[tokio::test]
async fn worktree_creation_lock_and_prune_bind_reviewed_state() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let root = base.join("root");
    fs::create_dir(&root).unwrap();
    run(&root, &["init", "-b", "main"]);
    run(
        &root,
        &[
            "-c",
            "user.name=Span",
            "-c",
            "user.email=span@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        ],
    );
    let service = GitService::new(root.clone()).unwrap();
    let id = service
        .context(CancellationToken::default())
        .await
        .unwrap()
        .repository
        .unwrap()
        .id;
    service
        .enable(&id, CancellationToken::default())
        .await
        .unwrap();
    let oid = run(&root, &["rev-parse", "HEAD"]);
    let target = base.join("linked");
    service
        .worktree_create(
            &id,
            target.to_str().unwrap(),
            GitWorktreeCreateMode::NewBranch,
            Some("linked"),
            &oid,
            CancellationToken::default(),
        )
        .await
        .unwrap();
    let review = service
        .worktree_prune_review(&id, CancellationToken::default())
        .await
        .unwrap();
    service
        .worktree_set_locked(
            &id,
            target.to_str().unwrap(),
            true,
            &review.snapshot,
            CancellationToken::default(),
        )
        .await
        .unwrap();
    assert!(service
        .worktree_prune(&id, &review.snapshot, CancellationToken::default())
        .await
        .is_err());
    let locked = service
        .worktree_prune_review(&id, CancellationToken::default())
        .await
        .unwrap();
    service
        .worktree_set_locked(
            &id,
            target.to_str().unwrap(),
            false,
            &locked.snapshot,
            CancellationToken::default(),
        )
        .await
        .unwrap();
    fs::remove_dir_all(&target).unwrap();
    let prune = service
        .worktree_prune_review(&id, CancellationToken::default())
        .await
        .unwrap();
    assert!(!prune.output.is_empty());
    service
        .worktree_prune(&id, &prune.snapshot, CancellationToken::default())
        .await
        .unwrap();
    assert_eq!(
        service
            .worktrees(&id, CancellationToken::default())
            .await
            .unwrap()
            .len(),
        1
    );
}
