//! GitHub IPC uses repository identities and remote names already reviewed by Git.
use crate::DesktopState;
use span_core::CoreWorkspace;
use span_core::{
    CancellationToken, GitHubCreatePullRequest, GitHubRead, GitHubRepository, GitHubResponse,
    GitHubReview, GitHubStatus,
};
use std::sync::{Arc, Mutex};
use tauri::State;
async fn identity(state: &DesktopState) -> Result<Arc<Mutex<CoreWorkspace>>, String> {
    state
        .workspace
        .lock()
        .map_err(|_| "Workspace state unavailable".to_owned())?
        .clone()
        .ok_or("Open a workspace first".into())
}
async fn ensure(state: &DesktopState, expected: &Arc<Mutex<CoreWorkspace>>) -> Result<(), String> {
    let current = identity(state).await?;
    if Arc::ptr_eq(&current, expected) {
        Ok(())
    } else {
        Err("Workspace changed during GitHub request".into())
    }
}
async fn repositories(
    state: &DesktopState,
    context_id: &str,
) -> Result<Vec<GitHubRepository>, String> {
    let (_, service) = crate::git::current_service(state).await?;
    let remotes = service
        .remotes(context_id, CancellationToken::default())
        .await
        .map_err(|e| e.to_string())?;
    Ok(remotes
        .remotes
        .iter()
        .filter_map(|r| GitHubRepository::from_remote(&r.name, &r.fetch_url))
        .collect())
}
async fn selected(state: &DesktopState, id: &str, name: &str) -> Result<GitHubRepository, String> {
    repositories(state, id)
        .await?
        .into_iter()
        .find(|r| r.remote_name == name)
        .ok_or("Select a supported github.com remote from this repository".into())
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn github_repositories(
    state: State<'_, DesktopState>,
    context_id: String,
) -> Result<Vec<GitHubRepository>, String> {
    let workspace = identity(&state).await?;
    let result = repositories(&state, &context_id).await?;
    ensure(&state, &workspace).await?;
    Ok(result)
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn github_status(
    state: State<'_, DesktopState>,
    context_id: String,
    remote_name: String,
    expected_repository: GitHubRepository,
) -> Result<GitHubStatus, String> {
    let workspace = identity(&state).await?;
    let repo = selected(&state, &context_id, &remote_name).await?;
    validate_repository(&repo, &expected_repository)?;
    let result = repo.status(CancellationToken::default()).await;
    ensure(&state, &workspace).await?;
    check_remote(&state, &context_id, &remote_name, &expected_repository).await?;
    Ok(result)
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn github_read(
    state: State<'_, DesktopState>,
    context_id: String,
    remote_name: String,
    request: GitHubRead,
    expected_repository: GitHubRepository,
) -> Result<GitHubResponse, String> {
    let workspace = identity(&state).await?;
    let repo = selected(&state, &context_id, &remote_name).await?;
    validate_repository(&repo, &expected_repository)?;
    let result = repo.read(request, CancellationToken::default()).await?;
    ensure(&state, &workspace).await?;
    let after = selected(&state, &context_id, &remote_name).await?;
    if after.host != repo.host || after.owner != repo.owner || after.name != repo.name {
        return Err("GitHub remote changed".into());
    }
    Ok(result)
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn github_create_pull_request(
    state: State<'_, DesktopState>,
    context_id: String,
    remote_name: String,
    request: GitHubCreatePullRequest,
    expected_repository: GitHubRepository,
) -> Result<String, String> {
    let workspace = identity(&state).await?;
    let repo = selected(&state, &context_id, &remote_name).await?;
    validate_repository(&repo, &expected_repository)?;
    ensure(&state, &workspace).await?;
    check_remote(&state, &context_id, &remote_name, &repo).await?;
    let result = repo
        .create_pull_request(request, CancellationToken::default())
        .await;
    ensure(&state, &workspace).await.map_err(|_| {
        "Workspace changed. The GitHub action may have completed; refresh before retrying"
            .to_owned()
    })?;
    check_remote(&state, &context_id, &remote_name, &repo)
        .await
        .map_err(|_| {
            "Remote changed. The GitHub action may have completed; refresh before retrying"
                .to_owned()
        })?;
    result
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn github_review_pull_request(
    state: State<'_, DesktopState>,
    context_id: String,
    remote_name: String,
    request: GitHubReview,
    expected_repository: GitHubRepository,
) -> Result<String, String> {
    let workspace = identity(&state).await?;
    let repo = selected(&state, &context_id, &remote_name).await?;
    validate_repository(&repo, &expected_repository)?;
    ensure(&state, &workspace).await?;
    check_remote(&state, &context_id, &remote_name, &repo).await?;
    let result = repo.review(request, CancellationToken::default()).await;
    ensure(&state, &workspace).await.map_err(|_| {
        "Workspace changed. The GitHub action may have completed; refresh before retrying"
            .to_owned()
    })?;
    check_remote(&state, &context_id, &remote_name, &repo)
        .await
        .map_err(|_| {
            "Remote changed. The GitHub action may have completed; refresh before retrying"
                .to_owned()
        })?;
    result
}

async fn check_remote(
    state: &DesktopState,
    id: &str,
    name: &str,
    expected: &GitHubRepository,
) -> Result<(), String> {
    let actual = selected(state, id, name).await?;
    if actual.host == expected.host
        && actual.owner == expected.owner
        && actual.name == expected.name
    {
        Ok(())
    } else {
        Err("GitHub remote changed".into())
    }
}

fn validate_repository(
    actual: &GitHubRepository,
    expected: &GitHubRepository,
) -> Result<(), String> {
    if actual.host == expected.host
        && actual.owner == expected.owner
        && actual.name == expected.name
        && actual.remote_name == expected.remote_name
    {
        Ok(())
    } else {
        Err(
            "GitHub remote differs from the repository displayed. Refresh GitHub before continuing"
                .into(),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_retargeted_remote_before_hosted_actions() {
        let displayed =
            GitHubRepository::from_remote("origin", "git@github.com:reviewed/editor.git").unwrap();
        let changed =
            GitHubRepository::from_remote("origin", "git@github.com:other/editor.git").unwrap();
        assert!(validate_repository(&displayed, &displayed).is_ok());
        assert!(validate_repository(&changed, &displayed).is_err());
        let aliased =
            GitHubRepository::from_remote("upstream", "git@github.com:reviewed/editor.git")
                .unwrap();
        assert!(validate_repository(&aliased, &displayed).is_err());
    }
}
