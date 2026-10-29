//! Local Git operates on repository files and the index, never editor buffers.
mod advanced;
mod advanced_types;
mod hosting_checkout;
#[cfg(test)]
mod hosting_checkout_tests;
mod management;
mod management_types;
mod merge;
pub use management_types::*;
mod extended;
mod history;
#[cfg(test)]
mod management_tests;
#[cfg(test)]
mod merge_tests;
pub use advanced_types::*;
#[cfg(test)]
mod advanced_tests;
mod mutation;
mod process;
mod read;
mod status;
#[cfg(test)]
mod tests;
mod types;

use crate::{CancellationToken, CoreError, CoreWorkspace, Result};
use process::{GitCommand, GitOutput};
use std::collections::hash_map::RandomState;
use std::ffi::OsString;
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::Duration;
pub use types::*;

const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const INDEX_LIMIT: usize = 32 * 1024 * 1024;
const TEXT_LIMIT: usize = 1024 * 1024;
static NEXT_SERVICE: AtomicU64 = AtomicU64::new(1);
static HASHER: OnceLock<RandomState> = OnceLock::new();

#[derive(Clone)]
pub struct GitService(Arc<Inner>);

struct Inner {
    workspace_root: PathBuf,
    instance: String,
    cancelled: CancellationToken,
    mutation: tokio::sync::Mutex<()>,
    identity: Mutex<Option<(String, String)>>,
    enabled: Mutex<Option<String>>,
}

#[derive(Clone)]
struct RepoIdentity {
    root: PathBuf,
    git_dir: PathBuf,
    index: PathBuf,
    id: String,
}

impl CoreWorkspace {
    /// Called while the desktop holds the workspace lock through a working-tree mutation.
    pub fn git_has_dirty_buffers(&self) -> bool {
        self.buffers
            .values()
            .any(|buffer| buffer.revision != buffer.saved_revision)
            || self.has_dirty_settings_buffer()
    }

    /// Capture under the editor mutex, then run Git after releasing it.
    pub fn git_service(&self) -> Result<GitService> {
        if self.root.as_os_str().is_empty() {
            return Err(error("Open a project folder before using Git"));
        }
        Ok(GitService::from_root(self.root.clone()))
    }
}

impl GitService {
    pub fn new(workspace_root: PathBuf) -> Result<Self> {
        let root = workspace_root
            .canonicalize()
            .map_err(|e| error(format!("Resolve workspace: {e}")))?;
        if !root.is_dir() {
            return Err(error("Git workspace must be a directory"));
        }
        Ok(Self::from_root(root))
    }

    fn from_root(workspace_root: PathBuf) -> Self {
        let number = NEXT_SERVICE.fetch_add(1, Ordering::Relaxed);
        let instance = opaque(&[
            workspace_root.as_os_str().as_encoded_bytes(),
            &number.to_le_bytes(),
        ]);
        Self(Arc::new(Inner {
            workspace_root,
            instance,
            cancelled: CancellationToken::default(),
            mutation: tokio::sync::Mutex::new(()),
            identity: Mutex::new(None),
            enabled: Mutex::new(None),
        }))
    }

    pub fn cancel(&self) {
        self.0.cancelled.cancel();
    }

    /// Stop in-flight Git and drain any index transaction before publishing a new workspace.
    pub async fn shutdown(&self) -> Result<()> {
        self.cancel();
        let _idle = self.0.mutation.lock().await;
        Ok(())
    }

