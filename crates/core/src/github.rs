//! GitHub CLI transport. Credentials remain in gh's credential store.
use crate::{resolve_program, CancellationToken};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepository {
    pub host: String,
    pub owner: String,
    pub name: String,
    pub remote_name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHubStatus {
    pub available: bool,
    pub authenticated: bool,
    pub message: String,
    pub repository: GitHubRepository,
}
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHubResponse {
    pub items: Vec<GitHubItem>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct GitHubBranch {
    pub name: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct GitHubActor {
    pub login: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct GitHubComment {
    pub author: Option<GitHubActor>,
    pub body: String,
    pub state: String,
    pub submitted_at: Option<String>,
    pub url: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct GitHubCheck {
    pub name: String,
    pub context: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub state: Option<String>,
    pub details_url: Option<String>,
    pub target_url: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct GitHubFile {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct GitHubItem {
    pub number: u32,
    pub title: String,
    pub body: String,
    pub state: String,
    pub url: String,
    pub author: Option<GitHubActor>,
    pub base_ref_name: String,
    pub head_ref_name: String,
    pub head_ref_oid: String,
    pub is_draft: bool,
    #[serde(deserialize_with = "null_default")]
    #[specta(type = String)]
    pub review_decision: String,
    #[serde(deserialize_with = "null_default")]
    #[specta(type = Vec<GitHubCheck>)]
    pub status_check_rollup: Vec<GitHubCheck>,
    pub reviews: Vec<GitHubComment>,
    pub comments: Vec<GitHubComment>,
    pub files: Vec<GitHubFile>,
    pub changed_files: u32,
    pub additions: u32,
    pub deletions: u32,
    pub name_with_owner: String,
    pub default_branch_ref: Option<GitHubBranch>,
    pub description: Option<String>,
    pub is_private: bool,
    pub filename: String,
    pub patch: Option<String>,
    #[serde(rename = "previous_filename")]
    pub previous_filename: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GitHubRead {
    Repository,
    PullRequests {
        state: String,
        limit: u32,
    },
    PullRequest {
        number: u32,
    },
    Issues {
        state: String,
        limit: u32,
    },
    Issue {
        number: u32,
    },
    CurrentPullRequest {
        branch: String,
    },
    PullRequestFiles {
        number: u32,
        page: u32,
        #[serde(rename = "expectedHead")]
        expected_head: String,
    },
    Checks {
        number: u32,
    },
    Reviews {
        number: u32,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHubCreatePullRequest {
    pub title: String,
    pub body: String,
    pub base: String,
    pub head: String,
    pub draft: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GitHubReviewEvent {
    Approve,
    Comment,
    RequestChanges,
}
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHubReview {
    pub number: u32,
    pub event: GitHubReviewEvent,
    pub body: String,
    pub expected_head: String,
}

fn component(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        && s != "."
        && s != ".."
        && !s.starts_with('-')
}
impl GitHubRepository {
    pub fn from_remote(remote_name: &str, url: &str) -> Option<Self> {
        let value = if let Some(v) = url.strip_prefix("https://") {
            v
        } else if let Some(v) = url.strip_prefix("ssh://git@") {
            v
        } else {
            url.strip_prefix("git@")?
        };
        let (host, path) = if url.starts_with("git@") {
            value.split_once(':')?
        } else {
            value.split_once('/')?
        };
        // Explicit GitHub.com binding avoids sending credentials to an arbitrary remote host.
        if host != "github.com" {
            return None;
        }
        let path = path
            .trim_end_matches('/')
            .strip_suffix(".git")
            .unwrap_or(path.trim_end_matches('/'));
        let (owner, name) = path.split_once('/')?;
        if !component(owner) || !component(name) {
            return None;
        }
        Some(Self {
            host: host.into(),
            owner: owner.into(),
            name: name.into(),
            remote_name: remote_name.into(),
        })
    }
    fn validate(&self) -> Result<(), String> {
        if self.host != "github.com" || !component(&self.owner) || !component(&self.name) {
            Err("Unsupported or invalid GitHub remote".into())
        } else {
            Ok(())
        }
    }
    fn selector(&self) -> String {
        format!("{}/{}/{}", self.host, self.owner, self.name)
    }
    fn endpoint(&self, tail: &str) -> String {
        format!("repos/{}/{}/{}", self.owner, self.name, tail)
    }
    pub async fn status(&self, token: CancellationToken) -> GitHubStatus {
        let available = resolve_program("gh").is_some();
        let authenticated = available
            && run(
                self,
                vec![
                    "api".into(),
                    "user".into(),
                    "--hostname".into(),
                    self.host.clone(),
                    "--jq".into(),
                    ".login".into(),
                ],
                token,
            )
            .await
            .is_ok();
        GitHubStatus {
            available,
            authenticated,
            message: if !available {
                "Install GitHub CLI (gh) to connect"
            } else if authenticated {
                "Connected using GitHub CLI"
            } else {
                "GitHub authentication unavailable. Run gh auth login in a terminal and retry"
            }
            .into(),
            repository: self.clone(),
        }
    }
    pub async fn read(
        &self,
        request: GitHubRead,
        token: CancellationToken,
    ) -> Result<GitHubResponse, String> {
        let expected = if let GitHubRead::PullRequestFiles {
            number,
            expected_head,
            ..
        } = &request
        {
            validate_head(expected_head)?;
            self.require_head(*number, expected_head, token.clone())
                .await?;
            Some((*number, expected_head.clone()))
        } else {
            None
        };
        let repo = self.selector();
        let pr_fields="number,title,body,state,url,author,baseRefName,headRefName,headRefOid,isDraft,reviewDecision,statusCheckRollup,reviews,comments,files,changedFiles,additions,deletions";
        let issue_fields = "number,title,body,state,url,author,labels,assignees,comments";
        let args = match request {
            GitHubRead::Repository => strings(&[
                "repo",
                "view",
                &repo,
                "--json",
                "nameWithOwner,url,description,defaultBranchRef,isPrivate",
            ]),
            GitHubRead::PullRequests { state, limit } => {
                valid_state(&state)?;
                strings(&[
                    "pr",
                    "list",
                    "--repo",
                    &repo,
                    "--state",
                    &state,
                    "--limit",
                    &limit.clamp(1, 100).to_string(),
                    "--json",
                    "number,title,state,url,author,headRefName,isDraft,updatedAt",
                ])
            }
            GitHubRead::Issues { state, limit } => {
                valid_state(&state)?;
                strings(&[
                    "issue",
                    "list",
                    "--repo",
                    &repo,
                    "--state",
                    &state,
                    "--limit",
                    &limit.clamp(1, 100).to_string(),
                    "--json",
                    "number,title,state,url,author,updatedAt",
                ])
            }
            GitHubRead::PullRequest { number } => strings(&[
                "pr",
                "view",
                &number.to_string(),
                "--repo",
                &repo,
                "--json",
                pr_fields,
            ]),
            GitHubRead::Issue { number } => strings(&[
                "issue",
                "view",
                &number.to_string(),
                "--repo",
                &repo,
                "--json",
                issue_fields,
            ]),
            GitHubRead::CurrentPullRequest { branch } => {
                valid_ref(&branch)?;
                strings(&[
                    "pr", "list", "--repo", &repo, "--head", &branch, "--state", "open", "--limit",
                    "10", "--json", pr_fields,
                ])
            }
            GitHubRead::Checks { number } => strings(&[
                "pr",
                "view",
                &number.to_string(),
                "--repo",
                &repo,
                "--json",
                "number,headRefOid,statusCheckRollup",
            ]),
            GitHubRead::Reviews { number } => strings(&[
                "pr",
                "view",
                &number.to_string(),
                "--repo",
                &repo,
                "--json",
                "number,headRefOid,reviews,comments,reviewDecision",
            ]),
            GitHubRead::PullRequestFiles { number, page, .. } => strings(&[
                "api",
                &self.endpoint(&format!(
                    "pulls/{number}/files?per_page=30&page={}",
                    page.clamp(1, 1000)
                )),
                "--hostname",
                &self.host,
            ]),
        };
        let json = run(self, args, token.clone()).await?;
        if let Some((number, expected_head)) = expected {
            self.require_head(number, &expected_head, token).await?;
        }
        let value: serde_json::Value = serde_json::from_str(&json)
            .map_err(|_| "GitHub CLI returned invalid JSON".to_owned())?;
        let items = if value.is_array() {
            serde_json::from_value(value)
        } else {
            serde_json::from_value(value).map(|item| vec![item])
        }
        .map_err(|error| format!("Unsupported GitHub response: {error}"))?;
        Ok(GitHubResponse { items })
    }
    async fn require_head(
        &self,
        number: u32,
        expected: &str,
        token: CancellationToken,
    ) -> Result<(), String> {
        let json = run(
            self,
            strings(&[
                "pr",
                "view",
                &number.to_string(),
                "--repo",
                &self.selector(),
                "--json",
                "headRefOid",
            ]),
            token,
        )
        .await?;
        let item: GitHubItem = serde_json::from_str(&json)
            .map_err(|_| "GitHub returned an invalid pull request head".to_owned())?;
        compare_head(expected, &item.head_ref_oid)
    }
    pub async fn create_pull_request(
        &self,
        request: GitHubCreatePullRequest,
        token: CancellationToken,
    ) -> Result<String, String> {
        valid_ref(&request.base)?;
        valid_ref(&request.head)?;
        valid_body(&request.body)?;
        if request.title.trim().is_empty() || request.title.len() > 1000 {
            return Err("Enter a pull request title of at most 1000 bytes".into());
        }
        let mut args = strings(&[
            "pr",
            "create",
            "--repo",
            &self.selector(),
            "--title",
            &request.title,
            "--body",
            &request.body,
            "--base",
            &request.base,
            "--head",
            &request.head,
        ]);
        if request.draft {
            args.push("--draft".into())
        }
        let url = run(self, args, token)
            .await
            .map_err(action_error)?
            .trim()
            .to_owned();
        if !url.starts_with(&format!(
            "https://{}/{}/{}/pull/",
            self.host, self.owner, self.name
        )) || url.chars().any(char::is_whitespace)
        {
            return Err("GitHub created a pull request but returned an unexpected URL. Refresh the pull request list".into());
        }
        Ok(url)
    }
    pub async fn review(
        &self,
        request: GitHubReview,
        token: CancellationToken,
    ) -> Result<String, String> {
        valid_body(&request.body)?;
        validate_head(&request.expected_head)?;
        // REST commit_id binds the review to the commit actually reviewed, even if the branch advances.
        let event = match request.event {
            GitHubReviewEvent::Approve => "APPROVE",
            GitHubReviewEvent::Comment => "COMMENT",
            GitHubReviewEvent::RequestChanges => "REQUEST_CHANGES",
        };
        if event != "APPROVE" && request.body.trim().is_empty() {
            return Err("A comment is required for this review".into());
        }
        run(
            self,
            strings(&[
                "api",
                &self.endpoint(&format!("pulls/{}/reviews", request.number)),
                "--hostname",
                &self.host,
                "--method",
                "POST",
                "--raw-field",
                &format!("event={event}"),
                "--raw-field",
                &format!("body={}", request.body),
                "--raw-field",
                &format!("commit_id={}", request.expected_head),
            ]),
            token,
        )
        .await
        .map_err(action_error)?;
        Ok("Review submitted".into())
    }
}
fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| (*s).into()).collect()
}
fn valid_ref(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 512
        || value.starts_with('-')
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        Err("Invalid branch name".into())
    } else {
        Ok(())
    }
}
fn valid_body(value: &str) -> Result<(), String> {
    if value.len() > 65536 || value.contains('\0') {
        Err("Message exceeds 64 KiB or contains NUL".into())
    } else {
        Ok(())
    }
}
fn valid_state(state: &str) -> Result<(), String> {
    if ["open", "closed", "all"].contains(&state) {
        Ok(())
    } else {
        Err("Invalid list state".into())
    }
}
async fn bounded(mut stream: impl AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    (&mut stream)
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "Cannot read GitHub CLI output".to_owned())?;
    if bytes.len() > 4 * 1024 * 1024 {
        Err("GitHub response exceeds 4 MiB. Narrow the query".into())
    } else {
        Ok(bytes)
    }
}
async fn run(
    repo: &GitHubRepository,
    args: Vec<String>,
    token: CancellationToken,
) -> Result<String, String> {
    repo.validate()?;
    if token.is_cancelled() {
        return Err("GitHub request cancelled".into());
    }
    let program = resolve_program("gh").ok_or("GitHub CLI (gh) is not installed")?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for key in [
        "GH_REPO",
        "GH_HOST",
        "GH_DEBUG",
        "GH_FORCE_TTY",
        "GH_BROWSER",
        "BROWSER",
    ] {
        cmd.env_remove(key);
    }
    cmd.env("GH_PROMPT_DISABLED", "1")
        .env("GH_PAGER", "cat")
        .env("NO_COLOR", "1");
    let mut child = cmd
        .spawn()
        .map_err(|_| "Could not start GitHub CLI".to_owned())?;
    let stdout = child.stdout.take().ok_or("GitHub stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("GitHub stderr unavailable")?;
    let operation = async {
        let (status, out, err) = tokio::try_join!(
            async {
                child
                    .wait()
                    .await
                    .map_err(|_| "GitHub CLI wait failed".to_owned())
            },
            bounded(stdout),
            bounded(stderr)
        )?;
        let _ = err;
        if !status.success() {
            return Err("GitHub request failed. Check gh authentication, repository permissions, network access, and GitHub API limits".into());
        }
        String::from_utf8(out).map_err(|_| "GitHub CLI returned non UTF-8 output".into())
    };
    tokio::select! { result=tokio::time::timeout(Duration::from_secs(45),operation)=>result.map_err(|_|"GitHub request timed out".to_owned())?, _=async{loop{if token.is_cancelled(){break}tokio::time::sleep(Duration::from_millis(40)).await}}=>Err("GitHub request cancelled".into()) }
}
fn null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

fn action_error(message: String) -> String {
    format!("{message}. The GitHub action may have completed. Refresh before retrying")
}

fn validate_head(head: &str) -> Result<(), String> {
    if head.len() == 40 && head.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(
            "A valid displayed pull request commit is required. Refresh pull request details"
                .into(),
        )
    }
}
fn compare_head(expected: &str, actual: &str) -> Result<(), String> {
    validate_head(expected)?;
    if expected == actual {
        Ok(())
    } else {
        Err("The pull request head changed. Refresh pull request details before loading file patches".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires installed authenticated gh and explicit SPAN_GITHUB_ACCEPTANCE_REPO"]
    async fn native_read_only_acceptance() {
        let selected = std::env::var("SPAN_GITHUB_ACCEPTANCE_REPO")
            .expect("set SPAN_GITHUB_ACCEPTANCE_REPO to github.com/owner/repository");
        let repo = GitHubRepository::from_remote("acceptance", &format!("https://{selected}"))
            .expect("supported GitHub repository");
        assert!(
            repo.status(CancellationToken::default())
                .await
                .authenticated
        );
        let details = repo
            .read(GitHubRead::Repository, CancellationToken::default())
            .await
            .unwrap();
        assert_eq!(
            details.items[0].name_with_owner,
            format!("{}/{}", repo.owner, repo.name)
        );
        let prs = repo
            .read(
                GitHubRead::PullRequests {
                    state: "open".into(),
                    limit: 1,
                },
                CancellationToken::default(),
            )
            .await
            .unwrap();
        if let Some(pr) = prs.items.first() {
            let details = repo
                .read(
                    GitHubRead::PullRequest { number: pr.number },
                    CancellationToken::default(),
                )
                .await
                .unwrap();
            let expected_head = details.items[0].head_ref_oid.clone();
            for request in [
                GitHubRead::PullRequestFiles {
                    number: pr.number,
                    page: 1,
                    expected_head,
                },
                GitHubRead::Checks { number: pr.number },
                GitHubRead::Reviews { number: pr.number },
            ] {
                repo.read(request, CancellationToken::default())
                    .await
                    .unwrap();
            }
        }
        repo.read(
            GitHubRead::Issues {
                state: "open".into(),
                limit: 1,
            },
            CancellationToken::default(),
        )
        .await
        .unwrap();
    }
    #[test]
    fn refuses_patches_from_an_advanced_or_invalid_head() {
        assert!(compare_head(&"a".repeat(40), &"a".repeat(40)).is_ok());
        assert!(compare_head(&"a".repeat(40), &"b".repeat(40))
            .unwrap_err()
            .contains("Refresh"));
        assert!(compare_head("", &"a".repeat(40)).is_err());
        let request = GitHubRead::PullRequestFiles {
            number: 12,
            page: 2,
            expected_head: "a".repeat(40),
        };
        let json = serde_json::to_value(request).unwrap();
        assert_eq!(json["expectedHead"], "a".repeat(40));
    }
    #[test]
    fn remote_binding() {
        for remote in [
            "https://github.com/team/repo.git",
            "git@github.com:team/repo.git",
            "ssh://git@github.com/team/repo.git",
            "git@github.com:1kentom/span.git",
        ] {
            assert!(
                GitHubRepository::from_remote("origin", remote).is_some(),
                "{remote}"
            );
        }
        for remote in [
            "https://evil.test/team/repo",
            "https://github.com/team/repo/extra",
            "https://user@github.com/team/repo",
            "git@github.com:../repo",
            "https://github.com/-flag/repo",
            "https://github.com/team/repo?token=x",
        ] {
            assert!(
                GitHubRepository::from_remote("origin", remote).is_none(),
                "{remote}"
            );
        }
    }
    #[test]
    fn nullable_rollup_and_typed_patch() {
        let pr:GitHubItem=serde_json::from_str(r#"{"number":1,"reviewDecision":null,"statusCheckRollup":null,"headRefOid":"abc","reviews":[{"state":"APPROVED","body":"looks good","author":{"login":"reviewer"}}]}"#).unwrap();
        assert_eq!(pr.reviews[0].state, "APPROVED");
        assert!(pr.status_check_rollup.is_empty());
        let file:GitHubItem=serde_json::from_str(r#"{"filename":"src/main.rs","previous_filename":"src/old.rs","patch":"@@ -1 +1 @@\n-old\n+new","additions":1,"deletions":1}"#).unwrap();
        assert_eq!(file.previous_filename.as_deref(), Some("src/old.rs"));
        assert!(file.patch.unwrap().contains("+new"));
    }
    #[test]
    fn rejects_option_branches_and_oversized_messages() {
        assert!(valid_ref("--web").is_err());
        assert!(valid_ref("feature/valid").is_ok());
        assert!(valid_body(&"a".repeat(65537)).is_err());
    }
}
