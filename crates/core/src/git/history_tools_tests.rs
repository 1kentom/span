use super::*;
use std::process::Command;
use tempfile::TempDir;

fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

#[tokio::test]
async fn immutable_graph_literal_search_reflog_and_revision_navigation() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    git(root, &["init", "-b", "main"]);
    git(root, &["config", "user.name", "History Test"]);
    git(root, &["config", "user.email", "history@example.invalid"]);
    git(root, &["config", "commit.gpgsign", "false"]);
    let path = "-café [literal].txt";
    fs::write(root.join(path), "one\ntwo\nthree\n").unwrap();
    git(root, &["add", "--", path]);
    git(root, &["commit", "-m", "initial [literal]"]);
    let initial = git(root, &["rev-parse", "HEAD"]);
    git(root, &["tag", "v1"]);
    git(root, &["branch", "side"]);
    fs::write(root.join(path), "one\nchanged\nthree\n").unwrap();
    git(root, &["add", "--", path]);
    git(root, &["commit", "-m", "main update"]);
    let main = git(root, &["rev-parse", "HEAD"]);
    git(root, &["checkout", "side"]);
    fs::write(root.join("side.txt"), "side\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "side update"]);
    let side = git(root, &["rev-parse", "HEAD"]);
    git(root, &["checkout", "main"]);
    let service = GitService::new(root.to_owned()).unwrap();
    let context = service.context(CancellationToken::default()).await.unwrap();
    let id = context.repository.unwrap().id;
    service
        .enable(&id, CancellationToken::default())
        .await
        .unwrap();
    let first = service
        .history_tools(
            &id,
            GitHistoryToolsQuery {
                limit: 1,
                ..Default::default()
            },
            CancellationToken::default(),
        )
        .await
        .unwrap();
    assert!(first.heads.contains(&main));
    assert!(first.heads.contains(&side));
    assert!(first
        .refs
        .iter()
        .any(|r| r.name == "refs/tags/v1" && r.commit_id == initial));
    let rest = service
        .history_tools(
            &id,
            GitHistoryToolsQuery {
                heads: first.heads.clone(),
                skip: first.next_skip.unwrap(),
                limit: 100,
                ..Default::default()
            },
            CancellationToken::default(),
        )
        .await
        .unwrap();
    let commits: Vec<_> = first.commits.iter().chain(rest.commits.iter()).collect();
    assert_eq!(commits.len(), 3);
    for commit in commits {
        if commit.id != initial {
            assert_eq!(commit.parents, vec![initial.clone()]);
        }
    }
    let search = service
        .history_tools(
            &id,
            GitHistoryToolsQuery {
                message: Some("[literal]".into()),
                author: Some("History Test".into()),
                path: Some(path.into()),
                limit: 10,
                ..Default::default()
            },
            CancellationToken::default(),
        )
        .await
        .unwrap();
    assert_eq!(search.commits.len(), 1);
    assert_eq!(search.commits[0].id, initial);
    let content = service
        .revision_content(&id, &initial, path, CancellationToken::default())
        .await
        .unwrap();
    assert_eq!(content.text.as_deref(), Some("one\ntwo\nthree\n"));
    let diff = service
        .revision_diff(
            &id,
            &initial,
            Some(&main),
            Some(path),
            CancellationToken::default(),
        )
        .await
        .unwrap();
    assert!(diff.patch.contains("+changed"));
    fs::write(root.join(path), "working\n").unwrap();
    assert!(service
        .revision_diff(&id, &main, None, Some(path), CancellationToken::default())
        .await
        .unwrap()
        .patch
        .contains("+working"));
    let lines = service
        .line_history(&id, &main, path, 2, 2, 0, 100, CancellationToken::default())
        .await
        .unwrap();
    assert!(lines.commits.iter().any(|c| c.id == main));
    assert!(service
        .line_history(&id, &main, path, 0, 2, 0, 10, CancellationToken::default())
        .await
        .is_err());
    let reflog = service
        .reflog_page(&id, 0, 1, CancellationToken::default())
        .await
        .unwrap();
    assert_eq!(reflog.entries.len(), 1);
    assert_eq!(reflog.next_skip, Some(1));
    assert!(!service
        .reflog_page(&id, 1, 100, CancellationToken::default())
        .await
        .unwrap()
        .entries
        .is_empty());
    assert!(service
        .revision_content(&id, "--help", path, CancellationToken::default())
        .await
        .is_err());
    assert_eq!(
        service
            .signing_configuration(&id, CancellationToken::default())
            .await
            .unwrap()
            .commit_signing
            .as_deref(),
        Some("false")
    );
}