    /// Discover only. Status can invoke configured Git clean filters, so no
    /// index inspection happens until the user explicitly enables this session.
    pub async fn context(&self, cancellation: CancellationToken) -> Result<GitContext> {
        self.check_cancelled(&cancellation)?;
        let workspace_root = path_text(&self.0.workspace_root)?;
        match self.discover(&cancellation).await {
            Ok(Some(repo)) => {
                let head = self.head(&repo, &cancellation).await?;
                let symbolic = self
                    .run_repo(
                        &repo,
                        strings(&["symbolic-ref", "--quiet", "--short", "HEAD"]),
                        vec![],
                        None,
                        &cancellation,
                    )
                    .await?;
                if !symbolic.success && symbolic.code != Some(1) {
                    require_success(&symbolic)?;
                }
                let branch = if symbolic.success {
                    Some(
                        String::from_utf8_lossy(
                            symbolic
                                .stdout
                                .strip_suffix(b"\n")
                                .unwrap_or(&symbolic.stdout),
                        )
                        .into_owned(),
                    )
                } else {
                    None
                };
                let detached = branch.is_none() && head.is_some();
                let unborn = head.is_none();
                let prefix = self
                    .0
                    .workspace_root
                    .strip_prefix(&repo.root)
                    .map_err(|_| error("Workspace moved outside its repository"))?;
                let enabled = self
                    .0
                    .enabled
                    .lock()
                    .map_err(|_| error("Git activation state is unavailable"))?
                    .as_deref()
                    == Some(repo.id.as_str());
                let repository = GitRepository {
                    id: repo.id,
                    root: path_text(&repo.root)?,
                    workspace_prefix: git_path(prefix).to_string_lossy().into_owned(),
                    branch,
                    head,
                    detached,
                    unborn,
                };
                Ok(GitContext {
                    workspace_root,
                    repository: Some(repository),
                    unavailable_reason: None,
                    enabled,
                })
            }
            Ok(None) => {
                *self
                    .0
                    .identity
                    .lock()
                    .map_err(|_| error("Git identity state is unavailable"))? = None;
                *self
                    .0
                    .enabled
                    .lock()
                    .map_err(|_| error("Git activation state is unavailable"))? = None;
                Ok(GitContext {
                    workspace_root,
                    repository: None,
                    unavailable_reason: Some(
                        "This folder is not inside a local Git working tree".into(),
                    ),
                    enabled: false,
                })
            }
            Err(reason) if !cancellation.is_cancelled() && !self.0.cancelled.is_cancelled() => {
                Ok(GitContext {
                    workspace_root,
                    repository: None,
                    unavailable_reason: Some(reason.to_string()),
                    enabled: false,
                })
            }
            Err(reason) => Err(reason),
        }
    }

    /// Consent is scoped to this precise repository and workspace session.
    pub async fn enable(
        &self,
        context_id: &str,
        cancellation: CancellationToken,
    ) -> Result<GitStatus> {
        let repo = self
            .discover(&cancellation)
            .await?
            .ok_or_else(|| error("The repository is no longer available"))?;
        if repo.id != context_id {
            return Err(error(
                "Git repository changed. Refresh before enabling Git.",
            ));
        }
        *self
            .0
            .enabled
            .lock()
            .map_err(|_| error("Git activation state is unavailable"))? = Some(repo.id.clone());
        self.status_for(&repo, &cancellation).await
    }

    pub async fn status(
        &self,
        context_id: &str,
        cancellation: CancellationToken,
    ) -> Result<GitStatus> {
        let repo = self.repo_for(context_id, &cancellation).await?;
        self.status_for(&repo, &cancellation).await
    }

    fn check_cancelled(&self, token: &CancellationToken) -> Result<()> {
        if token.is_cancelled() || self.0.cancelled.is_cancelled() {
            return Err(error(
                "Git request cancelled because its workspace or request ended",
            ));
        }
        Ok(())
    }

