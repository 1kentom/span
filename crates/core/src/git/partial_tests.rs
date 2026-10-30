use super::*;
use std::process::Command;

struct Fixture(tempfile::TempDir);
impl Fixture {
    fn new(old: Option<&str>, new: Option<&str>, path: &str) -> Self {
        let f = Self(tempfile::tempdir().unwrap());
        f.git(&["init", "-b", "main"]);
        f.git(&["config", "user.name", "Test"]);
        f.git(&["config", "user.email", "test@example.invalid"]);
        f.git(&["config", "commit.gpgsign", "false"]);
        f.git(&["config", "core.autocrlf", "false"]);
        f.write("unrelated", "preserve\n");
        if let Some(old) = old {
            f.write(path, old);
        }
        f.git(&["add", "."]);
        f.git(&["commit", "-m", "base"]);
        if let Some(new) = new {
            f.write(path, new);
        } else {
            fs::remove_file(f.0.path().join(path)).unwrap();
        }
        f
    }
    fn git(&self, args: &[&str]) -> Vec<u8> {
        let out = Command::new("git")
            .arg("-C")
            .arg(self.0.path())
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        out.stdout
    }
    fn write(&self, path: &str, text: &str) {
        fs::write(self.0.path().join(path), text).unwrap();
    }
    async fn service(&self) -> (GitService, GitStatus) {
        let svc = GitService::new(self.0.path().into()).unwrap();
        let ctx = svc.context(CancellationToken::default()).await.unwrap();
        let status = svc
            .enable(&ctx.repository.unwrap().id, CancellationToken::default())
            .await
            .unwrap();
        (svc, status)
    }
}

#[tokio::test]
async fn selected_lines_preserve_disk_and_other_index_entries() {
    for (old, new, kind, value, expected) in [
        (
            Some("a\nb\nc\n"),
            Some("a\nb\nx\ny\nc\n"),
            "insert",
            "x\n",
            "a\nb\nx\nc\n",
        ),
        (Some("a\nb\nc\n"), Some("a\n"), "delete", "b\n", "a\nc\n"),
        (
            Some("old\nend\n"),
            Some("new\nend\n"),
            "insert",
            "new\n",
            "old\nnew\nend\n",
        ),
        (None, Some("one\ntwo\n"), "insert", "two\n", "two\n"),
        (Some("one\ntwo\n"), None, "delete", "two\n", "one\n"),
        (
            Some("a\r\nb"),
            Some("a\r\nb\r\nc"),
            "insert",
            "c",
            "a\r\nbc",
        ),
    ] {
        let f = Fixture::new(old, new, "file");
        let (svc, status) = f.service().await;
        let before_other = f.git(&["ls-files", "--stage", "--", "unrelated"]);
        let review = svc
            .review_lines(
                &status.repository.id,
                "file",
                GitDiffSide::Working,
                &status.index_revision,
                CancellationToken::default(),
            )
            .await
            .unwrap();
        let row = review
            .hunks
            .iter()
            .flat_map(|h| &h.lines)
            .find(|r| r.kind == kind && r.text == value)
            .unwrap();
        let after = svc
            .apply_lines(
                &status.repository.id,
                "file",
                GitDiffSide::Working,
                std::slice::from_ref(&row.id),
                &status.index_revision,
                &review.worktree_snapshot,
                false,
                CancellationToken::default(),
            )
            .await
            .unwrap();
        assert_eq!(f.git(&["show", ":file"]), expected.as_bytes());
        assert_eq!(
            f.git(&["ls-files", "--stage", "--", "unrelated"]),
            before_other
        );
        assert_eq!(
            fs::read(f.0.path().join("file")).ok(),
            new.map(|s| s.as_bytes().to_vec())
        );
        // Reverse precisely the staged row, leaving the working bytes unchanged.
        let reverse = svc
            .review_lines(
                &after.repository.id,
                "file",
                GitDiffSide::Staged,
                &after.index_revision,
                CancellationToken::default(),
            )
            .await
            .unwrap();
        let ids: Vec<_> = reverse
            .hunks
            .iter()
            .flat_map(|h| &h.lines)
            .filter(|r| !r.id.is_empty())
            .map(|r| r.id.clone())
            .collect();
        svc.apply_lines(
            &after.repository.id,
            "file",
            GitDiffSide::Staged,
            &ids,
            &after.index_revision,
            &reverse.worktree_snapshot,
            old.is_none(),
            CancellationToken::default(),
        )
        .await
        .unwrap();
        if let Some(old) = old {
            assert_eq!(f.git(&["show", ":file"]), old.as_bytes());
        }
        assert_eq!(
            fs::read(f.0.path().join("file")).ok(),
            new.map(|s| s.as_bytes().to_vec())
        );
    }
}

