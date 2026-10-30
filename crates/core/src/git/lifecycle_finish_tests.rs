use super::*;
use std::process::Command;

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args([
            "-c",
            "core.hooksPath=",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Span",
            "-c",
            "user.email=span@example.invalid",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

#[tokio::test]
async fn selected_first_push_sets_explicit_upstream_and_refuses_stale_review() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let local = root.join("local");
    let remote = root.join("remote");
    fs::create_dir(&local).unwrap();
    fs::create_dir(&remote).unwrap();
    git(&local, &["init", "-b", "main"]);
    git(&local, &["commit", "--allow-empty", "-m", "initial"]);
    git(&remote, &["init", "--bare"]);
    // A verbatim Windows path would read as an scp-style SSH host.
    let remote_source = git_path(&remote);
    git(
        &local,
        &["remote", "add", "chosen", remote_source.to_str().unwrap()],
    );
    let service = GitService::new(local.clone()).unwrap();
    let id = service
        .context(CancellationToken::default())
        .await
        .unwrap()
        .repository
        .unwrap()
        .id;
    let status = service
        .enable(&id, CancellationToken::default())
        .await
        .unwrap();
    let config = service
        .remotes(&id, CancellationToken::default())
        .await
        .unwrap()
        .config_fingerprint;
    let result = service
        .remote_selected(
            &id,
            GitRemoteAction::Push,
            "chosen",
            "published",
            &status.index_revision,
            &config,
            true,
            CancellationToken::default(),
        )
        .await
        .unwrap();
    assert!(result.remote_succeeded && result.upstream_configured);
    assert!(result.warning.is_none());
    assert_eq!(
        git(&remote, &["rev-parse", "refs/heads/published"]),
        git(&local, &["rev-parse", "HEAD"])
    );
    assert_eq!(
        git(&local, &["config", "branch.main.merge"]),
        "refs/heads/published"
    );
    assert!(service
        .remote_selected(
            &id,
            GitRemoteAction::Push,
            "chosen",
            "other",
            &status.index_revision,
            &config,
            false,
            CancellationToken::default()
        )
        .await
        .is_err());
}

#[tokio::test]
async fn standalone_clone_reserves_new_destination_and_rejects_existing() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let source = root.join("source");
    fs::create_dir(&source).unwrap();
    git(&source, &["init", "-b", "main"]);
    git(&source, &["commit", "--allow-empty", "-m", "initial"]);
    let destination = root.join("new clone");
    GitService::clone_without_workspace(
        source.to_str().unwrap(),
        destination.to_str().unwrap(),
        CancellationToken::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        git(&destination, &["rev-parse", "HEAD"]),
        git(&source, &["rev-parse", "HEAD"])
    );
    assert!(GitService::clone_without_workspace(
        source.to_str().unwrap(),
        destination.to_str().unwrap(),
        CancellationToken::default()
    )
    .await
    .is_err());
    assert!(GitService::clone_without_workspace(
        "ext::danger",
        root.join("bad").to_str().unwrap(),
        CancellationToken::default()
    )
    .await
    .is_err());
}

#[tokio::test]
async fn selected_pull_uses_target_without_upstream_and_preserves_fetch_head() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let source = root.join("source");
    fs::create_dir(&source).unwrap();
    git(&source, &["init", "-b", "main"]);
    git(&source, &["commit", "--allow-empty", "-m", "initial"]);
    let local = root.join("local");
    GitService::clone_without_workspace(
        source.to_str().unwrap(),
        local.to_str().unwrap(),
        CancellationToken::default(),
    )
    .await
    .unwrap();
    git(&local, &["config", "--unset", "branch.main.remote"]);
    git(&local, &["config", "--unset", "branch.main.merge"]);
    git(&source, &["commit", "--allow-empty", "-m", "second"]);
    fs::write(local.join(".git/FETCH_HEAD"), b"sentinel\n").unwrap();
    let service = GitService::new(local.clone()).unwrap();
    let id = service
        .context(CancellationToken::default())
        .await
        .unwrap()
        .repository
        .unwrap()
        .id;
    let status = service
        .enable(&id, CancellationToken::default())
        .await
        .unwrap();
    let config = service
        .remotes(&id, CancellationToken::default())
        .await
        .unwrap()
        .config_fingerprint;
    let result = service
        .remote_selected(
            &id,
            GitRemoteAction::Pull,
            "origin",
            "main",
            &status.index_revision,
            &config,
            false,
            CancellationToken::default(),
        )
        .await
        .unwrap();
    assert!(result.remote_succeeded);
    assert_eq!(
        git(&local, &["rev-parse", "HEAD"]),
        git(&source, &["rev-parse", "HEAD"])
    );
    assert_eq!(
        fs::read(local.join(".git/FETCH_HEAD")).unwrap(),
        b"sentinel\n"
    );
    assert!(git(
        &local,
        &["for-each-ref", "--format=%(refname)", "refs/span/pull"]
    )
    .is_empty());
}
