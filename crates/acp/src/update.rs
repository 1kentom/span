//! Check-only update status for ACP agents and for Span itself (ADR 0004).
//!
//! Nothing here installs, downloads or runs an update. Each check is a plain
//! GET with no identifiers. A version that cannot be read or compared is
//! reported as unknown, never as up to date.
use crate::registry::{registry, Entry};
use crate::InstalledAgent;
use serde::{Deserialize, Serialize};
use span_core::version::{self, Version};
use span_core::ToolInfo;
use specta::Type;
use std::cmp::Ordering;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStatus {
    UpToDate,
    UpdateAvailable,
    Unknown,
    NotInstalled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdate {
    pub id: String,
    pub name: String,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub status: UpdateStatus,
    /// True for agents Span installed from the registry, false for programs
    /// found on the user's PATH that Span does not manage.
    pub managed: bool,
    /// How to update, as text only. Span never runs it from this check.
    pub how_to_update: Option<String>,
    /// The registry's repository link for the agent, when it has one.
    pub repository: Option<String>,
    /// Why the status is what it is, when that is not obvious.
    pub note: Option<String>,
}

/// Local programs that map to a registry entry. `same_version_line` is true
/// only when the registry entry is that very program, so its version can be
/// compared with the local `--version`. The ACP adapters for Claude Code and
/// Codex are separate packages with their own version numbers, so comparing
/// them with the CLI would be misleading.
struct LocalProgram {
    tool: &'static str,
    registry: &'static str,
    same_version_line: bool,
}
const LOCAL_PROGRAMS: &[LocalProgram] = &[
    LocalProgram {
        tool: "opencode",
        registry: "opencode",
        same_version_line: true,
    },
    LocalProgram {
        tool: "gemini",
        registry: "gemini",
        same_version_line: true,
    },
    LocalProgram {
        tool: "claude",
        registry: "claude-acp",
        same_version_line: false,
    },
    LocalProgram {
        tool: "codex",
        registry: "codex-acp",
        same_version_line: false,
    },
];

fn judge(installed: Option<&str>, latest: Option<&str>) -> UpdateStatus {
    match (installed, latest) {
        (Some(installed), Some(latest)) => match version::compare(installed, latest) {
            Some(Ordering::Less) => UpdateStatus::UpdateAvailable,
            // A build newer than the registry is not behind it.
            Some(_) => UpdateStatus::UpToDate,
            None => UpdateStatus::Unknown,
        },
        _ => UpdateStatus::Unknown,
    }
}

/// Pure comparison of installed agents, local probes and a registry snapshot.
pub(crate) fn compute(
    entries: &[Entry],
    installed: &[InstalledAgent],
    tools: &[ToolInfo],
) -> Vec<AgentUpdate> {
    let mut rows: Vec<AgentUpdate> = Vec::new();
    let mut ids: Vec<&str> = installed.iter().map(|agent| agent.id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    for id in ids {
        // Several versions can sit side by side; the newest readable one runs.
        let newest = installed
            .iter()
            .filter(|agent| agent.id == id)
            .max_by(|a, b| version::compare(&a.version, &b.version).unwrap_or(Ordering::Equal))
            .map(|agent| agent.version.clone());
        let entry = entries.iter().find(|entry| entry.id == id);
        let latest = entry.map(|entry| entry.version.clone());
        let status = judge(newest.as_deref(), latest.as_deref());
        let package = entry
            .and_then(|entry| entry.distribution.npx.as_ref())
            .map(|npx| npx.package.clone());
        rows.push(AgentUpdate {
            id: id.to_owned(),
            name: entry.map_or_else(|| id.to_owned(), |entry| entry.name.clone()),
            installed_version: newest,
            latest_version: latest,
            status,
            managed: true,
            how_to_update: (status == UpdateStatus::UpdateAvailable)
                .then(|| package.map(install_text))
                .flatten(),
            repository: entry.and_then(|entry| entry.repository.clone()),
            note: match (entry.is_some(), status) {
                (false, _) => Some("This agent is no longer listed in the ACP registry.".into()),
                (true, UpdateStatus::Unknown) => {
                    Some("A version number was not recognised, so no comparison was made.".into())
                }
                _ => None,
            },
        });
    }
    for program in LOCAL_PROGRAMS {
        if rows.iter().any(|row| row.id == program.tool) {
            continue;
        }
        let Some(tool) = tools.iter().find(|tool| tool.id == program.tool) else {
            continue;
        };
        let entry = entries.iter().find(|entry| entry.id == program.registry);
        if !tool.available {
            rows.push(AgentUpdate {
                id: tool.id.clone(),
                name: tool.name.clone(),
                installed_version: None,
                latest_version: None,
                status: UpdateStatus::NotInstalled,
                managed: false,
                how_to_update: None,
                repository: None,
                note: None,
            });
            continue;
        }
        let local = tool.version.as_deref().and_then(version::extract);
        let (latest, repository, note) = if program.same_version_line {
            match entry {
                Some(entry) => (Some(entry.version.clone()), entry.repository.clone(), None),
                None => (
                    None,
                    None,
                    Some("The ACP registry has no entry for this program.".to_owned()),
                ),
            }
        } else {
            (
                None,
                None,
                Some(
                    "The registry lists an ACP adapter with its own version numbers, which is not comparable with this program's version.".to_owned(),
                ),
            )
        };
        let status = if program.same_version_line {
            judge(local.as_deref(), latest.as_deref())
        } else {
            UpdateStatus::Unknown
        };
        let note = note.or_else(|| {
            (local.is_none()).then(|| "The program's version output was not recognised.".to_owned())
        });
        rows.push(AgentUpdate {
            id: tool.id.clone(),
            name: tool.name.clone(),
            installed_version: local,
            latest_version: latest,
            status,
            managed: false,
            // Span does not manage this program. Update it the way you
            // installed it; the repository link has its instructions.
            how_to_update: None,
            repository,
            note,
        });
    }
    rows
}

/// The existing registry install, re-run. Mirrors `install_registry_agent`.
fn install_text(package: String) -> String {
    format!(
        "Install it again from the ACP registry in Span. Span runs: npm install --ignore-scripts --no-audit --no-fund --no-package-lock --prefix <agent cache> -- {package}"
    )
}

/// Reads the registry (one GET), the agents Span installed, and the local
/// version probes. Registry errors are returned as they are.
pub async fn agent_update_status(cache_dir: &Path) -> Result<Vec<AgentUpdate>, String> {
    let registry = registry().await?;
    let directory = cache_dir.to_owned();
    let installed = tokio::task::spawn_blocking(move || crate::list_installed_agents(&directory))
        .await
        .map_err(|e| format!("Installed agent task failed: {e}"))??;
    let tools = tokio::task::spawn_blocking(span_core::list_tools)
        .await
        .map_err(|e| format!("Tool probe task failed: {e}"))?;
    Ok(compute(&registry.agents, &installed, &tools))
}

// ---- Span itself ----

/// Public GitHub Releases for this repository. The website reads the same
/// listing (apps/web/main.js, apps/web/scripts/sync-releases.mjs) and
/// docs/releases.md names the repository as the publishing target.
const RELEASES_URL: &str = "https://api.github.com/repos/1kentom/span/releases?per_page=100";
const RELEASE_PAGE_PREFIX: &str = "https://github.com/1kentom/span/releases/";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AppUpdateStatus {
    UpToDate,
    UpdateAvailable,
    NotConfigured,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdate {
    pub current_version: String,
    /// `nightly`, `preview`, `stable`, or `unknown` for a version that does not
    /// follow the release scheme.
    pub channel: String,
    pub latest_version: Option<String>,
    pub newer: bool,
    /// The GitHub release page. Opened only by a user click.
    pub release_url: Option<String>,
    pub status: AppUpdateStatus,
    /// The error, or the reason the check is not configured.
    pub message: Option<String>,
}

/// The channel of a build, from its own version (docs/releases.md).
pub fn channel_of(current: &str) -> String {
    match Version::parse(current) {
        Some(version) if !version.is_prerelease() => "stable".into(),
        Some(version) => match version.pre_label() {
            Some(label @ ("nightly" | "preview")) => label.into(),
            _ => "unknown".into(),
        },
        None => "unknown".into(),
    }
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

fn failure(current: &str, channel: String, message: impl Into<String>) -> AppUpdate {
    AppUpdate {
        current_version: current.to_owned(),
        channel,
        latest_version: None,
        newer: false,
        release_url: None,
        status: AppUpdateStatus::Error,
        message: Some(message.into()),
    }
}

/// Decide from a GitHub releases JSON body. Only the build's own channel is
/// considered: a nightly build is compared with nightly releases only.
pub(crate) fn evaluate_app_update(current: &str, body: &[u8]) -> AppUpdate {
    let channel = channel_of(current);
    if channel == "unknown" {
        return failure(
            current,
            channel,
            "This build's version does not name a release channel, so it cannot be compared.",
        );
    }
    let releases: Vec<Release> = match serde_json::from_slice(body) {
        Ok(releases) => releases,
        Err(error) => {
            return failure(
                current,
                channel,
                format!("Unreadable release list from GitHub: {error}"),
            )
        }
    };
    let latest = releases
        .iter()
        .filter(|release| !release.draft && release.html_url.starts_with(RELEASE_PAGE_PREFIX))
        .filter_map(|release| {
            let parsed = Version::parse(&release.tag_name)?;
            let in_channel = if channel == "stable" {
                !release.prerelease && !parsed.is_prerelease()
            } else {
                parsed.pre_label() == Some(channel.as_str())
            };
            in_channel.then_some((parsed, release))
        })
        .max_by(|a, b| a.0.cmp(&b.0));
    let Some((latest_version, release)) = latest else {
        return failure(
            current,
            channel.clone(),
            format!("No published {channel} release was found in the latest 100 releases."),
        );
    };
    let shown = release
        .tag_name
        .strip_prefix(['v', 'V'])
        .unwrap_or(&release.tag_name)
        .to_owned();
    let Some(current_parsed) = Version::parse(current) else {
        return failure(current, channel, "The current version cannot be read.");
    };
    let newer = latest_version > current_parsed;
    AppUpdate {
        current_version: current.to_owned(),
        channel,
        latest_version: Some(shown),
        newer,
        release_url: Some(release.html_url.clone()),
        status: if newer {
            AppUpdateStatus::UpdateAvailable
        } else {
            AppUpdateStatus::UpToDate
        },
        message: None,
    }
}

/// One plain GET of the public release list. `development` builds are not
/// checked: their version is the unstamped source version.
pub async fn check_app_update(current: &str, development: bool) -> AppUpdate {
    if development {
        return AppUpdate {
            current_version: current.to_owned(),
            channel: "development".into(),
            latest_version: None,
            newer: false,
            release_url: None,
            status: AppUpdateStatus::NotConfigured,
            message: Some(
                "Update checks are not configured for this build. Development builds are not compared with published releases."
                    .into(),
            ),
        };
    }
    let channel = channel_of(current);
    match fetch_releases().await {
        Ok(body) => evaluate_app_update(current, &body),
        Err(message) => failure(current, channel, message),
    }
}

async fn fetch_releases() -> Result<Vec<u8>, String> {
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        // GitHub rejects requests without a user agent. It names no version
        // or machine.
        .user_agent("span-update-check")
        .build()
        .map_err(|e| e.to_string())?
        .get(RELEASES_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Could not reach GitHub Releases: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            403 | 429 => "GitHub rate limit reached for unauthenticated requests. Try again later."
                .to_owned(),
            404 => "GitHub Releases for 1kentom/span were not found (404). The repository may be private or renamed.".to_owned(),
            code => format!("GitHub Releases returned HTTP {code}."),
        });
    }
    if response
        .content_length()
        .is_some_and(|size| size > 8_000_000)
    {
        return Err("The release list exceeds the size limit.".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Could not read the release list: {e}"))?;
    if bytes.len() > 8_000_000 {
        return Err("The release list exceeds the size limit.".into());
    }
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    const REGISTRY: &str = include_str!("../tests/fixtures/registry.json");

    fn entries() -> Vec<Entry> {
        #[derive(Deserialize)]
        struct File {
            agents: Vec<Entry>,
        }
        serde_json::from_str::<File>(REGISTRY).unwrap().agents
    }
    fn installed(id: &str, version: &str) -> InstalledAgent {
        InstalledAgent {
            id: id.into(),
            version: version.into(),
            launch: crate::AgentCommand {
                command: "x".into(),
                args: Vec::new(),
                env: Default::default(),
            },
        }
    }
    fn tool(id: &str, version: Option<&str>) -> ToolInfo {
        ToolInfo {
            id: id.into(),
            name: id.into(),
            program: id.into(),
            path: version.map(|_| format!("/bin/{id}")),
            version: version.map(Into::into),
            available: version.is_some(),
            kind: "Agent CLI".into(),
        }
    }
    fn row<'a>(rows: &'a [AgentUpdate], id: &str) -> &'a AgentUpdate {
        rows.iter().find(|row| row.id == id).unwrap()
    }

    #[test]
    fn managed_agents_compare_with_the_registry() {
        let rows = compute(
            &entries(),
            &[
                installed("codex-acp", "2.1.0"),
                installed("codex-acp", "2.3.0"),
                installed("pi-acp", "0.0.9"),
                installed("weird", "nightly"),
                installed("gone", "1.0.0"),
            ],
            &[],
        );
        // The newest installed version is compared, and it is current.
        let codex = row(&rows, "codex-acp");
        assert_eq!(codex.status, UpdateStatus::UpToDate);
        assert_eq!(codex.installed_version.as_deref(), Some("2.3.0"));
        assert!(codex.how_to_update.is_none() && codex.managed);
        // 0.0.9 against 0.0.34 is a numeric, not textual, comparison.
        let pi = row(&rows, "pi-acp");
        assert_eq!(pi.status, UpdateStatus::UpdateAvailable);
        assert_eq!(pi.latest_version.as_deref(), Some("0.0.34"));
        assert!(pi.how_to_update.as_ref().unwrap().contains("pi-acp@0.0.34"));
        // Garbage and missing entries are unknown, never up to date.
        assert_eq!(row(&rows, "weird").status, UpdateStatus::Unknown);
        assert_eq!(row(&rows, "gone").status, UpdateStatus::Unknown);
        assert!(row(&rows, "gone")
            .note
            .as_ref()
            .unwrap()
            .contains("no longer"));
    }

    #[test]
    fn local_programs_use_the_probe_and_never_invent_a_command() {
        let tools = [
            tool("opencode", Some("2.0.32")),
            tool("gemini", Some("0.66.0")),
            tool("claude", Some("2.0.32 (Claude Code)")),
            tool("codex", None),
        ];
        let rows = compute(&entries(), &[], &tools);
        let opencode = row(&rows, "opencode");
        assert_eq!(opencode.status, UpdateStatus::UpdateAvailable);
        assert_eq!(opencode.installed_version.as_deref(), Some("2.0.32"));
        assert_eq!(opencode.latest_version.as_deref(), Some("2.2.0"));
        assert!(!opencode.managed && opencode.how_to_update.is_none());
        assert!(opencode.repository.as_deref().unwrap().contains("opencode"));
        assert_eq!(row(&rows, "gemini").status, UpdateStatus::UpToDate);
        // The registry's Claude entry is an adapter with its own versions.
        let claude = row(&rows, "claude");
        assert_eq!(claude.status, UpdateStatus::Unknown);
        assert_eq!(claude.installed_version.as_deref(), Some("2.0.32"));
        assert!(claude.latest_version.is_none() && claude.how_to_update.is_none());
        assert_eq!(row(&rows, "codex").status, UpdateStatus::NotInstalled);
    }

    #[test]
    fn unreadable_probe_output_is_unknown_and_managed_wins_over_local() {
        let rows = compute(
            &entries(),
            &[installed("gemini", "0.60.0")],
            &[
                tool("opencode", Some("banana")),
                tool("gemini", Some("0.1.0")),
            ],
        );
        assert_eq!(row(&rows, "opencode").status, UpdateStatus::Unknown);
        assert!(row(&rows, "opencode").installed_version.is_none());
        // One row per id: the Span-managed install, not the PATH program.
        assert_eq!(rows.iter().filter(|r| r.id == "gemini").count(), 1);
        assert!(row(&rows, "gemini").managed);
        assert_eq!(row(&rows, "gemini").status, UpdateStatus::UpdateAvailable);
    }

    const RELEASES: &str = r#"[
      {"tag_name":"v0.1.0-nightly.20261029.3","html_url":"https://github.com/1kentom/span/releases/tag/v0.1.0-nightly.20261029.3","draft":false,"prerelease":true},
      {"tag_name":"v0.1.0-nightly.20261028.42","html_url":"https://github.com/1kentom/span/releases/tag/v0.1.0-nightly.20261028.42","draft":false,"prerelease":true},
      {"tag_name":"v0.1.0-nightly.20261030.1","html_url":"https://github.com/1kentom/span/releases/tag/v0.1.0-nightly.20261030.1","draft":true,"prerelease":true},
      {"tag_name":"v0.1.0-nightly.20261031.1","html_url":"https://evil.example/releases/tag/x","draft":false,"prerelease":true},
      {"tag_name":"v0.1.0-preview.20261028.43","html_url":"https://github.com/1kentom/span/releases/tag/v0.1.0-preview.20261028.43","draft":false,"prerelease":true},
      {"tag_name":"v0.1.0","html_url":"https://github.com/1kentom/span/releases/tag/v0.1.0","draft":false,"prerelease":false},
      {"tag_name":"not-a-version","html_url":"https://github.com/1kentom/span/releases/tag/not-a-version","draft":false,"prerelease":false}
    ]"#;

    #[test]
    fn app_update_follows_the_builds_own_channel() {
        let behind = evaluate_app_update("0.1.0-nightly.20261028.7", RELEASES.as_bytes());
        assert_eq!(behind.status, AppUpdateStatus::UpdateAvailable);
        assert!(behind.newer && behind.channel == "nightly");
        // Drafts and links outside the repository's release pages are ignored.
        assert_eq!(
            behind.latest_version.as_deref(),
            Some("0.1.0-nightly.20261029.3")
        );
        assert!(behind.release_url.unwrap().ends_with("nightly.20261029.3"));

        let current = evaluate_app_update("0.1.0-nightly.20261029.3", RELEASES.as_bytes());
        assert_eq!(current.status, AppUpdateStatus::UpToDate);
        assert!(!current.newer);
        let ahead = evaluate_app_update("0.1.0-nightly.20261101.1", RELEASES.as_bytes());
        assert_eq!(ahead.status, AppUpdateStatus::UpToDate);

        let preview = evaluate_app_update("0.1.0-preview.20261021.40", RELEASES.as_bytes());
        assert_eq!(preview.status, AppUpdateStatus::UpdateAvailable);
        assert_eq!(preview.channel, "preview");
        let stable = evaluate_app_update("0.1.0", RELEASES.as_bytes());
        assert_eq!(stable.status, AppUpdateStatus::UpToDate);
        assert_eq!(stable.channel, "stable");
    }

    #[test]
    fn the_websites_synced_release_list_parses() {
        // A real GitHub listing saved by apps/web/scripts/sync-releases.mjs.
        let body = include_str!("../../../apps/web/releases.json");
        let result = evaluate_app_update("0.1.0-nightly.20261001.1", body.as_bytes());
        assert_eq!(
            result.status,
            AppUpdateStatus::UpdateAvailable,
            "{result:?}"
        );
        assert!(result.release_url.unwrap().starts_with(RELEASE_PAGE_PREFIX));
    }

    #[test]
    fn app_update_failures_are_errors_not_no_update() {
        let none = evaluate_app_update("0.2.0", b"[]");
        assert_eq!(none.status, AppUpdateStatus::Error);
        assert!(none
            .message
            .unwrap()
            .contains("No published stable release"));
        let garbage = evaluate_app_update("0.1.0", b"{\"message\":\"Not Found\"}");
        assert_eq!(garbage.status, AppUpdateStatus::Error);
        assert!(garbage.message.unwrap().contains("Unreadable"));
        let unnamed = evaluate_app_update("0.1.0-rc.1", RELEASES.as_bytes());
        assert_eq!(unnamed.status, AppUpdateStatus::Error);
        assert_eq!(
            evaluate_app_update("dev", b"[]").status,
            AppUpdateStatus::Error
        );
    }

    #[test]
    fn development_builds_say_not_configured_without_a_request() {
        let result = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(check_app_update("0.1.0", true));
        assert_eq!(result.status, AppUpdateStatus::NotConfigured);
        assert!(result
            .message
            .unwrap()
            .starts_with("Update checks are not configured for this build"));
    }

    #[test]
    fn channels_come_from_the_version() {
        assert_eq!(channel_of("0.1.0-nightly.20261028.7"), "nightly");
        assert_eq!(channel_of("0.1.0-preview.20261028.43"), "preview");
        assert_eq!(channel_of("0.1.0"), "stable");
        assert_eq!(channel_of("0.1.0-beta"), "unknown");
        assert_eq!(channel_of("junk"), "unknown");
    }
}