    async fn discover(&self, token: &CancellationToken) -> Result<Option<RepoIdentity>> {
        self.check_cancelled(token)?;
        let version = self
            .run_at(
                &self.0.workspace_root,
                strings(&["--version"]),
                vec![],
                None,
                token,
            )
            .await?;
        require_success(&version)?;
        let version = String::from_utf8_lossy(&version.stdout);
        let number = version.split_whitespace().nth(2).unwrap_or_default();
        let mut parts = number.split('.').filter_map(|p| p.parse::<u32>().ok());
        let major = parts.next().unwrap_or_default();
        let minor = parts.next().unwrap_or_default();
        if major < 2 || (major == 2 && minor < 30) {
            return Err(error(
                "Git 2.30 or newer is required for guarded local Git operations",
            ));
        }
        let root = self
            .run_at(
                &self.0.workspace_root,
                strings(&["rev-parse", "--show-toplevel"]),
                vec![],
                None,
                token,
            )
            .await?;
        if !root.success {
            let message = String::from_utf8_lossy(&root.stderr);
            if message.contains("not a git repository")
                || message.contains("must be run in a work tree")
            {
                return Ok(None);
            }
            require_success(&root)?;
        }
        let root = output_path(&root.stdout, &self.0.workspace_root)?;
        if !self.0.workspace_root.starts_with(&root) {
            return Err(error(
                "Discovered repository does not contain the opened workspace",
            ));
        }
        let git_dir = self
            .path_query(&root, &["rev-parse", "--absolute-git-dir"], token)
            .await?;
        let common_dir = self
            .path_query(&root, &["rev-parse", "--git-common-dir"], token)
            .await?;
        let index = self
            .path_query_allow_missing(&root, &["rev-parse", "--git-path", "index"], token)
            .await?;
        let meta =
            fs::metadata(&git_dir).map_err(|e| error(format!("Read repository identity: {e}")))?;
        #[cfg(unix)]
        let stamp = {
            use std::os::unix::fs::MetadataExt;
            format!("{}:{}", meta.dev(), meta.ino())
        };
        #[cfg(not(unix))]
        let stamp = format!("{:?}", meta.created().ok());
        let key = opaque(&[
            root.as_os_str().as_encoded_bytes(),
            git_dir.as_os_str().as_encoded_bytes(),
            common_dir.as_os_str().as_encoded_bytes(),
            stamp.as_bytes(),
        ]);
        let mut identity = self
            .0
            .identity
            .lock()
            .map_err(|_| error("Git identity state is unavailable"))?;
        let id = match identity.as_ref() {
            Some((known, id)) if known == &key => id.clone(),
            _ => {
                let serial = NEXT_SERVICE.fetch_add(1, Ordering::Relaxed);
                let id = opaque(&[
                    self.0.instance.as_bytes(),
                    key.as_bytes(),
                    &serial.to_le_bytes(),
                ]);
                *identity = Some((key, id.clone()));
                id
            }
        };
        Ok(Some(RepoIdentity {
            root,
            git_dir,
            index,
            id,
        }))
    }

    async fn repo_for(&self, context_id: &str, token: &CancellationToken) -> Result<RepoIdentity> {
        let repo = self
            .discover(token)
            .await?
            .ok_or_else(|| error("The Git repository is no longer available. Refresh Git."))?;
        if repo.id != context_id {
            return Err(error(
                "Git workspace or repository changed. Refresh before continuing.",
            ));
        }
        if self
            .0
            .enabled
            .lock()
            .map_err(|_| error("Git activation state is unavailable"))?
            .as_deref()
            != Some(repo.id.as_str())
        {
            return Err(error("Enable Git for this repository and workspace session first. Git may run configured helpers."));
        }
        Ok(repo)
    }

    async fn status_for(
        &self,
        repo: &RepoIdentity,
        token: &CancellationToken,
    ) -> Result<GitStatus> {
        let before = read_index(&repo.index)?;
        let output = self
            .checked(
                repo,
                strings(&[
                    "status",
                    "--porcelain=v2",
                    "-z",
                    "--branch",
                    "--untracked-files=all",
                    "--ignore-submodules=none",
                    "--renames",
                ]),
                vec![],
                None,
                token,
            )
            .await?;
        let parsed = status::parse_status(&output.stdout)?;
        let entries = self
            .checked(
                repo,
                strings(&["ls-files", "--stage", "-z"]),
                vec![],
                None,
                token,
            )
            .await?;
        let after = read_index(&repo.index)?;
        let head = self.head(repo, token).await?;
        if before != after || head != parsed.head {
            return Err(error(
                "Git changed while status was being read. Refresh Git.",
            ));
        }
        let prefix = self
            .0
            .workspace_root
            .strip_prefix(&repo.root)
            .map_err(|_| error("Workspace moved outside its repository"))?;
        let repository = GitRepository {
            id: repo.id.clone(),
            root: path_text(&repo.root)?,
            workspace_prefix: git_path(prefix).to_string_lossy().into_owned(),
            branch: parsed.branch,
            head: parsed.head,
            detached: parsed.detached,
            unborn: parsed.unborn,
        };
        let branch = repository.branch.as_deref().unwrap_or_default();
        let head = repository.head.as_deref().unwrap_or_default();
        Ok(GitStatus {
            index_revision: opaque(&[&before, head.as_bytes(), branch.as_bytes()]),
            staged_snapshot: opaque(&[&entries.stdout, head.as_bytes(), branch.as_bytes()]),
            repository,
            entries: parsed.entries,
            operation: operation(repo),
            truncated: false,
        })
    }

