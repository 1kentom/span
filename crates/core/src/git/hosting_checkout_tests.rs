use super::*;
use std::process::Command;

struct PullRequestFixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    source: PathBuf,
    head: String,
}
fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "core.hooksPath=", "-c", "core.fsmonitor=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        if args.first() == Some(&"init") {
        git(root, &["config", "--local", "core.autocrlf", "false"]);
        git(root, &["config", "--local", "core.eol", "lf"]);
    }
    String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim_end().into()
}
impl PullRequestFixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let source = temp.path().join("source.git");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&source).unwrap();
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "user.name", "Span Git Test"]);
        git(&root, &["config", "user.email", "span@example.invalid"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        fs::write(root.join("file.txt"), "base\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "base"]);
        git(&root, &["checkout", "-b", "incoming"]);
        fs::write(root.join("file.txt"), "pull request\n").unwrap();
        fs::write(root.join("incoming.txt"), "incoming\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "incoming"]);
        let head = git(&root, &["rev-parse", "HEAD"]);
        git(&source, &["init", "--bare"]);
        git(
            &root,
            &["push", source.to_str().unwrap(), "HEAD:refs/pull/7/head"],
        );
        git(&root, &["checkout", "main"]);
        git(
            &root,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/span-fixture/editor.git",
            ],
        );
        Self {
            _temp: temp,
            root,
            source,
            head,
        }
    }
    async fn service(&self) -> (GitService, GitStatus, String) {
        let service = GitService::new(self.root.clone()).unwrap();
        let context = service.context(CancellationToken::default()).await.unwrap();
        let id = context.repository.unwrap().id;
        let status = service
            .enable(&id, CancellationToken::default())
            .await
            .unwrap();
        let config = service
            .remotes(&id, CancellationToken::default())
            .await
            .unwrap()
            .config_fingerprint;
        (service, status, config)
    }
    fn assert_private_refs_clean(&self) {
        assert_eq!(
            git(&self.root, &["for-each-ref", "refs/span/github-pr/"]),
            ""
        );
    }
}

#[tokio::test]
async fn pr_checkout_fetches_exact_head_creates_new_branch_and_cleans_private_ref() {
    let fixture = PullRequestFixture::new();
    let (service, status, config) = fixture.service().await;
    let result = service
        .checkout_pull_request_fixture(
            &status.repository.id,
            fixture.source.to_str().unwrap(),
            7,
            &fixture.head,
            "review/pr-7",
            &status.index_revision,
            &config,
        )
        .await
        .unwrap();
    assert_eq!(
        result.status.repository.head.as_deref(),
        Some(fixture.head.as_str())
    );
    assert_eq!(
        result.status.repository.branch.as_deref(),
        Some("review/pr-7")
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("file.txt")).unwrap(),
        "pull request\n"
    );
    fixture.assert_private_refs_clean();
}

#[tokio::test]
async fn changed_pr_head_preserves_branch_and_files_and_cleans_private_ref() {
    let fixture = PullRequestFixture::new();
    let (service, status, config) = fixture.service().await;
    let old = status.repository.head.as_deref().unwrap();
    assert!(service
        .checkout_pull_request_fixture(
            &status.repository.id,
            fixture.source.to_str().unwrap(),
            7,
            old,
            "review/pr-7",
            &status.index_revision,
            &config
        )
        .await
        .is_err());
    assert_eq!(git(&fixture.root, &["branch", "--show-current"]), "main");
    assert_eq!(
        fs::read_to_string(fixture.root.join("file.txt")).unwrap(),
        "base\n"
    );
    fixture.assert_private_refs_clean();
}

#[tokio::test]
async fn pr_checkout_refuses_dirty_stale_existing_branch_and_ignored_target() {
    let fixture = PullRequestFixture::new();
    let (service, status, config) = fixture.service().await;
    let id = &status.repository.id;
    git(&fixture.root, &["branch", "existing"]);
    assert!(service
        .checkout_pull_request_fixture(
            id,
            fixture.source.to_str().unwrap(),
            7,
            &fixture.head,
            "existing",
            &status.index_revision,
            &config
        )
        .await
        .is_err());
    assert!(service
        .checkout_pull_request_fixture(
            id,
            fixture.source.to_str().unwrap(),
            7,
            &fixture.head,
            "fresh",
            "stale-index",
            &config
        )
        .await
        .is_err());
    assert!(service
        .checkout_pull_request_fixture(
            id,
            fixture.source.to_str().unwrap(),
            7,
            &fixture.head,
            "fresh",
            &status.index_revision,
            "stale-config"
        )
        .await
        .is_err());
    fs::write(fixture.root.join("file.txt"), "precious dirty bytes\n").unwrap();
    assert!(service
        .checkout_pull_request_fixture(
            id,
            fixture.source.to_str().unwrap(),
            7,
            &fixture.head,
            "fresh",
            &status.index_revision,
            &config
        )
        .await
        .is_err());
    assert_eq!(
        fs::read_to_string(fixture.root.join("file.txt")).unwrap(),
        "precious dirty bytes\n"
    );
    fs::write(fixture.root.join("file.txt"), "base\n").unwrap();
    fs::write(fixture.root.join(".git/info/exclude"), "incoming.txt\n").unwrap();
    fs::write(
        fixture.root.join("incoming.txt"),
        "precious ignored bytes\n",
    )
    .unwrap();
    assert!(service
        .checkout_pull_request_fixture(
            id,
            fixture.source.to_str().unwrap(),
            7,
            &fixture.head,
            "fresh",
            &status.index_revision,
            &config
        )
        .await
        .is_err());
    assert_eq!(
        fs::read_to_string(fixture.root.join("incoming.txt")).unwrap(),
        "precious ignored bytes\n"
    );
    assert_eq!(git(&fixture.root, &["branch", "--show-current"]), "main");
    fixture.assert_private_refs_clean();
}

#[tokio::test]
async fn production_pr_checkout_rejects_non_github_and_rewritten_remote() {
    let fixture = PullRequestFixture::new();
    git(
        &fixture.root,
        &[
            "remote",
            "set-url",
            "origin",
            fixture.source.to_str().unwrap(),
        ],
    );
    let (service, status, config) = fixture.service().await;
    assert!(service
        .checkout_pull_request(
            &status.repository.id,
            "origin",
            7,
            &fixture.head,
            "review/pr-7",
            &status.index_revision,
            &config,
            CancellationToken::default()
        )
        .await
        .is_err());
    git(
        &fixture.root,
        &[
            "remote",
            "set-url",
            "origin",
            "https://github.com/span-fixture/editor.git",
        ],
    );
    git(
        &fixture.root,
        &[
            "config",
            &format!("url.{}.insteadOf", fixture.source.display()),
            "https://github.com/span-fixture/editor.git",
        ],
    );
    let config = service
        .remotes(&status.repository.id, CancellationToken::default())
        .await
        .unwrap()
        .config_fingerprint;
    assert!(service
        .checkout_pull_request(
            &status.repository.id,
            "origin",
            7,
            &fixture.head,
            "review/pr-7",
            &status.index_revision,
            &config,
            CancellationToken::default()
        )
        .await
        .is_err());
    assert_eq!(git(&fixture.root, &["branch", "--show-current"]), "main");
    fixture.assert_private_refs_clean();
}
