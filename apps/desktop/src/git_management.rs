//! Native adapters for repository setup, management and reviewed conflict operations.
use crate::{
    git::{current_service, ensure_current_workspace, mutate_git, read_git},
    DesktopState,
};
use span_core::{
    CancellationToken, GitBranchManagementAction, GitCloneResult, GitConflictResource, GitContext,
    GitIntegrationKind, GitIntegrationResult, GitIntegrationState, GitOperationResult,
    GitRebaseAction, GitRemoteConfigAction, GitRemotes, GitWorktreeCreateMode,
    GitWorktreePruneReview,
};
use tauri::State;

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn git_checkout_pull_request(
    state: State<'_, DesktopState>,
    context: GitContext,
    remote_name: String,
    number: u32,
    expected_head: String,
    local_branch: String,
    expected_index_revision: String,
    expected_config_fingerprint: String,
) -> Result<GitOperationResult, String> {
    mutate_git(
        state.inner().clone(),
        context,
        true,
        move |service, id| async move {
            service
                .checkout_pull_request(
                    &id,
                    &remote_name,
                    number,
                    &expected_head,
                    &local_branch,
                    &expected_index_revision,
                    &expected_config_fingerprint,
                    CancellationToken::default(),
                )
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_initialize_repository(
    state: State<'_, DesktopState>,
) -> Result<GitContext, String> {
    let (workspace, service) = current_service(&state).await?;
    let result = service
        .initialize_repository(CancellationToken::default())
        .await
        .map_err(|e| e.to_string())?;
    ensure_current_workspace(&state, &workspace).await?;
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_clone_repository(
    state: State<'_, DesktopState>,
    source: String,
    destination: String,
) -> Result<GitCloneResult, String> {
    let (workspace, service) = current_service(&state).await?;
    let result = service
        .clone_repository(&source, &destination, CancellationToken::default())
        .await
        .map_err(|e| e.to_string())?;
    ensure_current_workspace(&state, &workspace).await?;
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_configure_remote(
    state: State<'_, DesktopState>,
    context: GitContext,
    action: GitRemoteConfigAction,
    name: String,
    url: Option<String>,
    expected_config_fingerprint: String,
) -> Result<GitRemotes, String> {
    mutate_git(
        state.inner().clone(),
        context,
        false,
        move |service, id| async move {
            service
                .configure_remote(
                    &id,
                    action,
                    &name,
                    url.as_deref(),
                    &expected_config_fingerprint,
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
pub(crate) async fn git_manage_branch(
    state: State<'_, DesktopState>,
    context: GitContext,
    action: GitBranchManagementAction,
    branch: String,
    value: Option<String>,
    expected_oid: String,
    expected_head: Option<String>,
    expected_config_fingerprint: String,
) -> Result<GitOperationResult, String> {
    mutate_git(
        state.inner().clone(),
        context,
        false,
        move |service, id| async move {
            service
                .manage_branch(
                    &id,
                    action,
                    &branch,
                    value.as_deref(),
                    &expected_oid,
                    expected_head.as_deref(),
                    &expected_config_fingerprint,
                    CancellationToken::default(),
                )
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_fetch_background(
    state: State<'_, DesktopState>,
    context: GitContext,
    expected_config_fingerprint: String,
) -> Result<GitOperationResult, String> {
    read_git(
        state.inner().clone(),
        context,
        move |service, id| async move {
            service
                .auto_fetch(
                    &id,
                    &expected_config_fingerprint,
                    CancellationToken::default(),
                )
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_worktree_prune_review(
    state: State<'_, DesktopState>,
    context: GitContext,
) -> Result<GitWorktreePruneReview, String> {
    read_git(
        state.inner().clone(),
        context,
        move |service, id| async move {
            service
                .worktree_prune_review(&id, CancellationToken::default())
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_worktree_prune(
    state: State<'_, DesktopState>,
    context: GitContext,
    expected_snapshot: String,
) -> Result<GitOperationResult, String> {
    mutate_git(
        state.inner().clone(),
        context,
        false,
        move |service, id| async move {
            service
                .worktree_prune(&id, &expected_snapshot, CancellationToken::default())
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_worktree_set_locked(
    state: State<'_, DesktopState>,
    context: GitContext,
    path: String,
    locked: bool,
    expected_snapshot: String,
) -> Result<GitOperationResult, String> {
    mutate_git(
        state.inner().clone(),
        context,
        false,
        move |service, id| async move {
            service
                .worktree_set_locked(
                    &id,
                    &path,
                    locked,
                    &expected_snapshot,
                    CancellationToken::default(),
                )
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_worktree_create(
    state: State<'_, DesktopState>,
    context: GitContext,
    path: String,
    mode: GitWorktreeCreateMode,
    branch: Option<String>,
    expected_head: String,
) -> Result<GitOperationResult, String> {
    mutate_git(
        state.inner().clone(),
        context,
        false,
        move |service, id| async move {
            service
                .worktree_create(
                    &id,
                    &path,
                    mode,
                    branch.as_deref(),
                    &expected_head,
                    CancellationToken::default(),
                )
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_integration_start(
    state: State<'_, DesktopState>,
    context: GitContext,
    kind: GitIntegrationKind,
    target_id: String,
    expected_index_revision: String,
) -> Result<GitIntegrationResult, String> {
    mutate_git(
        state.inner().clone(),
        context,
        true,
        move |service, id| async move {
            service
                .integration_start(
                    &id,
                    kind,
                    &target_id,
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
pub(crate) async fn git_integration_control(
    state: State<'_, DesktopState>,
    context: GitContext,
    kind: GitIntegrationKind,
    action: GitRebaseAction,
    expected_index_revision: String,
    expected_worktree_snapshot: String,
) -> Result<GitIntegrationResult, String> {
    mutate_git(
        state.inner().clone(),
        context,
        true,
        move |service, id| async move {
            service
                .integration_control(
                    &id,
                    kind,
                    action,
                    &expected_index_revision,
                    &expected_worktree_snapshot,
                    CancellationToken::default(),
                )
                .await
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn git_conflict_resource(
    state: State<'_, DesktopState>,
    context: GitContext,
    path: String,
    expected_index_revision: String,
) -> Result<GitConflictResource, String> {
    read_git(
        state.inner().clone(),
        context,
        move |service, id| async move {
            service
                .conflict_resource(
                    &id,
                    &path,
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
pub(crate) async fn git_save_conflict_resolution(
    state: State<'_, DesktopState>,
    context: GitContext,
    path: String,
    content: String,
    expected_index_revision: String,
    expected_worktree_snapshot: String,
) -> Result<GitIntegrationState, String> {
    mutate_git(
        state.inner().clone(),
        context,
        true,
        move |service, id| async move {
            service
                .save_conflict_resolution(
                    &id,
                    &path,
                    &content,
                    &expected_index_revision,
                    &expected_worktree_snapshot,
                    CancellationToken::default(),
                )
                .await
        },
    )
    .await
}
