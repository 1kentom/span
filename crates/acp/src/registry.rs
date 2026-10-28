use crate::{AgentCommand, InstalledAgent, RegistryAgent};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const SUPPORTED_AGENTS: &[&str] = &[
    "codex-acp",
    "cursor",
    "claude-acp",
    "gemini",
    "github-copilot-cli",
    "glm-acp-agent",
    "grok-build",
    "opencode",
];
#[derive(Deserialize)]
pub(crate) struct Registry {
    version: String,
    pub(crate) agents: Vec<Entry>,
}
#[derive(Deserialize)]
pub(crate) struct Entry {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) version: String,
    #[serde(default)]
    description: String,
    pub(crate) repository: Option<String>,
    icon: Option<String>,
    pub(crate) distribution: Distribution,
}
#[derive(Deserialize)]
pub(crate) struct Distribution {
    pub(crate) npx: Option<Npx>,
}
#[derive(Deserialize)]
pub(crate) struct Npx {
    pub(crate) package: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

pub(crate) async fn registry() -> Result<Registry, String> {
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?
        .get(REGISTRY_URL)
        .send()
        .await
        .map_err(|e| format!("Fetch ACP registry: {e}"))?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    if response
        .content_length()
        .is_some_and(|size| size > 8_000_000)
    {
        return Err("ACP registry exceeds size limit".into());
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 8_000_000 {
        return Err("ACP registry exceeds size limit".into());
    }
    let registry: Registry =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid ACP registry: {e}"))?;
    if registry.version != "1.0.0" {
        return Err(format!(
            "Unsupported ACP registry format {}",
            registry.version
        ));
    }
    Ok(registry)
}

/// Fetch metadata only. No registry command is executed by discovery.
pub async fn fetch_registry() -> Result<Vec<RegistryAgent>, String> {
    Ok(registry()
        .await?
        .agents
        .into_iter()
        .filter(|entry| SUPPORTED_AGENTS.contains(&entry.id.as_str()))
        .map(|entry| RegistryAgent {
            installable: entry
                .distribution
                .npx
                .as_ref()
                .is_some_and(|n| valid_package(&n.package, &entry.version)),
            package: entry.distribution.npx.map(|n| n.package),
            id: entry.id,
            name: entry.name,
            version: entry.version,
            description: entry.description,
            repository: entry.repository,
            icon: entry.icon,
        })
        .collect())
}

/// Explicit installation stores a pinned package locally with lifecycle scripts disabled.
/// Starting the installed agent executes its code with the user's OS privileges.
pub async fn install_registry_agent(
    agent_id: &str,
    cache_dir: &Path,
) -> Result<InstalledAgent, String> {
    if !SUPPORTED_AGENTS.contains(&agent_id) {
        return Err("This adapter is outside Span's supported agent catalog. Use an explicit local custom command if you trust it.".into());
    }
    let entry = registry()
        .await?
        .agents
        .into_iter()
        .find(|entry| entry.id == agent_id)
        .ok_or("Unknown registry agent")?;
    let npx = entry.distribution.npx.ok_or(
        "Phase 0.1 supports npm agents. Use a custom executable for binary or uvx distributions.",
    )?;
    if !valid_component(&entry.id)
        || !valid_component(&entry.version)
        || !valid_package(&npx.package, &entry.version)
    {
        return Err(
            "Registry agent must use an exact pinned npm version and safe identifier".into(),
        );
    }
    let _mutation = crate::managed::mutation_guard().await;
    let stage = crate::managed::StagedInstall::new(cache_dir, &entry.id, &entry.version)?;
    let directory = &stage.directory;
    let npm = crate::launch::prepare_command(AgentCommand {
        command: if cfg!(windows) { "npm.cmd" } else { "npm" }.into(),
        args: Vec::new(),
        env: BTreeMap::new(),
    })
    .map_err(|error| format!("Install agent, ensure Node.js and npm are installed: {error}"))?;
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(180),
        tokio::process::Command::new(npm.command)
            .envs(npm.env)
            .args([
                "install",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--no-package-lock",
                "--prefix",
            ])
            .arg(directory)
            .arg("--")
            .arg(&npx.package)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "Agent installation timed out after 180 seconds")?
    .map_err(|e| format!("Run npm, ensure Node.js is installed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Agent installation failed: {}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(8000)
                .collect::<String>()
        ));
    }
    let package_name = npx
        .package
        .rsplit_once('@')
        .map(|(name, _)| name)
        .ok_or("Unpinned npm package")?;
    let package_root = directory.join("node_modules").join(package_name);
    let package_json = tokio::fs::read(package_root.join("package.json"))
        .await
        .map_err(|e| format!("Read installed agent metadata: {e}"))?;
    let package: serde_json::Value =
        serde_json::from_slice(&package_json).map_err(|e| e.to_string())?;
    if package["name"].as_str() != Some(package_name)
        || package["version"].as_str() != Some(&entry.version)
    {
        return Err("Installed package identity does not match the registry pin".into());
    }
    let canonical_package = package_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !canonical_package.starts_with(&stage.directory) {
        return Err("Installed package escapes its managed staging directory".into());
    }
    let bin = crate::npm_bin::select_bin(package_name, &package["bin"])?;
    let launch = launch_bin(&package_root, bin, npx.args, npx.env)?;
    let installed = InstalledAgent {
        id: entry.id,
        version: entry.version,
        launch,
    };
    stage.publish(installed)
}

