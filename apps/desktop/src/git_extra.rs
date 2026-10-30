//! Native adapters for explicit remote publication, immutable history and reviewed lines.
use crate::{
    git::{mutate_git, read_git},
    DesktopState,
};
use span_core::{
    CancellationToken, GitContext, GitDiffSide, GitHistoryPage, GitHistoryToolsPage,
    GitHistoryToolsQuery, GitLineReview, GitReflogPage, GitRemoteAction, GitRevisionContent,
    GitRevisionDiff, GitSelectedRemoteResult, GitSigningConfiguration, GitStatus,
};
use tauri::State;

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_open_worktree_window(
    state: State<'_, DesktopState>,
    context: GitContext,
    path: String,
) -> Result<(), String> {
    let validated = read_git(
        state.inner().clone(),
        context,
        move |service, id| async move {
            service
                .worktree_window_path(&id, &path, CancellationToken::default())
                .await
        },
    )
    .await?;
    let executable = std::env::current_exe().map_err(|e| format!("Locate Span executable: {e}"))?;
    let mut child = tokio::process::Command::new(executable)
        .args(["--new-window", "--", &validated])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Open worktree window: {e}"))?;
    tauri::async_runtime::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_amend(
    state: State<'_, DesktopState>,
    context: GitContext,
    message: String,
    expected_head: String,
    expected_index_revision: String,
    expected_staged_snapshot: String,
) -> Result<span_core::GitCommitResult, String> {
    mutate_git(
        state.inner().clone(),
        context,
        false,
        move |service, id| async move {
            service
                .amend(
                    &id,
                    message,
                    &expected_head,
                    &expected_index_revision,
                    &expected_staged_snapshot,
                    CancellationToken::default(),
                )
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn git_remote_selected(
    state: State<'_, DesktopState>,
    context: GitContext,
    action: GitRemoteAction,
    remote_name: String,
    target_branch: Option<String>,
    expected_index_revision: String,
    expected_config_fingerprint: String,
    set_upstream: bool,
) -> Result<GitSelectedRemoteResult, String> {
    mutate_git(
        state.inner().clone(),
        context,
        action == GitRemoteAction::Pull,
        move |service, id| async move {
            service
                .remote_selected(
                    &id,
                    action,
                    &remote_name,
                    target_branch.as_deref().unwrap_or(""),
                    &expected_index_revision,
                    &expected_config_fingerprint,
                    set_upstream,
                    CancellationToken::default(),
                )
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_worktree_window_path(
    state: State<'_, DesktopState>,
    context: GitContext,
    path: String,
) -> Result<String, String> {
    read_git(
        state.inner().clone(),
        context,
        move |service, id| async move {
            service
                .worktree_window_path(&id, &path, CancellationToken::default())
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_history_tools(
    state: State<'_, DesktopState>,
    context: GitContext,
    query: GitHistoryToolsQuery,
) -> Result<GitHistoryToolsPage, String> {
    read_git(
        state.inner().clone(),
        context,
        move |service, id| async move {
            service
                .history_tools(&id, query, CancellationToken::default())
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_revision_content(
    state: State<'_, DesktopState>,
    context: GitContext,
    revision: String,
    path: String,
) -> Result<GitRevisionContent, String> {
    read_git(
        state.inner().clone(),
        context,
        move |service, id| async move {
            service
                .revision_content(&id, &revision, &path, CancellationToken::default())
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_revision_diff(
    state: State<'_, DesktopState>,
    context: GitContext,
    from: String,
    to: Option<String>,
    path: Option<String>,
) -> Result<GitRevisionDiff, String> {
    read_git(
        state.inner().clone(),
        context,
        move |service, id| async move {
            service
                .revision_diff(
                    &id,
                    &from,
                    to.as_deref(),
                    path.as_deref(),
                    CancellationToken::default(),
                )
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_reflog_page(
    state: State<'_, DesktopState>,
    context: GitContext,
    skip: u32,
    limit: u32,
) -> Result<GitReflogPage, String> {
    read_git(
        state.inner().clone(),
        context,
        move |service, id| async move {
            service
                .reflog_page(&id, skip, limit, CancellationToken::default())
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn git_line_history(
    state: State<'_, DesktopState>,
    context: GitContext,
    revision: String,
    path: String,
    start: u32,
    end: u32,
    skip: u32,
    limit: u32,
) -> Result<GitHistoryPage, String> {
    read_git(
        state.inner().clone(),
        context,
        move |service, id| async move {
            service
                .line_history(
                    &id,
                    &revision,
                    &path,
                    start,
                    end,
                    skip,
                    limit,
                    CancellationToken::default(),
                )
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_signing_configuration(
    state: State<'_, DesktopState>,
    context: GitContext,
) -> Result<GitSigningConfiguration, String> {
    read_git(
        state.inner().clone(),
        context,
        move |service, id| async move {
            service
                .signing_configuration(&id, CancellationToken::default())
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_review_lines(
    state: State<'_, DesktopState>,
    context: GitContext,
    path: String,
    side: GitDiffSide,
    expected_index_revision: String,
) -> Result<GitLineReview, String> {
    read_git(
        state.inner().clone(),
        context,
        move |service, id| async move {
            service
                .review_lines(
                    &id,
                    &path,
                    side,
                    &expected_index_revision,
                    CancellationToken::default(),
                )
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn git_apply_lines(
    state: State<'_, DesktopState>,
    context: GitContext,
    path: String,
    side: GitDiffSide,
    line_ids: Vec<String>,
    expected_index_revision: String,
    expected_worktree_snapshot: String,
    include_metadata: bool,
) -> Result<GitStatus, String> {
    mutate_git(
        state.inner().clone(),
        context,
        false,
        move |service, id| async move {
            service
                .apply_lines(
                    &id,
                    &path,
                    side,
                    &line_ids,
                    &expected_index_revision,
                    &expected_worktree_snapshot,
                    include_metadata,
                    CancellationToken::default(),
                )
                .await
        },
    )
    .await
}