#[tokio::test]
async fn stale_reviews_and_foreign_ids_never_mutate_the_index() {
    let f = Fixture::new(Some("a\n"), Some("b\n"), "file");
    let (svc, status) = f.service().await;
    let review = svc
        .review_lines(
            &status.repository.id,
            "file",
            GitDiffSide::Working,
            &status.index_revision,
            CancellationToken::default(),
        )
        .await
        .unwrap();
    let ids = vec![review.hunks[0]
        .lines
        .iter()
        .find(|r| !r.id.is_empty())
        .unwrap()
        .id
        .clone()];
    let before = f.git(&["ls-files", "--stage"]);
    f.write("file", "changed again\n");
    assert!(svc
        .apply_lines(
            &status.repository.id,
            "file",
            GitDiffSide::Working,
            &ids,
            &status.index_revision,
            &review.worktree_snapshot,
            false,
            CancellationToken::default()
        )
        .await
        .is_err());
    assert_eq!(f.git(&["ls-files", "--stage"]), before);
    f.write("file", "b\n");
    f.write("unrelated", "staged\n");
    f.git(&["add", "unrelated"]);
    let before = f.git(&["ls-files", "--stage"]);
    assert!(svc
        .apply_lines(
            &status.repository.id,
            "file",
            GitDiffSide::Working,
            &ids,
            &status.index_revision,
            &review.worktree_snapshot,
            false,
            CancellationToken::default()
        )
        .await
        .is_err());
    assert_eq!(f.git(&["ls-files", "--stage"]), before);
}

#[tokio::test]
async fn literal_paths_and_diff_prefixes_cannot_stage_another_file() {
    for path in ["literal file\".txt", ":(glob)*", "--option"] {
        let f = Fixture::new(Some("a\n"), Some("b\n"), path);
        f.git(&["config", "diff.noprefix", "true"]);
        f.git(&["config", "diff.mnemonicprefix", "true"]);
        f.git(&["config", "diff.srcPrefix", "unrelated/"]);
        let (svc, status) = f.service().await;
        let review = svc
            .review_lines(
                &status.repository.id,
                path,
                GitDiffSide::Working,
                &status.index_revision,
                CancellationToken::default(),
            )
            .await
            .unwrap();
        let ids = review
            .hunks
            .iter()
            .flat_map(|h| &h.lines)
            .filter(|r| !r.id.is_empty())
            .map(|r| r.id.clone())
            .collect::<Vec<_>>();
        let before = f.git(&["ls-files", "--stage", "--", "unrelated"]);
        svc.apply_lines(
            &status.repository.id,
            path,
            GitDiffSide::Working,
            &ids,
            &status.index_revision,
            &review.worktree_snapshot,
            false,
            CancellationToken::default(),
        )
        .await
        .unwrap();
        assert_eq!(f.git(&["ls-files", "--stage", "--", "unrelated"]), before);
    }
}