pub fn list_installed_agents(cache_dir: &Path) -> Result<Vec<InstalledAgent>, String> {
    let mut installed = Vec::new();
    if !cache_dir.exists() {
        return Ok(installed);
    }
    for agent in std::fs::read_dir(cache_dir).map_err(|e| e.to_string())? {
        let agent = agent.map_err(|e| e.to_string())?;
        if agent.file_name().to_string_lossy().starts_with('.')
            || !agent.file_type().map_err(|e| e.to_string())?.is_dir()
        {
            continue;
        }
        for version in std::fs::read_dir(agent.path()).map_err(|e| e.to_string())? {
            let version = version.map_err(|e| e.to_string())?;
            if !version
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                continue;
            }
            let path = version.path().join("span-agent.json");
            let metadata = match std::fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.to_string()),
            };
            if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 131_072
            {
                continue;
            }
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            let agent: InstalledAgent = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Invalid installed agent manifest: {e}"))?;
            if agent.id
                != path
                    .parent()
                    .and_then(Path::parent)
                    .and_then(Path::file_name)
                    .map(|value| value.to_string_lossy())
                    .unwrap_or_default()
                || agent.version != version.file_name().to_string_lossy()
            {
                continue;
            }
            if std::path::Path::new(&agent.launch.command).exists() {
                installed.push(agent);
            }
        }
    }
    installed.sort_by(|a, b| (&a.id, &a.version).cmp(&(&b.id, &b.version)));
    Ok(installed)
}
fn launch_bin(
    package_root: &Path,
    bin: &str,
    mut args: Vec<String>,
    env: BTreeMap<String, String>,
) -> Result<AgentCommand, String> {
    use std::io::Read;
    let root = package_root
        .canonicalize()
        .map_err(|e| format!("Resolve installed package: {e}"))?;
    let executable = root
        .join(bin)
        .canonicalize()
        .map_err(|e| format!("Resolve installed executable: {e}"))?;
    if !executable.starts_with(&root) || !executable.is_file() {
        return Err("Package executable escapes its installation".into());
    }
    let mut prefix = [0; 128];
    let count = std::fs::File::open(&executable)
        .and_then(|mut file| file.read(&mut prefix))
        .map_err(|e| e.to_string())?;
    let shebang = String::from_utf8_lossy(&prefix[..count]);
    let node_script = matches!(
        executable.extension().and_then(|value| value.to_str()),
        Some("js" | "mjs" | "cjs")
    ) || (shebang.starts_with("#!")
        && shebang
            .lines()
            .next()
            .is_some_and(|line| line.contains("node")));
    let command = if node_script {
        args.insert(0, executable.to_string_lossy().into_owned());
        span_core::resolve_program("node")
            .ok_or("Node.js executable was not found in PATH or common installation directories")?
            .to_string_lossy()
            .into_owned()
    } else {
        executable.to_string_lossy().into_owned()
    };
    Ok(AgentCommand { command, args, env })
}

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}
fn valid_package(package: &str, version: &str) -> bool {
    let Some((name, pin)) = package.rsplit_once('@') else {
        return false;
    };
    pin == version
        && valid_component(pin)
        && pin.chars().next().is_some_and(|c| c.is_ascii_digit())
        && !name.is_empty()
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '-' | '_' | '.'))
        && !name.contains("..")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn unsupported_registry_agents_are_rejected_before_network_or_install() {
        let cache = tempfile::tempdir().unwrap();
        let error = install_registry_agent("agoragentic-acp", cache.path())
            .await
            .unwrap_err();
        assert!(error.contains("supported agent catalog"));
        assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 0);
    }
    #[test]
    fn registry_pins_and_identifiers() {
        assert!(valid_package(
            "@agentclientprotocol/codex-acp@2.3.0",
            "2.3.0"
        ));
        for bad in [
            "package@latest",
            "package@^1.0.0",
            "$(touch /tmp/bad)@1.0.0",
            "../bad@1.0.0",
        ] {
            assert!(!valid_package(bad, "1.0.0"));
        }
    }
    #[test]
    fn launches_node_script_without_platform_shell_shims() {
        let package = tempfile::tempdir().unwrap();
        std::fs::write(
            package.path().join("cli.js"),
            "#!/usr/bin/env node\nconsole.log('agent');",
        )
        .unwrap();
        let launch = launch_bin(
            package.path(),
            "cli.js",
            vec!["--acp".into()],
            BTreeMap::new(),
        )
        .unwrap();
        assert!(Path::new(&launch.command).is_absolute());
        assert_eq!(launch.args.len(), 2);
        assert!(launch.args[0].ends_with("cli.js"));
        assert_eq!(launch.args[1], "--acp");
        assert!(launch_bin(package.path(), "../outside.js", Vec::new(), BTreeMap::new()).is_err());
    }
    #[test]
    fn current_registry_shape() {
        let registry: Registry = serde_json::from_str(r#"{"version":"1.0.0","agents":[{"id":"fixture","name":"Fixture","version":"1.0.0","distribution":{"npx":{"package":"fixture@1.0.0"}}}]}"#).unwrap();
        assert_eq!(registry.agents.len(), 1);
    }
}
