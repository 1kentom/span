//! Desktop IPC adapter for the shared Core Git service.
//!
//! Git commands run outside the CoreWorkspace mutex. The adapter caches one
//! Core service per opened workspace identity and retires it before replacing
//! the workspace, so stale requests cannot publish results for a new folder.
use crate::{with_workspace, DesktopState};
use span_core::{
    CancellationToken, CoreWorkspace, GitCommitResult, GitContext, GitDiff, GitDiffSide,
    GitHistoryPage, GitHistoryQuery, GitService, GitStatus,
};
use std::sync::{Arc, Mutex};
use tauri::State;

#[derive(Clone, Default)]
pub(crate) struct GitAdapterState {
    current: Arc<Mutex<Option<CachedService>>>,
}

#[derive(Clone)]
struct CachedService {
    workspace: Arc<Mutex<CoreWorkspace>>,
    service: GitService,
}

pub(crate) async fn current_service(
    state: &DesktopState,
) -> Result<(Arc<Mutex<CoreWorkspace>>, GitService), String> {
    let _gate = state.connection_gate.lock().await;
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open a workspace before using Git".to_owned())?;

    if let Some(cached) = state
        .git
        .current
        .lock()
        .map_err(|_| "Git service state is unavailable".to_owned())?
        .as_ref()
        .filter(|cached| Arc::ptr_eq(&cached.workspace, &workspace))
        .cloned()
    {
        return Ok((workspace, cached.service));
    }

    let previous = state
        .git
        .current
        .lock()
        .map_err(|_| "Git service state is unavailable".to_owned())?
        .take();
    if let Some(previous) = previous {
        previous
            .service
            .shutdown()
            .await
            .map_err(|error| error.to_string())?;
    }

    let service = with_workspace(state.clone(), |workspace| workspace.git_service()).await?;
    *state
        .git
        .current
        .lock()
        .map_err(|_| "Git service state is unavailable".to_owned())? = Some(CachedService {
        workspace: workspace.clone(),
        service: service.clone(),
    });
    Ok((workspace, service))
}

async fn ensure_current_workspace(
    state: &DesktopState,
    expected: &Arc<Mutex<CoreWorkspace>>,
) -> Result<(), String> {
    let _gate = state.connection_gate.lock().await;
    let current = state
        .workspace
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Workspace closed during Git operation".to_owned())?;
    if Arc::ptr_eq(&current, expected) {
        Ok(())
    } else {
        Err("Workspace changed during the Git operation. Refresh and retry.".into())
    }
}