#[tokio::test]
async fn default_graph_excludes_private_span_refs_and_preserves_public_refs_and_detached_head() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    git(root, &["init", "-b", "main"]);
    git(root, &["config", "user.name", "History Test"]);
    git(root, &["config", "user.email", "history@example.invalid"]);
    git(root, &["config", "commit.gpgsign", "false"]);
    fs::write(root.join("file.txt"), "base\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "public branch"]);
    let branch = git(root, &["rev-parse", "HEAD"]);
    let tree = git(root, &["rev-parse", "HEAD^{tree}"]);
    // Each ref points at an independent root commit, so no public history can
    // accidentally make a private commit reachable and mask a capture leak.
    let checkpoint = git(root, &["commit-tree", &tree, "-m", "private checkpoint"]);
    let pull = git(root, &["commit-tree", &tree, "-m", "private pull"]);
    let future_internal = git(
        root,
        &["commit-tree", &tree, "-m", "private future storage"],
    );
    git(
        root,
        &["update-ref", "refs/span/checkpoints/test", &checkpoint],
    );
    git(root, &["update-ref", "refs/span/pull/123", &pull]);
    git(
        root,
        &["update-ref", "refs/span/future/test", &future_internal],
    );
    let custom = git(root, &["commit-tree", &tree, "-m", "public custom"]);
    let stash = git(root, &["commit-tree", &tree, "-m", "ordinary stash"]);
    let remote = git(root, &["commit-tree", &tree, "-m", "public remote"]);
    let tag = git(root, &["commit-tree", &tree, "-m", "public tag"]);
    let detached = git(root, &["commit-tree", &tree, "-m", "detached head"]);
    git(root, &["update-ref", "refs/custom/review", &custom]);
    git(root, &["update-ref", "refs/stash", &stash]);
    git(root, &["update-ref", "refs/remotes/origin/review", &remote]);
    git(
        root,
        &[
            "tag",
            "-a",
            "public-tag",
            &tag,
            "-m",
            "annotated public tag",
        ],
    );
    git(root, &["checkout", "--detach", &detached]);
    let service = GitService::new(root.to_owned()).unwrap();
    let context = service.context(CancellationToken::default()).await.unwrap();
    let id = context.repository.unwrap().id;
    service
        .enable(&id, CancellationToken::default())
        .await
        .unwrap();
    let first = service
        .history_tools(
            &id,
            GitHistoryToolsQuery {
                limit: 1,
                ..Default::default()
            },
            CancellationToken::default(),
        )
        .await
        .unwrap();
    for private in [&checkpoint, &pull, &future_internal] {
        assert!(!first.heads.contains(private));
        assert!(!first.commits.iter().any(|commit| &commit.id == private));
    }
    assert!(first
        .refs
        .iter()
        .all(|decoration| !decoration.name.starts_with("refs/span/")));
    for public in [&branch, &custom, &stash, &remote, &tag, &detached] {
        assert!(first.heads.contains(public));
    }
    for (name, oid) in [
        ("refs/custom/review", &custom),
        ("refs/stash", &stash),
        ("refs/remotes/origin/review", &remote),
        ("refs/tags/public-tag", &tag),
    ] {
        assert!(first
            .refs
            .iter()
            .any(|decoration| decoration.name == name && &decoration.commit_id == oid));
    }
    let later = git(root, &["commit-tree", &tree, "-m", "public after capture"]);
    git(root, &["update-ref", "refs/custom/later", &later]);
    let rest = service
        .history_tools(
            &id,
            GitHistoryToolsQuery {
                heads: first.heads.clone(),
                skip: first.next_skip.unwrap(),
                limit: 100,
                ..Default::default()
            },
            CancellationToken::default(),
        )
        .await
        .unwrap();
    assert_eq!(rest.heads, first.heads);
    let commits: Vec<_> = first.commits.iter().chain(rest.commits.iter()).collect();
    assert_eq!(commits.len(), 6);
    for absent in [&checkpoint, &pull, &future_internal, &later] {
        assert!(!commits.iter().any(|commit| &commit.id == absent));
    }
    assert!(rest
        .refs
        .iter()
        .all(|decoration| !decoration.name.starts_with("refs/span/")));
    // Explicit immutable OIDs remain valid for focused review and page replay.
    let explicit = service
        .history_tools(
            &id,
            GitHistoryToolsQuery {
                heads: vec![checkpoint.clone()],
                limit: 100,
                ..Default::default()
            },
            CancellationToken::default(),
        )
        .await
        .unwrap();
    assert_eq!(explicit.heads, vec![checkpoint.clone()]);
    assert_eq!(explicit.commits.len(), 1);
    assert_eq!(explicit.commits[0].id, checkpoint);
    assert!(explicit
        .refs
        .iter()
        .all(|decoration| !decoration.name.starts_with("refs/span/")));
}