#[tokio::test]
async fn independent_hunks_and_missing_final_newline_are_exact() {
    let old: String = (1..=40).map(|i| format!("line {i}\n")).collect();
    let new = old
        .replace("line 2\n", "early\n")
        .replace("line 38\n", "late\n");
    let f = Fixture::new(Some(&old), Some(&new), "file");
    let (svc, status) = f.service().await;
    let review = svc
        .review_lines(
            &status.repository.id,
            "file",
            GitDiffSide::Working,
            &status.index_revision,
            CancellationToken::default(),
        )
        .await
        .unwrap();
    assert_eq!(review.hunks.len(), 2);
    let ids = review.hunks[1]
        .lines
        .iter()
        .filter(|r| !r.id.is_empty())
        .map(|r| r.id.clone())
        .collect::<Vec<_>>();
    svc.apply_lines(
        &status.repository.id,
        "file",
        GitDiffSide::Working,
        &ids,
        &status.index_revision,
        &review.worktree_snapshot,
        false,
        CancellationToken::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        f.git(&["show", ":file"]),
        old.replace("line 38\n", "late\n").as_bytes()
    );
    assert_eq!(fs::read(f.0.path().join("file")).unwrap(), new.as_bytes());
    let f = Fixture::new(Some("before"), Some("after"), "file");
    let (svc, status) = f.service().await;
    let review = svc
        .review_lines(
            &status.repository.id,
            "file",
            GitDiffSide::Working,
            &status.index_revision,
            CancellationToken::default(),
        )
        .await
        .unwrap();
    let ids = review
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter(|r| !r.id.is_empty())
        .map(|r| r.id.clone())
        .collect::<Vec<_>>();
    svc.apply_lines(
        &status.repository.id,
        "file",
        GitDiffSide::Working,
        &ids,
        &status.index_revision,
        &review.worktree_snapshot,
        false,
        CancellationToken::default(),
    )
    .await
    .unwrap();
    assert_eq!(f.git(&["show", ":file"]), b"after");
}

#[tokio::test]
async fn complete_deletion_requires_explicit_metadata_and_cancellation_is_early() {
    let f = Fixture::new(Some("one\ntwo\n"), None, "file");
    let (svc, status) = f.service().await;
    let review = svc
        .review_lines(
            &status.repository.id,
            "file",
            GitDiffSide::Working,
            &status.index_revision,
            CancellationToken::default(),
        )
        .await
        .unwrap();
    let ids = review
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter(|r| !r.id.is_empty())
        .map(|r| r.id.clone())
        .collect::<Vec<_>>();
    let before = f.git(&["ls-files", "--stage"]);
    let cancelled = CancellationToken::default();
    cancelled.cancel();
    assert!(svc
        .apply_lines(
            &status.repository.id,
            "file",
            GitDiffSide::Working,
            &ids,
            &status.index_revision,
            &review.worktree_snapshot,
            true,
            cancelled
        )
        .await
        .is_err());
    assert_eq!(f.git(&["ls-files", "--stage"]), before);
    assert!(svc
        .apply_lines(
            &status.repository.id,
            "file",
            GitDiffSide::Working,
            &ids[..1],
            &status.index_revision,
            &review.worktree_snapshot,
            true,
            CancellationToken::default()
        )
        .await
        .is_err());
    assert_eq!(f.git(&["ls-files", "--stage"]), before);
    svc.apply_lines(
        &status.repository.id,
        "file",
        GitDiffSide::Working,
        &ids,
        &status.index_revision,
        &review.worktree_snapshot,
        true,
        CancellationToken::default(),
    )
    .await
    .unwrap();
    assert!(f.git(&["ls-files", "--", "file"]).is_empty());
    assert!(!f.0.path().join("file").exists());
}