    async fn head(&self, repo: &RepoIdentity, token: &CancellationToken) -> Result<Option<String>> {
        let output = self
            .run_repo(
                repo,
                strings(&["rev-parse", "--verify", "HEAD"]),
                vec![],
                None,
                token,
            )
            .await?;
        if !output.success {
            return Ok(None);
        }
        Ok(Some(object_id(
            output.stdout.strip_suffix(b"\n").unwrap_or(&output.stdout),
        )?))
    }

    async fn path_query(
        &self,
        root: &Path,
        args: &[&str],
        token: &CancellationToken,
    ) -> Result<PathBuf> {
        let path = self.path_query_allow_missing(root, args, token).await?;
        path.canonicalize()
            .map_err(|e| error(format!("Resolve Git metadata path: {e}")))
    }

    async fn path_query_allow_missing(
        &self,
        root: &Path,
        args: &[&str],
        token: &CancellationToken,
    ) -> Result<PathBuf> {
        let output = self
            .run_at(root, strings(args), vec![], None, token)
            .await?;
        require_success(&output)?;
        let bytes = output.stdout.strip_suffix(b"\n").unwrap_or(&output.stdout);
        let value = std::str::from_utf8(bytes)
            .map_err(|_| error("Git metadata path is not valid UTF-8"))?;
        let path = PathBuf::from(value);
        Ok(if path.is_absolute() {
            path
        } else {
            root.join(path)
        })
    }

    async fn checked(
        &self,
        repo: &RepoIdentity,
        args: Vec<OsString>,
        env: Vec<(OsString, OsString)>,
        input: Option<Vec<u8>>,
        token: &CancellationToken,
    ) -> Result<GitOutput> {
        let output = self.run_repo(repo, args, env, input, token).await?;
        require_success(&output)?;
        Ok(output)
    }

    async fn run_repo(
        &self,
        repo: &RepoIdentity,
        args: Vec<OsString>,
        env: Vec<(OsString, OsString)>,
        input: Option<Vec<u8>>,
        token: &CancellationToken,
    ) -> Result<GitOutput> {
        let mut bound = vec![
            OsString::from("--git-dir"),
            git_path(&repo.git_dir),
            OsString::from("--work-tree"),
            git_path(&repo.root),
        ];
        bound.extend(args);
        self.run_at(&repo.root, bound, env, input, token).await
    }

    async fn run_at(
        &self,
        root: &Path,
        args: Vec<OsString>,
        env: Vec<(OsString, OsString)>,
        input: Option<Vec<u8>>,
        token: &CancellationToken,
    ) -> Result<GitOutput> {
        self.check_cancelled(token)?;
        let program = git_program(&self.0.workspace_root)
            .ok_or_else(|| error("Git is unavailable. Install Git and refresh this view."))?;
        let mut all = strings(&[
            "--no-optional-locks",
            "--literal-pathspecs",
            "--no-pager",
            "--no-replace-objects",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "maintenance.auto=false",
            "-c",
            "gc.auto=0",
            "-c",
            "color.ui=false",
            "-c",
            "log.showSignature=false",
        ]);
        all.extend(args);
        process::run(
            GitCommand {
                program,
                cwd: root.to_owned(),
                args: all,
                env,
                input,
                timeout: Duration::from_secs(30),
                max_output: OUTPUT_LIMIT,
            },
            token,
            &self.0.cancelled,
        )
        .await
    }
}

/// Windows Git and its sh expect regular DOS or UNC paths, not Rust's verbatim prefix.
fn git_path(path: &Path) -> OsString {
    #[cfg(windows)]
    {
        let text = path.as_os_str().to_string_lossy();
        let text = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            format!("//{}", rest.replace('\\', "/"))
        } else {
            text.strip_prefix(r"\\?\")
                .unwrap_or(&text)
                .replace('\\', "/")
        };
        text.into()
    }
    #[cfg(not(windows))]
    {
        path.as_os_str().to_owned()
    }
}

