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
        git(&root, &["config", "--local", "core.autocrlf", "false"]);
        git(&root, &["config", "--local", "core.eol", "lf"]);
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

fn text(fixture: &Fixture, args: &[&str]) -> String {
    String::from_utf8(git(&fixture.root, args).stdout)
        .unwrap()
        .trim()
        .to_owned()
}

async fn amend(service: &GitService, id: &str, status: &GitStatus) -> Result<GitCommitResult> {
    service
        .amend(
            id,
            "amended message".into(),
            status.repository.head.as_deref().unwrap(),
            &status.index_revision,
            &status.staged_snapshot,
            token(),
        )
        .await
}

#[tokio::test]
async fn message_only_amend_preserves_unstaged_files_and_root_parents() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("note.txt", "base\n")]);
    let service = fixture.service(&fixture.root);
    let id = Fixture::repo_id(&service).await;
    fixture.write("note.txt", "unstaged\n");
    fixture.write("untracked.txt", "private\n");
    let status = service.status(&id, token()).await.unwrap();
    let result = amend(&service, &id, &status).await.unwrap();
    assert_ne!(Some(&result.commit_id), status.repository.head.as_ref());
    assert_eq!(text(&fixture, &["show", "HEAD:note.txt"]), "base");
    assert_eq!(
        text(&fixture, &["show", "--no-patch", "--format=%P", "HEAD"]),
        ""
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("note.txt")).unwrap(),
        "unstaged\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("untracked.txt")).unwrap(),
        "private\n"
    );
}

#[tokio::test]
async fn staged_amend_commits_reviewed_tree_and_preserves_later_disk_edit() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("note.txt", "base\n")]);
    fixture.write("note.txt", "staged\n");
    git(&fixture.root, &["add", "note.txt"]);
    let expected_tree = text(&fixture, &["write-tree"]);
    fixture.write("note.txt", "later\n");
    let service = fixture.service(&fixture.root);
    let id = Fixture::repo_id(&service).await;
    let status = service.status(&id, token()).await.unwrap();
    amend(&service, &id, &status).await.unwrap();
    assert_eq!(text(&fixture, &["rev-parse", "HEAD^{tree}"]), expected_tree);
    assert_eq!(text(&fixture, &["show", "HEAD:note.txt"]), "staged");
    assert_eq!(
        fs::read_to_string(fixture.root.join("note.txt")).unwrap(),
        "later\n"
    );
}

#[tokio::test]
async fn amend_rejects_old_head_and_changed_index() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("note.txt", "base\n")]);
    let service = fixture.service(&fixture.root);
    let id = Fixture::repo_id(&service).await;
    let status = service.status(&id, token()).await.unwrap();
    assert!(service
        .amend(
            &id,
            "message".into(),
            &"0".repeat(40),
            &status.index_revision,
            &status.staged_snapshot,
            token()
        )
        .await
        .is_err());
    fixture.write("note.txt", "staged\n");
    git(&fixture.root, &["add", "note.txt"]);
    assert!(amend(&service, &id, &status).await.is_err());
    git(&fixture.root, &["commit", "-m", "external"]);
    assert!(amend(&service, &id, &status).await.is_err());
    assert_eq!(text(&fixture, &["log", "-1", "--format=%s"]), "external");
}

#[cfg(unix)]
fn hook(fixture: &Fixture, name: &str, script: &str) {
    use std::os::unix::fs::PermissionsExt;
    let path = fixture.hooks.join(name);
    fs::write(&path, script).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn amend_hook_failures_distinguish_rejection_from_created_commit() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("note.txt", "base\n")]);
    let service = fixture.service(&fixture.root);
    let id = Fixture::repo_id(&service).await;
    let status = service.status(&id, token()).await.unwrap();
    hook(&fixture, "pre-commit", "#!/bin/sh\nexit 1\n");
    assert!(amend(&service, &id, &status).await.is_err());
    assert_eq!(
        text(&fixture, &["rev-parse", "HEAD"]),
        status.repository.head.clone().unwrap()
    );
    fs::remove_file(fixture.hooks.join("pre-commit")).unwrap();
    hook(
        &fixture,
        "post-commit",
        "#!/bin/sh\nprintf 'post-hook\\n' > note.txt\ngit add -- note.txt\nexit 1\n",
    );
    let result = amend(&service, &id, &status).await.unwrap();
    assert!(result.warning.is_some());
    assert_eq!(text(&fixture, &["rev-parse", "HEAD"]), result.commit_id);
    assert_eq!(text(&fixture, &["show", "HEAD:note.txt"]), "base");
    assert_eq!(text(&fixture, &["show", ":note.txt"]), "post-hook");
}

#[tokio::test]
async fn amend_retains_all_merge_parents() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("base.txt", "base\n")]);
    git(&fixture.root, &["checkout", "-b", "side"]);
    fixture.write("side.txt", "side\n");
    git(&fixture.root, &["add", "side.txt"]);
    git(&fixture.root, &["commit", "-m", "side"]);
    git(&fixture.root, &["checkout", "main"]);
    fixture.write("main.txt", "main\n");
    git(&fixture.root, &["add", "main.txt"]);
    git(&fixture.root, &["commit", "-m", "main"]);
    git(&fixture.root, &["merge", "--no-ff", "side", "-m", "merge"]);
    let parents = text(&fixture, &["show", "--no-patch", "--format=%P", "HEAD"]);
    assert_eq!(parents.split_whitespace().count(), 2);
    let service = fixture.service(&fixture.root);
    let id = Fixture::repo_id(&service).await;
    let status = service.status(&id, token()).await.unwrap();
    amend(&service, &id, &status).await.unwrap();
    assert_eq!(
        text(&fixture, &["show", "--no-patch", "--format=%P", "HEAD"]),
        parents
    );
}

#[cfg(unix)]
#[tokio::test]
async fn amend_rejects_hook_changes_to_reviewed_tree() {
    let fixture = Fixture::new();
    fixture.initial_commit(&[("note.txt", "base\n")]);
    let service = fixture.service(&fixture.root);
    let id = Fixture::repo_id(&service).await;
    let status = service.status(&id, token()).await.unwrap();
    let index = fs::read(fixture.root.join(".git/index")).unwrap();
    hook(
        &fixture,
        "pre-commit",
        "#!/bin/sh\nprintf 'hook change\\n' > note.txt\ngit add -- note.txt\n",
    );
    assert!(amend(&service, &id, &status).await.is_err());
    assert_eq!(
        text(&fixture, &["rev-parse", "HEAD"]),
        status.repository.head.unwrap()
    );
    assert_eq!(fs::read(fixture.root.join(".git/index")).unwrap(), index);
    assert_eq!(
        fs::read_to_string(fixture.root.join("note.txt")).unwrap(),
        "hook change\n"
    );
}
