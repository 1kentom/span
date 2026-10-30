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