pub(crate) async fn cancel_workspace(state: &DesktopState) -> Result<(), String> {
    let previous = state
        .git
        .current
        .lock()
        .map_err(|_| "Git service state is unavailable".to_owned())?
        .take();
    if let Some(previous) = previous {
        previous
            .service
            .shutdown()
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_context(state: State<'_, DesktopState>) -> Result<GitContext, String> {
    git_context_for(state.inner().clone()).await
}

async fn git_context_for(state: DesktopState) -> Result<GitContext, String> {
    let (workspace, service) = current_service(&state).await?;
    let context = service
        .context(CancellationToken::default())
        .await
        .map_err(|error| error.to_string())?;
    ensure_current_workspace(&state, &workspace).await?;
    Ok(context)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_enable(
    state: State<'_, DesktopState>,
    context: GitContext,
) -> Result<GitStatus, String> {
    git_enable_for(state.inner().clone(), context).await
}

async fn git_enable_for(state: DesktopState, context: GitContext) -> Result<GitStatus, String> {
    let (workspace, service) = current_service(&state).await?;
    let repository_id = repository_id(&context)?;
    let status = service
        .enable(repository_id, CancellationToken::default())
        .await
        .map_err(|error| error.to_string())?;
    ensure_current_workspace(&state, &workspace).await?;
    Ok(status)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_status(
    state: State<'_, DesktopState>,
    context: GitContext,
) -> Result<GitStatus, String> {
    git_status_for(state.inner().clone(), context).await
}

async fn git_status_for(state: DesktopState, context: GitContext) -> Result<GitStatus, String> {
    let (workspace, service) = current_service(&state).await?;
    let repository_id = repository_id(&context)?;
    let status = service
        .status(repository_id, CancellationToken::default())
        .await
        .map_err(|error| error.to_string())?;
    ensure_current_workspace(&state, &workspace).await?;
    Ok(status)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_diff(
    state: State<'_, DesktopState>,
    context: GitContext,
    path: String,
    side: GitDiffSide,
    expected_index_revision: String,
) -> Result<GitDiff, String> {
    git_diff_for(
        state.inner().clone(),
        context,
        path,
        side,
        expected_index_revision,
    )
    .await
}

async fn git_diff_for(
    state: DesktopState,
    context: GitContext,
    path: String,
    side: GitDiffSide,
    expected_index_revision: String,
) -> Result<GitDiff, String> {
    let (workspace, service) = current_service(&state).await?;
    let repository_id = repository_id(&context)?;
    let diff = service
        .diff(
            repository_id,
            &path,
            side,
            &expected_index_revision,
            CancellationToken::default(),
        )
        .await
        .map_err(|error| error.to_string())?;
    ensure_current_workspace(&state, &workspace).await?;
    Ok(diff)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_history(
    state: State<'_, DesktopState>,
    context: GitContext,
    query: GitHistoryQuery,
) -> Result<GitHistoryPage, String> {
    git_history_for(state.inner().clone(), context, query).await
}

async fn git_history_for(
    state: DesktopState,
    context: GitContext,
    query: GitHistoryQuery,
) -> Result<GitHistoryPage, String> {
    let (workspace, service) = current_service(&state).await?;
    let repository_id = repository_id(&context)?;
    let page = service
        .history(repository_id, query, CancellationToken::default())
        .await
        .map_err(|error| error.to_string())?;
    ensure_current_workspace(&state, &workspace).await?;
    Ok(page)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_commit_diff(
    state: State<'_, DesktopState>,
    context: GitContext,
    commit_id: String,
    path: Option<String>,
) -> Result<GitDiff, String> {
    git_commit_diff_for(state.inner().clone(), context, commit_id, path).await
}

async fn git_commit_diff_for(
    state: DesktopState,
    context: GitContext,
    commit_id: String,
    path: Option<String>,
) -> Result<GitDiff, String> {
    let (workspace, service) = current_service(&state).await?;
    let repository_id = repository_id(&context)?;
    let diff = service
        .commit_diff(
            repository_id,
            &commit_id,
            path,
            CancellationToken::default(),
        )
        .await
        .map_err(|error| error.to_string())?;
    ensure_current_workspace(&state, &workspace).await?;
    Ok(diff)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_stage(
    state: State<'_, DesktopState>,
    context: GitContext,
    paths: Vec<String>,
    expected_index_revision: String,
) -> Result<GitStatus, String> {
    git_stage_for(
        state.inner().clone(),
        context,
        paths,
        expected_index_revision,
    )
    .await
}

async fn git_stage_for(
    state: DesktopState,
    context: GitContext,
    paths: Vec<String>,
    expected_index_revision: String,
) -> Result<GitStatus, String> {
    let (workspace, service) = current_service(&state).await?;
    let repository_id = repository_id(&context)?;
    let status = service
        .stage(
            repository_id,
            paths,
            &expected_index_revision,
            CancellationToken::default(),
        )
        .await
        .map_err(|error| error.to_string())?;
    ensure_current_workspace(&state, &workspace).await?;
    Ok(status)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_unstage(
    state: State<'_, DesktopState>,
    context: GitContext,
    paths: Vec<String>,
    expected_index_revision: String,
) -> Result<GitStatus, String> {
    git_unstage_for(
        state.inner().clone(),
        context,
        paths,
        expected_index_revision,
    )
    .await
}

async fn git_unstage_for(
    state: DesktopState,
    context: GitContext,
    paths: Vec<String>,
    expected_index_revision: String,
) -> Result<GitStatus, String> {
    let (workspace, service) = current_service(&state).await?;
    let repository_id = repository_id(&context)?;
    let status = service
        .unstage(
            repository_id,
            paths,
            &expected_index_revision,
            CancellationToken::default(),
        )
        .await
        .map_err(|error| error.to_string())?;
    ensure_current_workspace(&state, &workspace).await?;
    Ok(status)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_commit(
    state: State<'_, DesktopState>,
    context: GitContext,
    message: String,
    expected_index_revision: String,
    expected_staged_snapshot: String,
) -> Result<GitCommitResult, String> {
    git_commit_for(
        state.inner().clone(),
        context,
        message,
        expected_index_revision,
        expected_staged_snapshot,
    )
    .await
}

async fn git_commit_for(
    state: DesktopState,
    context: GitContext,
    message: String,
    expected_index_revision: String,
    expected_staged_snapshot: String,
) -> Result<GitCommitResult, String> {
    let (workspace, service) = current_service(&state).await?;
    let repository_id = repository_id(&context)?;
    let result = service
        .commit(
            repository_id,
            message,
            &expected_index_revision,
            &expected_staged_snapshot,
            CancellationToken::default(),
        )
        .await
        .map_err(|error| error.to_string())?;
    ensure_current_workspace(&state, &workspace).await?;
    Ok(result)
}

fn repository_id(context: &GitContext) -> Result<&str, String> {
    context
        .repository
        .as_ref()
        .map(|repository| repository.id.as_str())
        .ok_or_else(|| {
            context
                .unavailable_reason
                .clone()
                .unwrap_or_else(|| "The current workspace is not inside a Git repository".into())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    fn git(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .expect("start git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn state_for(root: &Path) -> DesktopState {
        let workspace = CoreWorkspace::open(root).expect("open workspace");
        let state = DesktopState::default();
        *state.workspace.lock().expect("workspace state") = Some(Arc::new(Mutex::new(workspace)));
        state
    }

    fn initialize_repository(root: &Path) {
        git(root, &["init", "--quiet"]);
        git(root, &["config", "user.name", "Span Git Test"]);
        git(
            root,
            &["config", "user.email", "span-git-test@example.invalid"],
        );
        let hooks = root.join("empty-hooks");
        fs::create_dir(&hooks).expect("create isolated hooks directory");
        git(
            root,
            &[
                "config",
                "core.hooksPath",
                hooks.to_str().expect("hooks path"),
            ],
        );
        fs::write(root.join("tracked.txt"), "before\n").expect("write initial file");
        git(root, &["add", "--", "tracked.txt"]);
        git(root, &["commit", "--quiet", "-m", "initial"]);
        fs::write(root.join("tracked.txt"), "after\n").expect("modify tracked file");
    }

    #[tokio::test]
    async fn desktop_ipc_adapter_stages_commits_and_reads_real_repository_history() {
        let directory = tempfile::tempdir().expect("temporary repository");
        initialize_repository(directory.path());
        let state = state_for(directory.path());

        let mut context = git_context_for(state.clone()).await.expect("Git context");
        assert!(!context.enabled);
        let repository = context.repository.as_ref().expect("detected repository");
        let repository_id = repository.id.clone();
        let canonical_root = fs::canonicalize(directory.path()).expect("canonical root");
        assert_eq!(repository.root, canonical_root.to_string_lossy().as_ref());

        // Client-provided state is never authoritative for activation.
        context.enabled = true;
        let denied = git_status_for(state.clone(), context.clone()).await;
        assert!(denied.is_err(), "Git reads require explicit activation");

        let activated = git_enable_for(state.clone(), context.clone())
            .await
            .expect("explicitly enable Git");
        context = git_context_for(state.clone())
            .await
            .expect("enabled context");
        assert!(context.enabled);
        let before_stage = activated;
        assert!(before_stage.entries.iter().any(|entry| {
            entry.path.as_deref() == Some("tracked.txt") && entry.worktree_status == "M"
        }));

        let staged = git_stage_for(
            state.clone(),
            context.clone(),
            vec!["tracked.txt".into()],
            before_stage.index_revision,
        )
        .await
        .expect("explicit stage");
        assert!(staged.entries.iter().any(|entry| {
            entry.path.as_deref() == Some("tracked.txt") && entry.index_status == "M"
        }));

        let committed = git_commit_for(
            state.clone(),
            context.clone(),
            "adapter integration commit".into(),
            staged.index_revision,
            staged.staged_snapshot,
        )
        .await
        .expect("commit exact staged snapshot");
        assert!(!committed.commit_id.is_empty());
        assert_eq!(
            committed.commit.as_ref().expect("commit metadata").subject,
            "adapter integration commit"
        );
        assert!(committed
            .status
            .as_ref()
            .expect("post-commit status")
            .entries
            .is_empty());

        let page = git_history_for(
            state.clone(),
            context.clone(),
            span_core::GitHistoryQuery::default(),
        )
        .await
        .expect("history");
        assert_eq!(page.repository_id, repository_id);
        assert!(page
            .commits
            .iter()
            .any(|commit| commit.id == committed.commit_id));

        let diff = git_commit_diff_for(
            state.clone(),
            context.clone(),
            committed.commit_id.clone(),
            Some("tracked.txt".into()),
        )
        .await
        .expect("commit diff");
        assert!(diff.patch.contains("+after"));

        let other = tempfile::tempdir().expect("replacement workspace");
        let replacement = CoreWorkspace::open(other.path()).expect("open replacement");
        *state.workspace.lock().expect("workspace state") = Some(Arc::new(Mutex::new(replacement)));
        let stale = git_status_for(state.clone(), context)
            .await
            .expect_err("old repository identity must not cross workspace replacement");
        assert!(
            stale.contains("repository") || stale.contains("Git"),
            "{stale}"
        );
        cancel_workspace(&state)
            .await
            .expect("retire replacement service");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn git_context_and_denied_reads_do_not_run_configured_clean_filters() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let repository = directory.path().join("repo");
        fs::create_dir(&repository).expect("create repository");
        let marker = directory.path().join("clean-filter-ran");
        git(&repository, &["init", "--quiet"]);
        git(&repository, &["config", "user.name", "Span Git Test"]);
        git(
            &repository,
            &["config", "user.email", "span-git-test@example.invalid"],
        );
        let hooks = directory.path().join("empty-hooks");
        fs::create_dir(&hooks).expect("create isolated hooks directory");
        git(
            &repository,
            &[
                "config",
                "core.hooksPath",
                hooks.to_str().expect("hooks path"),
            ],
        );
        let clean = format!("sh -c 'printf x >> \"{}\"; cat'", marker.display());
        git(&repository, &["config", "filter.tripwire.clean", &clean]);
        git(&repository, &["config", "filter.tripwire.smudge", "cat"]);
        fs::write(
            repository.join(".gitattributes"),
            "tracked.txt filter=tripwire\n",
        )
        .expect("write attributes");
        fs::write(repository.join("tracked.txt"), "before\n").expect("write tracked file");
        git(&repository, &["add", "--", ".gitattributes", "tracked.txt"]);
        git(&repository, &["commit", "--quiet", "-m", "initial"]);
        let _ = fs::remove_file(&marker);
        fs::write(repository.join("tracked.txt"), "after\n").expect("modify tracked file");

        let state = state_for(&repository);
        let mut context = git_context_for(state.clone())
            .await
            .expect("discover repository");
        assert!(!context.enabled);
        assert!(!marker.exists(), "discovery must not run a clean filter");

        context.enabled = true;
        let denied = git_status_for(state.clone(), context.clone()).await;
        assert!(denied.is_err(), "unactivated reads must be rejected");
        assert!(
            !marker.exists(),
            "denied status must not run a clean filter"
        );

        let activated = git_enable_for(state.clone(), context.clone())
            .await
            .expect("explicit activation");
        git_stage_for(
            state.clone(),
            context,
            vec!["tracked.txt".into()],
            activated.index_revision,
        )
        .await
        .expect("stage after explicit activation");
        assert!(
            marker.exists(),
            "clean filter can run during an authorized Git operation"
        );
        cancel_workspace(&state).await.expect("retire Git service");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_replacement_cancels_an_owned_git_filter_process() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let repository = directory.path().join("repo");
        fs::create_dir(&repository).expect("create repository");
        let started = directory.path().join("filter-started");
        let completed = directory.path().join("filter-completed");
        git(&repository, &["init", "--quiet"]);
        git(&repository, &["config", "user.name", "Span Git Test"]);
        git(
            &repository,
            &["config", "user.email", "span-git-test@example.invalid"],
        );
        let hooks = directory.path().join("empty-hooks");
        fs::create_dir(&hooks).expect("create isolated hooks directory");
        git(
            &repository,
            &[
                "config",
                "core.hooksPath",
                hooks.to_str().expect("hooks path"),
            ],
        );
        fs::write(repository.join("tracked.txt"), "before\n").expect("write tracked file");
        git(&repository, &["add", "--", "tracked.txt"]);
        git(&repository, &["commit", "--quiet", "-m", "initial"]);
        let clean = format!(
            "sh -c 'touch \"{}\"; sleep 5; touch \"{}\"; cat'",
            started.display(),
            completed.display()
        );
        git(&repository, &["config", "filter.tripwire.clean", &clean]);
        git(&repository, &["config", "filter.tripwire.smudge", "cat"]);
        fs::write(
            repository.join(".gitattributes"),
            "tracked.txt filter=tripwire\n",
        )
        .expect("write attributes");
        fs::write(repository.join("tracked.txt"), "after\n").expect("modify tracked file");

        let state = state_for(&repository);
        let context = git_context_for(state.clone())
            .await
            .expect("discover repository");
        assert!(
            !started.exists(),
            "context discovery must not execute configured filters"
        );
        let activated = git_enable_for(state.clone(), context.clone())
            .await
            .expect("explicit activation before staging");
        let operation_state = state.clone();
        let operation = tokio::spawn(async move {
            git_stage_for(
                operation_state,
                context,
                vec!["tracked.txt".into()],
                activated.index_revision,
            )
            .await
        });

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        while !started.exists() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "Git clean filter did not start during staging"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        // This is the same service retirement called before open_workspace publishes a new root.
        cancel_workspace(&state)
            .await
            .expect("cancel old workspace Git service");
        let replacement = tempfile::tempdir().expect("replacement workspace");
        let workspace = CoreWorkspace::open(replacement.path()).expect("open replacement");
        *state.workspace.lock().expect("workspace state") = Some(Arc::new(Mutex::new(workspace)));

        let result = operation.await.expect("join activation operation");
        assert!(
            result.is_err(),
            "canceled staging must not publish a successful result"
        );
        assert!(
            !completed.exists(),
            "workspace replacement must kill the owned Git filter process"
        );
    }
}