#[tokio::test]
async fn staged_rename_can_reverse_text_and_whole_rename_metadata_together() {
    let f = Fixture::new(Some("one\ntwo\nthree\n"), Some("one\ntwo\nthree\n"), "file");
    f.git(&["mv", "file", "renamed"]);
    f.write("renamed", "one\nTWO\nthree\n");
    f.git(&["add", "renamed"]);
    let (svc, status) = f.service().await;
    let review = svc
        .review_lines(
            &status.repository.id,
            "renamed",
            GitDiffSide::Staged,
            &status.index_revision,
            CancellationToken::default(),
        )
        .await
        .unwrap();
    assert_eq!(review.diff.old_path.as_deref(), Some("file"));
    assert!(!review.metadata.is_empty());
    let ids = review
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter(|r| !r.id.is_empty())
        .map(|r| r.id.clone())
        .collect::<Vec<_>>();
    svc.apply_lines(
        &status.repository.id,
        "renamed",
        GitDiffSide::Staged,
        &ids,
        &status.index_revision,
        &review.worktree_snapshot,
        true,
        CancellationToken::default(),
    )
    .await
    .unwrap();
    assert!(f.git(&["ls-files", "--", "renamed"]).is_empty());
    assert_eq!(f.git(&["show", ":file"]), b"one\ntwo\nthree\n");
    assert_eq!(
        fs::read(f.0.path().join("renamed")).unwrap(),
        b"one\nTWO\nthree\n"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn mode_metadata_is_explicit_and_can_be_selected_without_text() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new(Some("one\ntwo\n"), Some("one\nTWO\n"), "file");
    f.git(&["config", "core.filemode", "true"]);
    fs::set_permissions(f.0.path().join("file"), fs::Permissions::from_mode(0o755)).unwrap();
    let (svc, status) = f.service().await;
    let review = svc
        .review_lines(
            &status.repository.id,
            "file",
            GitDiffSide::Working,
            &status.index_revision,
            CancellationToken::default(),
        )
        .await
        .unwrap();
    assert!(review.metadata.iter().any(|m| m.contains("100755")));
    let after = svc
        .apply_lines(
            &status.repository.id,
            "file",
            GitDiffSide::Working,
            &[],
            &status.index_revision,
            &review.worktree_snapshot,
            true,
            CancellationToken::default(),
        )
        .await
        .unwrap();
    assert_eq!(f.git(&["show", ":file"]), b"one\ntwo\n");
    assert!(
        String::from_utf8(f.git(&["ls-files", "--stage", "--", "file"]))
            .unwrap()
            .starts_with("100755 ")
    );
    let review = svc
        .review_lines(
            &after.repository.id,
            "file",
            GitDiffSide::Working,
            &after.index_revision,
            CancellationToken::default(),
        )
        .await
        .unwrap();
    let before = f.git(&["ls-files", "--stage"]);
    assert!(svc
        .apply_lines(
            &after.repository.id,
            "file",
            GitDiffSide::Working,
            &["client-patch-or-foreign-id".into()],
            &after.index_revision,
            &review.worktree_snapshot,
            false,
            CancellationToken::default()
        )
        .await
        .is_err());
    let id = review
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .find(|r| !r.id.is_empty())
        .unwrap()
        .id
        .clone();
    assert!(svc
        .apply_lines(
            &after.repository.id,
            "file",
            GitDiffSide::Working,
            &[id.clone(), id],
            &after.index_revision,
            &review.worktree_snapshot,
            false,
            CancellationToken::default()
        )
        .await
        .is_err());
    assert_eq!(f.git(&["ls-files", "--stage"]), before);
    assert_eq!(fs::read(f.0.path().join("file")).unwrap(), b"one\nTWO\n");
}

#[tokio::test]
async fn partial_review_uses_git_add_conversion_and_preserves_crlf_disk_bytes() {
    for conversion in ["autocrlf", "attributes", "clean-filter"] {
        let f = Fixture::new(Some("one\ntwo\n"), Some("one\ntwo\n"), "file");
        match conversion {
            "autocrlf" => {
                f.git(&["config", "core.autocrlf", "true"]);
            }
            "attributes" => f.write(".gitattributes", "file text eol=lf\n"),
            _ => {
                // Deliberately non-idempotent: a second clean pass is observable.
                f.git(&["config", "filter.span-test.clean", "sed 's/^/C:/'"]);
                f.git(&["config", "filter.span-test.required", "true"]);
                f.write(".gitattributes", "file filter=span-test\n");
            }
        }
        f.git(&["add", "."]);
        f.git(&["commit", "--allow-empty", "-m", "conversion baseline"]);
        let working = if conversion == "clean-filter" {
            "one\nTWO\nTHREE\n"
        } else {
            "one\r\nTWO\r\nTHREE\r\n"
        };
        f.write("file", working);
        let (svc, status) = f.service().await;
        let review = svc
            .review_lines(
                &status.repository.id,
                "file",
                GitDiffSide::Working,
                &status.index_revision,
                CancellationToken::default(),
            )
            .await
            .unwrap();
        assert!(review
            .diff
            .summary
            .as_deref()
            .unwrap()
            .contains("Index normalized saved text"));
        let third = if conversion == "clean-filter" {
            "C:THREE\n"
        } else {
            "THREE\n"
        };
        let selected = review
            .hunks
            .iter()
            .flat_map(|h| &h.lines)
            .find(|r| r.kind == "insert" && r.text == third)
            .unwrap()
            .id
            .clone();
        let after = svc
            .apply_lines(
                &status.repository.id,
                "file",
                GitDiffSide::Working,
                &[selected],
                &status.index_revision,
                &review.worktree_snapshot,
                false,
                CancellationToken::default(),
            )
            .await
            .unwrap();
        let expected_subset = if conversion == "clean-filter" {
            "C:one\nC:two\nC:THREE\n"
        } else {
            "one\ntwo\nTHREE\n"
        };
        assert_eq!(
            f.git(&["show", ":file"]),
            expected_subset.as_bytes(),
            "{conversion}"
        );
        assert_eq!(
            fs::read(f.0.path().join("file")).unwrap(),
            working.as_bytes()
        );
        let review = svc
            .review_lines(
                &after.repository.id,
                "file",
                GitDiffSide::Working,
                &after.index_revision,
                CancellationToken::default(),
            )
            .await
            .unwrap();
        let all = review
            .hunks
            .iter()
            .flat_map(|h| &h.lines)
            .filter(|r| !r.id.is_empty())
            .map(|r| r.id.clone())
            .collect::<Vec<_>>();
        svc.apply_lines(
            &after.repository.id,
            "file",
            GitDiffSide::Working,
            &all,
            &after.index_revision,
            &review.worktree_snapshot,
            false,
            CancellationToken::default(),
        )
        .await
        .unwrap();
        let actual = f.git(&["show", ":file"]);
        f.git(&["add", "--", "file"]);
        assert_eq!(
            actual,
            f.git(&["show", ":file"]),
            "partial all must equal git add for {conversion}"
        );
        assert_eq!(
            fs::read(f.0.path().join("file")).unwrap(),
            working.as_bytes()
        );
    }
}

#[tokio::test]
async fn conversion_config_and_attributes_are_bound_to_line_review() {
    for changed in ["config", "attributes"] {
        let f = Fixture::new(Some("one\ntwo\n"), Some("one\nTWO\n"), "file");
        let (svc, status) = f.service().await;
        let review = svc
            .review_lines(
                &status.repository.id,
                "file",
                GitDiffSide::Working,
                &status.index_revision,
                CancellationToken::default(),
            )
            .await
            .unwrap();
        let all = review
            .hunks
            .iter()
            .flat_map(|h| &h.lines)
            .filter(|r| !r.id.is_empty())
            .map(|r| r.id.clone())
            .collect::<Vec<_>>();
        let before = f.git(&["ls-files", "--stage"]);
        if changed == "config" {
            f.git(&["config", "core.autocrlf", "true"]);
        } else {
            f.write(".gitattributes", "file text eol=lf\n");
        }
        assert!(svc
            .apply_lines(
                &status.repository.id,
                "file",
                GitDiffSide::Working,
                &all,
                &status.index_revision,
                &review.worktree_snapshot,
                false,
                CancellationToken::default()
            )
            .await
            .is_err());
        assert_eq!(f.git(&["ls-files", "--stage"]), before);
        assert_eq!(fs::read(f.0.path().join("file")).unwrap(), b"one\nTWO\n");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn executable_modes_match_git_add_and_unstage_for_effective_filemode() {
    use std::os::unix::fs::PermissionsExt;
    for trust in [false, true] {
        for original_mode in [None, Some("100644"), Some("100755")] {
            // Include group-only, other-only and owner-only executable bits.
            for disk_mode in [0o644, 0o755, 0o654, 0o645, 0o744] {
                let original = original_mode.map(|_| "before\n");
                let f = Fixture::new(original, Some("before\n"), "file");
                if original_mode == Some("100755") {
                    f.git(&["update-index", "--chmod=+x", "--", "file"]);
                    f.git(&["commit", "-m", "executable baseline"]);
                }
                f.git(&[
                    "config",
                    "core.filemode",
                    if trust { "true" } else { "false" },
                ]);
                f.write("file", "after\n");
                fs::set_permissions(
                    f.0.path().join("file"),
                    fs::Permissions::from_mode(disk_mode),
                )
                .unwrap();
                let (svc, status) = f.service().await;
                let review = svc
                    .review_lines(
                        &status.repository.id,
                        "file",
                        GitDiffSide::Working,
                        &status.index_revision,
                        CancellationToken::default(),
                    )
                    .await
                    .unwrap();
                let ids = review
                    .hunks
                    .iter()
                    .flat_map(|h| &h.lines)
                    .filter(|r| !r.id.is_empty())
                    .map(|r| r.id.clone())
                    .collect::<Vec<_>>();
                let after = svc
                    .apply_lines(
                        &status.repository.id,
                        "file",
                        GitDiffSide::Working,
                        &ids,
                        &status.index_revision,
                        &review.worktree_snapshot,
                        true,
                        CancellationToken::default(),
                    )
                    .await
                    .unwrap();
                let actual = f.git(&["ls-files", "--stage", "--", "file"]);
                f.git(&["add", "--", "file"]);
                assert_eq!(
                    actual,
                    f.git(&["ls-files", "--stage", "--", "file"]),
                    "stage: filemode={trust}, original={original_mode:?}, disk={disk_mode:o}"
                );
                assert_eq!(fs::read(f.0.path().join("file")).unwrap(), b"after\n");
                assert_eq!(
                    fs::metadata(f.0.path().join("file"))
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    disk_mode
                );
                f.git(&["restore", "--staged", "--source=HEAD", "--", "file"]);
                let expected_unstaged = f.git(&["ls-files", "--stage", "--", "file"]);
                f.git(&["add", "--", "file"]);
                // Git add may refresh index stat data, so acquire a fresh review.
                let status = svc
                    .status(&after.repository.id, CancellationToken::default())
                    .await
                    .unwrap();
                let review = svc
                    .review_lines(
                        &status.repository.id,
                        "file",
                        GitDiffSide::Staged,
                        &status.index_revision,
                        CancellationToken::default(),
                    )
                    .await
                    .unwrap();
                let ids = review
                    .hunks
                    .iter()
                    .flat_map(|h| &h.lines)
                    .filter(|r| !r.id.is_empty())
                    .map(|r| r.id.clone())
                    .collect::<Vec<_>>();
                svc.apply_lines(
                    &status.repository.id,
                    "file",
                    GitDiffSide::Staged,
                    &ids,
                    &status.index_revision,
                    &review.worktree_snapshot,
                    true,
                    CancellationToken::default(),
                )
                .await
                .unwrap();
                let actual = f.git(&["ls-files", "--stage", "--", "file"]);
                assert_eq!(
                    actual, expected_unstaged,
                    "unstage: filemode={trust}, original={original_mode:?}, disk={disk_mode:o}"
                );
                assert_eq!(fs::read(f.0.path().join("file")).unwrap(), b"after\n");
                assert_eq!(
                    fs::metadata(f.0.path().join("file"))
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    disk_mode
                );
            }
        }
    }
}