fn git_program(workspace: &Path) -> Option<PathBuf> {
    let candidates = [
        crate::resolve_program("git"),
        if cfg!(unix) {
            Some(PathBuf::from("/usr/bin/git"))
        } else {
            None
        },
    ];
    candidates
        .into_iter()
        .flatten()
        .filter(|p| p.is_absolute())
        .filter_map(|p| p.canonicalize().ok())
        .find(|p| {
            if !p.is_file() || p.starts_with(workspace) {
                return false;
            }
            #[cfg(target_os = "macos")]
            if p == Path::new("/usr/bin/git") {
                // The macOS shim can open an installer when developer tools are absent.
                // Only invoke it when an actual selected developer Git is installed.
                let selected = std::env::var_os("DEVELOPER_DIR")
                    .map(PathBuf::from)
                    .or_else(|| fs::read_link("/var/db/xcode_select_link").ok());
                return selected
                    .map(|root| {
                        root.join("usr/bin/git").is_file()
                            || root.join("Contents/Developer/usr/bin/git").is_file()
                    })
                    .unwrap_or_else(|| {
                        Path::new("/Library/Developer/CommandLineTools/usr/bin/git").is_file()
                    });
            }
            true
        })
}

fn strings(items: &[&str]) -> Vec<OsString> {
    items.iter().map(OsString::from).collect()
}
fn error(message: impl Into<String>) -> CoreError {
    CoreError::Git(message.into())
}
fn path_text(path: &Path) -> Result<String> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| error("Git path is not valid UTF-8"))
}
fn output_path(bytes: &[u8], cwd: &Path) -> Result<PathBuf> {
    let text = std::str::from_utf8(bytes.strip_suffix(b"\n").unwrap_or(bytes))
        .map_err(|_| error("Repository path is not valid UTF-8"))?;
    let path = Path::new(text);
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        cwd.join(path)
    };
    path.canonicalize()
        .map_err(|e| error(format!("Resolve repository path: {e}")))
}
fn object_id(bytes: &[u8]) -> Result<String> {
    if !matches!(bytes.len(), 40 | 64) || !bytes.iter().all(u8::is_ascii_hexdigit) {
        return Err(error("Git returned an invalid object identity"));
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| error("Git object identity is not ASCII"))
}
fn opaque(parts: &[&[u8]]) -> String {
    let mut hasher = HASHER.get_or_init(RandomState::new).build_hasher();
    for part in parts {
        hasher.write_usize(part.len());
        hasher.write(part);
    }
    format!("{:016x}", hasher.finish())
}
fn read_index(path: &Path) -> Result<Vec<u8>> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(error(format!("Read Git index: {e}"))),
    };
    let mut bytes = Vec::new();
    file.take(INDEX_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| error(format!("Read Git index: {e}")))?;
    if bytes.len() > INDEX_LIMIT {
        return Err(error("Git index exceeds the 32 MiB limit for this view. Use Git externally for this repository."));
    }
    Ok(bytes)
}
fn require_success(output: &GitOutput) -> Result<()> {
    if output.success {
        return Ok(());
    }
    let message: String = String::from_utf8_lossy(&output.stderr)
        .chars()
        .take(4000)
        .collect();
    Err(error(if message.trim().is_empty() {
        format!("Git exited with status {:?}", output.code)
    } else {
        redact_git_output(message.trim())
    }))
}
fn operation(repo: &RepoIdentity) -> Option<String> {
    for (file, label) in [
        ("MERGE_HEAD", "merge"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase or am"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("sequencer", "sequencer operation"),
    ] {
        if repo.git_dir.join(file).exists() {
            return Some(label.into());
        }
    }
    None
}
fn relative_path(path: &str) -> Result<PathBuf> {
    let value = Path::new(path);
    if path.is_empty()
        || path.contains('\0')
        || value.is_absolute()
        || value.components().any(|p| {
            matches!(
                p,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(error(
            "Git paths must be literal paths inside the repository",
        ));
    }
    if value
        .components()
        .any(|p| p.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git"))
    {
        return Err(error("Git metadata cannot be selected as working files"));
    }
    Ok(value.to_owned())
}

/// Avoid forwarding credentials embedded in remote URL diagnostics to the UI.
fn redact_git_output(value: &str) -> String {
    let mut result = value.to_owned();
    let mut offset = 0;
    while let Some(scheme) = result[offset..].find("://") {
        let start = offset + scheme + 3;
        let end = result[start..]
            .find(|c: char| c.is_whitespace() || matches!(c, '/' | '\'' | '\"' | '<' | '>'))
            .map(|i| start + i)
            .unwrap_or(result.len());
        if let Some(at) = result[start..end].rfind('@') {
            result.replace_range(start..start + at, "[redacted]");
            offset = start + "[redacted]".len() + 1;
        } else {
            offset = end;
        }
        if offset >= result.len() {
            break;
        }
    }
    result
}
