//! Language server installer: download, SHA-256 verification, safe extraction,
//! atomic cache install and update pruning.
//!
//! Guarantees:
//! - Every artifact is verified against its pinned SHA-256 before it is
//!   extracted; a mismatch deletes the file and returns a typed error.
//! - Nothing downloaded is ever executed. npm tarballs are only unpacked.
//! - Extraction rejects absolute paths, `..`, and symlinks or hardlinks that
//!   would resolve outside the target directory.
//! - A version becomes visible only through an atomic rename of a fully built
//!   staging tree, and only a [`MARKER_FILE`] with the verified hashes marks it
//!   complete.
//! - Dropping the install future cancels it: network IO stops at once and the
//!   blocking extraction stops at the next entry.
//!
//! Layout notes: `TarGz` and `Zip` artifacts are extracted into the version
//! directory root. `Gz` artifacts are decompressed to the path named by
//! `Artifact::entry`. `NpmTarball` artifacts are extracted npm style to
//! `node_modules/<package name>/` (name read from the package's own
//! `package.json`), so several packages can coexist and resolve each other;
//! `entry` is therefore relative to the version directory, for example
//! `node_modules/@vtsls/language-server/bin/vtsls.js`.
//!
//! Proxy environment variables are deliberately not consulted (no credential
//! handling); the default [`HttpFetch`] sends no auth headers.

use super::cache::{
    server_slug, validate_version, CacheError, InstallMarker, ServerCache, MARKER_FILE,
};
use super::spec::{Artifact, ArtifactKind, InstallPlan, ServerId};
use bytes::Bytes;
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs;
use std::future::Future;
use std::io::{self, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

// ---------------------------------------------------------------------------
// Errors and progress
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    #[error("invalid install plan: {0}")]
    InvalidPlan(String),
    #[error("network error fetching {url}: {message}")]
    Network { url: String, message: String },
    #[error("unexpected HTTP status {status} from {url}")]
    HttpStatus { url: String, status: u16 },
    #[error("download of {url} was truncated: expected {expected} bytes, received {received}")]
    Truncated {
        url: String,
        expected: u64,
        received: u64,
    },
    #[error("download of {url} exceeds the size limit of {limit} bytes")]
    TooLarge { url: String, limit: u64 },
    #[error("integrity check failed for {url}: expected sha256 {expected}, got {actual}")]
    HashMismatch {
        url: String,
        expected: String,
        actual: String,
    },
    #[error("unsafe archive entry {entry:?}: {reason}")]
    UnsafeArchive { entry: String, reason: &'static str },
    #[error("archive error: {0}")]
    Archive(String),
    #[error("declared entry point {0:?} is missing after extraction")]
    EntryMissing(String),
    #[error("install was cancelled")]
    Cancelled,
    #[error("io error ({context}): {source}")]
    Io {
        context: String,
        #[source]
        source: io::Error,
    },
    #[error(transparent)]
    Cache(#[from] CacheError),
}

fn io_ctx(context: impl Into<String>) -> impl FnOnce(io::Error) -> InstallError {
    let context = context.into();
    move |source| InstallError::Io { context, source }
}

/// Progress events. Sent with `try_send`, so a full or closed channel never
/// stalls the install (events may be dropped; use a roomy channel).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallProgress {
    Started {
        server: ServerId,
        version: String,
        artifacts: usize,
    },
    /// The version was already complete; nothing was downloaded.
    AlreadyInstalled {
        version: String,
    },
    /// Another installer holds the lock for this server version.
    WaitingForLock,
    Downloading {
        index: usize,
        received: u64,
        total: Option<u64>,
    },
    /// A previously verified download was reused instead of fetched again.
    Reused {
        index: usize,
    },
    Verifying {
        index: usize,
    },
    Extracting {
        index: usize,
    },
    Finalizing,
    Pruned {
        versions: Vec<String>,
    },
    Finished {
        version: String,
    },
}

struct Reporter<'a>(Option<&'a mpsc::Sender<InstallProgress>>);

impl Reporter<'_> {
    fn emit(&self, event: InstallProgress) {
        if let Some(tx) = self.0 {
            let _ = tx.try_send(event);
        }
    }
}

// ---------------------------------------------------------------------------
// Injectable download source
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct FetchError(pub String);

/// Streaming response body.
pub trait ByteStream: Send {
    /// Next chunk, or `None` at end of body.
    fn next_chunk(&mut self) -> BoxFuture<'_, Result<Option<Bytes>, FetchError>>;
}

pub struct FetchResponse {
    pub status: u16,
    pub content_length: Option<u64>,
    pub body: Box<dyn ByteStream>,
}

/// Download source. The production implementation is [`HttpFetch`]; tests can
/// point it at a local server or substitute their own.
pub trait Fetch: Send + Sync + 'static {
    fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<FetchResponse, FetchError>>;
}

/// HTTPS (rustls) client. No proxy lookup, no credentials, no extra headers.
pub struct HttpFetch {
    client: reqwest::Client,
}

impl HttpFetch {
    pub fn new() -> Result<Self, FetchError> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .user_agent(concat!("span-lsp-installer/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| FetchError(e.to_string()))?;
        Ok(Self { client })
    }
}

struct HttpBody(reqwest::Response);

impl ByteStream for HttpBody {
    fn next_chunk(&mut self) -> BoxFuture<'_, Result<Option<Bytes>, FetchError>> {
        Box::pin(async move {
            self.0
                .chunk()
                .await
                .map_err(|e| FetchError(e.without_url().to_string()))
        })
    }
}

impl Fetch for HttpFetch {
    fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<FetchResponse, FetchError>> {
        Box::pin(async move {
            let resp = self
                .client
                .get(url)
                .send()
                .await
                .map_err(|e| FetchError(e.without_url().to_string()))?;
            Ok(FetchResponse {
                status: resp.status().as_u16(),
                content_length: resp.content_length(),
                body: Box::new(HttpBody(resp)),
            })
        })
    }
}

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct InstallerOptions {
    /// How long to wait for another installer of the same server version.
    pub lock_wait: Duration,
    /// Abort a download that stalls for this long between chunks.
    pub chunk_timeout: Duration,
    pub max_download_bytes: u64,
    pub max_extracted_bytes: u64,
}

impl Default for InstallerOptions {
    fn default() -> Self {
        Self {
            lock_wait: Duration::from_secs(600),
            chunk_timeout: Duration::from_secs(60),
            max_download_bytes: 1 << 30,
            max_extracted_bytes: 4 << 30,
        }
    }
}

/// Result of a successful install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledServer {
    pub version: String,
    /// `<cache_root>/<server>/<version>`
    pub dir: PathBuf,
    /// Absolute path of each artifact's declared entry, in plan order.
    pub entries: Vec<PathBuf>,
}

pub struct Installer {
    cache: ServerCache,
    fetch: Arc<dyn Fetch>,
    options: InstallerOptions,
}

/// Sets the flag when dropped so detached blocking work stops early.
struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

impl Installer {
    pub fn new(cache: ServerCache, fetch: Arc<dyn Fetch>) -> Self {
        Self::with_options(cache, fetch, InstallerOptions::default())
    }

    pub fn with_options(
        cache: ServerCache,
        fetch: Arc<dyn Fetch>,
        options: InstallerOptions,
    ) -> Self {
        Self {
            cache,
            fetch,
            options,
        }
    }

    pub fn cache(&self) -> &ServerCache {
        &self.cache
    }

    /// Installs `plan` for `server` (no-op when already complete).
    ///
    /// `in_use` lists versions currently running; they are never pruned. After
    /// success, versions other than the new one, `in_use`, and the newest
    /// previous one (rollback) are removed.
    pub async fn install(
        &self,
        server: ServerId,
        plan: &InstallPlan,
        in_use: &[String],
        progress: Option<&mpsc::Sender<InstallProgress>>,
    ) -> Result<InstalledServer, InstallError> {
        validate_plan(plan)?;
        let report = Reporter(progress);
        let installed = self.installed(server, plan);

        if self.cache.is_complete(server, plan).await {
            report.emit(InstallProgress::AlreadyInstalled {
                version: plan.version.clone(),
            });
            return Ok(installed);
        }

        let cancel = CancelOnDrop(Arc::new(AtomicBool::new(false)));
        let (_lock, _) = match self
            .cache
            .acquire_lock(server, &plan.version, Duration::ZERO)
            .await
        {
            Ok(v) => v,
            Err(CacheError::LockTimeout(_)) => {
                report.emit(InstallProgress::WaitingForLock);
                self.cache
                    .acquire_lock(server, &plan.version, self.options.lock_wait)
                    .await?
            }
            Err(e) => return Err(e.into()),
        };

        // Another installer may have finished while we waited.
        if self.cache.is_complete(server, plan).await {
            report.emit(InstallProgress::AlreadyInstalled {
                version: plan.version.clone(),
            });
        } else {
            report.emit(InstallProgress::Started {
                server,
                version: plan.version.clone(),
                artifacts: plan.artifacts.len(),
            });
            self.build(server, plan, &report, &cancel.0).await?;
        }

        let pruned = self.cache.prune(server, &plan.version, in_use).await;
        if !pruned.is_empty() {
            report.emit(InstallProgress::Pruned { versions: pruned });
        }
        report.emit(InstallProgress::Finished {
            version: plan.version.clone(),
        });
        Ok(installed)
    }

    fn installed(&self, server: ServerId, plan: &InstallPlan) -> InstalledServer {
        let dir = self.cache.version_dir(server, &plan.version);
        InstalledServer {
            version: plan.version.clone(),
            entries: plan.artifacts.iter().map(|a| dir.join(&a.entry)).collect(),
            dir,
        }
    }

    async fn build(
        &self,
        server: ServerId,
        plan: &InstallPlan,
        report: &Reporter<'_>,
        cancel: &Arc<AtomicBool>,
    ) -> Result<(), InstallError> {
        let staging = self.cache.staging_dir(server, &plan.version);
        let downloads = staging.join("downloads");
        let tree = staging.join("tree");
        tokio::fs::create_dir_all(&downloads)
            .await
            .map_err(io_ctx(format!("create {}", downloads.display())))?;

        // Reset leftovers of an interrupted attempt. Verified downloads are
        // kept (and re-hashed before reuse); partial ones and trees are not.
        clean_staging(&staging, &downloads).await?;
        tokio::fs::create_dir_all(&tree)
            .await
            .map_err(io_ctx(format!("create {}", tree.display())))?;

        for (index, artifact) in plan.artifacts.iter().enumerate() {
            let file = self
                .ensure_download(index, artifact, &downloads, report, cancel)
                .await?;
            report.emit(InstallProgress::Extracting { index });
            let art = artifact.clone();
            let tree2 = tree.clone();
            let stage2 = staging.clone();
            let cancel2 = cancel.clone();
            let limit = self.options.max_extracted_bytes;
            run_blocking(move || {
                extract_artifact(&file, &art, index, &tree2, &stage2, limit, &cancel2)
            })
            .await?;
        }

        // Entry points must exist; native binaries become executable.
        let t = tree.clone();
        let artifacts = plan.artifacts.clone();
        run_blocking(move || finish_entries(&t, &artifacts)).await?;

        report.emit(InstallProgress::Finalizing);
        let marker = serde_json::to_vec_pretty(&InstallMarker::for_plan(plan))
            .map_err(|e| InstallError::Archive(e.to_string()))?;
        tokio::fs::write(tree.join(MARKER_FILE), marker)
            .await
            .map_err(io_ctx("write install marker"))?;

        let final_dir = self.cache.version_dir(server, &plan.version);
        if tokio::fs::symlink_metadata(&final_dir).await.is_ok() {
            // Partial or corrupt (not complete, or we would not be here).
            tokio::fs::remove_dir_all(&final_dir)
                .await
                .map_err(io_ctx(format!("remove {}", final_dir.display())))?;
        }
        tokio::fs::rename(&tree, &final_dir)
            .await
            .map_err(io_ctx(format!("activate {}", final_dir.display())))?;
        let _ = tokio::fs::remove_dir_all(&staging).await;
        Ok(())
    }

    /// Returns the path of a downloaded file whose SHA-256 equals the pin.
    async fn ensure_download(
        &self,
        index: usize,
        artifact: &Artifact,
        downloads: &Path,
        report: &Reporter<'_>,
        cancel: &Arc<AtomicBool>,
    ) -> Result<PathBuf, InstallError> {
        let expected = artifact.sha256.to_ascii_lowercase();
        let verified = downloads.join(format!("{expected}.verified"));
        if tokio::fs::metadata(&verified).await.is_ok() {
            report.emit(InstallProgress::Verifying { index });
            let actual = hash_file(&verified, cancel).await?;
            if actual == expected {
                report.emit(InstallProgress::Reused { index });
                return Ok(verified);
            }
            let _ = tokio::fs::remove_file(&verified).await;
        }

        let part = downloads.join(format!("{index}.part"));
        let result = self.download_to(&artifact.url, &part, index, report).await;
        if let Err(e) = result {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(e);
        }

        report.emit(InstallProgress::Verifying { index });
        let actual = hash_file(&part, cancel).await;
        let actual = match actual {
            Ok(a) => a,
            Err(e) => {
                let _ = tokio::fs::remove_file(&part).await;
                return Err(e);
            }
        };
        if actual != expected {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(InstallError::HashMismatch {
                url: artifact.url.clone(),
                expected,
                actual,
            });
        }
        tokio::fs::rename(&part, &verified)
            .await
            .map_err(io_ctx("store verified download"))?;
        Ok(verified)
    }

    async fn download_to(
        &self,
        url: &str,
        part: &Path,
        index: usize,
        report: &Reporter<'_>,
    ) -> Result<(), InstallError> {
        let net = |m: String| InstallError::Network {
            url: url.to_string(),
            message: m,
        };
        let limit = self.options.max_download_bytes;
        let mut resp = self.fetch.get(url).await.map_err(|e| net(e.0))?;
        if !(200..300).contains(&resp.status) {
            return Err(InstallError::HttpStatus {
                url: url.to_string(),
                status: resp.status,
            });
        }
        let total = resp.content_length;
        if total.is_some_and(|t| t > limit) {
            return Err(InstallError::TooLarge {
                url: url.to_string(),
                limit,
            });
        }
        let mut file = tokio::fs::File::create(part)
            .await
            .map_err(io_ctx(format!("create {}", part.display())))?;
        let mut received: u64 = 0;
        loop {
            let next = tokio::time::timeout(self.options.chunk_timeout, resp.body.next_chunk())
                .await
                .map_err(|_| net("download stalled".to_string()))?
                .map_err(|e| net(e.0))?;
            let Some(chunk) = next else { break };
            received += chunk.len() as u64;
            if received > limit {
                return Err(InstallError::TooLarge {
                    url: url.to_string(),
                    limit,
                });
            }
            file.write_all(&chunk)
                .await
                .map_err(io_ctx("write download"))?;
            report.emit(InstallProgress::Downloading {
                index,
                received,
                total,
            });
        }
        file.flush().await.map_err(io_ctx("flush download"))?;
        drop(file);
        if let Some(expected) = total {
            if expected != received {
                return Err(InstallError::Truncated {
                    url: url.to_string(),
                    expected,
                    received,
                });
            }
        }
        Ok(())
    }
}

fn validate_plan(plan: &InstallPlan) -> Result<(), InstallError> {
    validate_version(&plan.version)?;
    if plan.artifacts.is_empty() {
        return Err(InstallError::InvalidPlan("no artifacts".into()));
    }
    for a in &plan.artifacts {
        let hex_ok = a.sha256.len() == 64 && a.sha256.chars().all(|c| c.is_ascii_hexdigit());
        if !hex_ok {
            return Err(InstallError::InvalidPlan(format!(
                "sha256 of {} is not 64 hex digits",
                a.url
            )));
        }
        let comps = safe_components(Path::new(&a.entry), 0, &a.entry)?;
        if comps.is_empty() {
            return Err(InstallError::InvalidPlan("empty entry path".into()));
        }
    }
    Ok(())
}

async fn clean_staging(staging: &Path, downloads: &Path) -> Result<(), InstallError> {
    let mut rd = tokio::fs::read_dir(staging)
        .await
        .map_err(io_ctx("read staging"))?;
    while let Some(ent) = rd.next_entry().await.map_err(io_ctx("read staging"))? {
        if ent.path() != downloads {
            remove_any(&ent.path()).await?;
        }
    }
    let mut rd = tokio::fs::read_dir(downloads)
        .await
        .map_err(io_ctx("read downloads"))?;
    while let Some(ent) = rd.next_entry().await.map_err(io_ctx("read downloads"))? {
        if ent.path().extension().and_then(|e| e.to_str()) != Some("verified") {
            remove_any(&ent.path()).await?;
        }
    }
    Ok(())
}

async fn remove_any(path: &Path) -> Result<(), InstallError> {
    let md = tokio::fs::symlink_metadata(path)
        .await
        .map_err(io_ctx(format!("stat {}", path.display())))?;
    let res = if md.is_dir() {
        tokio::fs::remove_dir_all(path).await
    } else {
        tokio::fs::remove_file(path).await
    };
    res.map_err(io_ctx(format!("remove {}", path.display())))
}

async fn run_blocking<T, F>(f: F) -> Result<T, InstallError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, InstallError> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| InstallError::Archive(format!("worker failed: {e}")))?
}

async fn hash_file(path: &Path, cancel: &Arc<AtomicBool>) -> Result<String, InstallError> {
    let path = path.to_path_buf();
    let cancel = cancel.clone();
    run_blocking(move || {
        let mut file = fs::File::open(&path).map_err(io_ctx(format!("open {}", path.display())))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(InstallError::Cancelled);
            }
            let n = file.read(&mut buf).map_err(io_ctx("hash read"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(hex(&hasher.finalize()))
    })
    .await
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

// ---------------------------------------------------------------------------
// Safe extraction (blocking; run inside spawn_blocking)
// ---------------------------------------------------------------------------

fn unsafe_entry(entry: &str, reason: &'static str) -> InstallError {
    InstallError::UnsafeArchive {
        entry: entry.to_string(),
        reason,
    }
}

/// Splits an archive path into plain components, dropping `strip` leading ones.
/// Rejects absolute paths, drive prefixes and `..`.
fn safe_components(path: &Path, strip: usize, label: &str) -> Result<Vec<OsString>, InstallError> {
    let mut out = Vec::new();
    for c in path.components() {
        match c {
            Component::Normal(p) => out.push(p.to_os_string()),
            Component::CurDir => {}
            Component::ParentDir => return Err(unsafe_entry(label, "parent directory component")),
            Component::RootDir | Component::Prefix(_) => {
                return Err(unsafe_entry(label, "absolute path"))
            }
        }
    }
    if out.len() <= strip {
        return Ok(Vec::new());
    }
    Ok(out.split_off(strip))
}

struct SafeTree<'a> {
    /// Canonical extraction root.
    root: PathBuf,
    written: u64,
    limit: u64,
    cancel: &'a AtomicBool,
}

impl<'a> SafeTree<'a> {
    fn new(root: &Path, limit: u64, cancel: &'a AtomicBool) -> Result<Self, InstallError> {
        fs::create_dir_all(root).map_err(io_ctx(format!("create {}", root.display())))?;
        let root = fs::canonicalize(root).map_err(io_ctx("canonicalize root"))?;
        Ok(Self {
            root,
            written: 0,
            limit,
            cancel,
        })
    }

    fn check(&self) -> Result<(), InstallError> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(InstallError::Cancelled)
        } else {
            Ok(())
        }
    }

    /// Walks `comps` below the root one component at a time, creating missing
    /// directories. Every existing symlink on the way is resolved and must stay
    /// inside the root, so nothing is ever created or written outside of it.
    fn walk(&self, comps: &[OsString], label: &str) -> Result<PathBuf, InstallError> {
        let mut cur = self.root.clone();
        for comp in comps {
            let next = cur.join(comp);
            match fs::symlink_metadata(&next) {
                Ok(md) if md.file_type().is_symlink() => {
                    let resolved = fs::canonicalize(&next)
                        .map_err(|_| unsafe_entry(label, "dangling symlink in path"))?;
                    if !resolved.starts_with(&self.root) || !resolved.is_dir() {
                        return Err(unsafe_entry(
                            label,
                            "path traverses a symlink out of the target",
                        ));
                    }
                    cur = resolved;
                }
                Ok(md) if md.is_dir() => cur = next,
                Ok(_) => return Err(unsafe_entry(label, "path component is not a directory")),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    fs::create_dir(&next).map_err(io_ctx(format!("create {}", next.display())))?;
                    cur = next;
                }
                Err(e) => return Err(io_ctx(format!("stat {}", next.display()))(e)),
            }
        }
        Ok(cur)
    }

    fn add_dir(&mut self, comps: &[OsString], label: &str) -> Result<(), InstallError> {
        self.check()?;
        self.walk(comps, label).map(|_| ())
    }

    /// Resolves the destination for a non-directory entry and clears whatever
    /// non-directory is there (a symlink is removed, never followed).
    fn dest_for(&self, comps: &[OsString], label: &str) -> Result<PathBuf, InstallError> {
        let (name, parents) = comps
            .split_last()
            .ok_or_else(|| unsafe_entry(label, "empty path"))?;
        let dest = self.walk(parents, label)?.join(name);
        match fs::symlink_metadata(&dest) {
            Ok(md) if md.is_dir() => Err(unsafe_entry(label, "file would replace a directory")),
            Ok(_) => {
                fs::remove_file(&dest).map_err(io_ctx(format!("replace {}", dest.display())))?;
                Ok(dest)
            }
            Err(_) => Ok(dest),
        }
    }

    fn add_file(
        &mut self,
        comps: &[OsString],
        label: &str,
        reader: &mut dyn Read,
        mode: Option<u32>,
    ) -> Result<(), InstallError> {
        self.check()?;
        let dest = self.dest_for(comps, label)?;
        // create_new never follows a symlink at the destination.
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&dest)
            .map_err(io_ctx(format!("create {}", dest.display())))?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            self.check()?;
            let n = reader
                .read(&mut buf)
                .map_err(|e| InstallError::Archive(e.to_string()))?;
            if n == 0 {
                break;
            }
            self.written += n as u64;
            if self.written > self.limit {
                return Err(unsafe_entry(label, "extracted size limit exceeded"));
            }
            io::Write::write_all(&mut file, &buf[..n]).map_err(io_ctx("write file"))?;
        }
        drop(file);
        set_mode(&dest, mode)?;
        Ok(())
    }

    fn add_symlink(
        &mut self,
        comps: &[OsString],
        label: &str,
        target: &Path,
    ) -> Result<(), InstallError> {
        self.check()?;
        let dest = self.dest_for(comps, label)?;
        // A name that is already taken could later be swapped for another
        // link and redirect an earlier one, so duplicates are refused.
        if fs::symlink_metadata(&dest).is_ok() {
            return Err(unsafe_entry(
                label,
                "symlink would replace an existing entry",
            ));
        }
        let mut cur = dest.parent().unwrap_or(&self.root).to_path_buf();
        // Resolve the target against the real tree, following links created
        // earlier the way `walk` does. Every step must stay inside the root.
        for c in target.components() {
            match c {
                Component::Normal(p) => {
                    let next = cur.join(p);
                    match fs::symlink_metadata(&next) {
                        Ok(md) if md.file_type().is_symlink() => {
                            cur = fs::canonicalize(&next)
                                .map_err(|_| unsafe_entry(label, "symlink target is dangling"))?;
                        }
                        Ok(_) => cur = next,
                        Err(e) if e.kind() == io::ErrorKind::NotFound => cur = next,
                        Err(e) => return Err(io_ctx(format!("stat {}", next.display()))(e)),
                    }
                }
                Component::CurDir => {}
                Component::ParentDir => {
                    cur.pop();
                }
                Component::RootDir | Component::Prefix(_) => {
                    return Err(unsafe_entry(label, "absolute symlink target"))
                }
            }
            if !cur.starts_with(&self.root) {
                return Err(unsafe_entry(
                    label,
                    "symlink target escapes the target directory",
                ));
            }
        }
        make_symlink(target, &dest, label)
    }

    fn add_hardlink(
        &mut self,
        comps: &[OsString],
        label: &str,
        source: &[OsString],
    ) -> Result<(), InstallError> {
        self.check()?;
        let (name, parents) = source
            .split_last()
            .ok_or_else(|| unsafe_entry(label, "empty hardlink target"))?;
        let src = self.walk(parents, label)?.join(name);
        let md = fs::symlink_metadata(&src)
            .map_err(|_| unsafe_entry(label, "hardlink target does not exist"))?;
        if !md.is_file() {
            return Err(unsafe_entry(label, "hardlink target is not a regular file"));
        }
        let dest = self.dest_for(comps, label)?;
        fs::hard_link(&src, &dest).map_err(io_ctx(format!("link {}", dest.display())))
    }
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: Option<u32>) -> Result<(), InstallError> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(mode) = mode {
        // Drop setuid/setgid/sticky and group/other write; keep the owner able
        // to read and write.
        let mode = (mode & 0o755) | 0o600;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(io_ctx("set permissions"))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: Option<u32>) -> Result<(), InstallError> {
    Ok(())
}

#[cfg(unix)]
fn make_symlink(target: &Path, dest: &Path, _label: &str) -> Result<(), InstallError> {
    std::os::unix::fs::symlink(target, dest).map_err(io_ctx(format!("symlink {}", dest.display())))
}

#[cfg(not(unix))]
fn make_symlink(_target: &Path, _dest: &Path, label: &str) -> Result<(), InstallError> {
    Err(unsafe_entry(
        label,
        "symlinks are not supported on this platform",
    ))
}

fn extract_artifact(
    file: &Path,
    artifact: &Artifact,
    index: usize,
    tree: &Path,
    staging: &Path,
    limit: u64,
    cancel: &AtomicBool,
) -> Result<(), InstallError> {
    match artifact.kind {
        ArtifactKind::TarGz => {
            let mut st = SafeTree::new(tree, limit, cancel)?;
            extract_tar(file, &mut st, 0)
        }
        ArtifactKind::Zip => {
            let mut st = SafeTree::new(tree, limit, cancel)?;
            extract_zip(file, &mut st)
        }
        ArtifactKind::Gz => {
            let mut st = SafeTree::new(tree, limit, cancel)?;
            let comps = safe_components(Path::new(&artifact.entry), 0, &artifact.entry)?;
            let f = fs::File::open(file).map_err(io_ctx("open download"))?;
            let mut dec = GzDecoder::new(BufReader::new(f));
            st.add_file(&comps, &artifact.entry, &mut dec, Some(0o755))
        }
        ArtifactKind::NpmTarball => {
            let tmp = staging.join(format!("npm-{index}"));
            if tmp.exists() {
                fs::remove_dir_all(&tmp).map_err(io_ctx("reset npm dir"))?;
            }
            let mut st = SafeTree::new(&tmp, limit, cancel)?;
            // npm tarballs wrap everything in a single top-level `package/`.
            extract_tar(file, &mut st, 1)?;
            let name = npm_package_name(&tmp)?;
            let mut dest = tree.join("node_modules");
            if let Some(parent) = &artifact.parent {
                // The parent was placed first; a nested copy goes inside it.
                dest = dest.join(parent).join("node_modules");
            }
            let dest = dest.join(&name);
            if dest.exists() {
                return Err(InstallError::InvalidPlan(format!(
                    "npm package {name} appears twice in the plan"
                )));
            }
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(io_ctx("create node_modules"))?;
            }
            fs::rename(&tmp, &dest).map_err(io_ctx("place npm package"))
        }
    }
}

fn npm_package_name(dir: &Path) -> Result<String, InstallError> {
    let bytes = fs::read(dir.join("package.json"))
        .map_err(|_| InstallError::Archive("npm tarball has no package.json".into()))?;
    let v: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| InstallError::Archive(format!("bad package.json: {e}")))?;
    let name = v
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or_else(|| InstallError::Archive("package.json has no name".into()))?;
    // `name` or `@scope/name`, plain components only.
    let parts: Vec<&str> = name.split('/').collect();
    let ok = match parts.as_slice() {
        [n] => !n.starts_with('@'),
        [s, n] => s.starts_with('@') && !n.starts_with('@'),
        _ => false,
    } && parts.iter().all(|p| {
        !p.is_empty() && !p.starts_with('.') && !p.contains(['\\', ':']) && *p != "node_modules"
    });
    if !ok {
        return Err(unsafe_entry(name, "unsafe npm package name"));
    }
    Ok(name.to_string())
}

fn extract_tar(file: &Path, st: &mut SafeTree<'_>, strip: usize) -> Result<(), InstallError> {
    let f = fs::File::open(file).map_err(io_ctx("open download"))?;
    let mut archive = tar::Archive::new(GzDecoder::new(BufReader::new(f)));
    let arch = |e: io::Error| InstallError::Archive(e.to_string());
    for entry in archive.entries().map_err(arch)? {
        st.check()?;
        let mut entry = entry.map_err(arch)?;
        let raw = entry.path().map_err(arch)?.into_owned();
        let label = raw.to_string_lossy().into_owned();
        let kind = entry.header().entry_type();
        let mode = entry.header().mode().ok();
        use tar::EntryType as T;
        match kind {
            T::XGlobalHeader | T::XHeader => continue,
            T::Directory => {
                let comps = safe_components(&raw, strip, &label)?;
                st.add_dir(&comps, &label)?;
            }
            T::Regular | T::Continuous | T::GNUSparse => {
                let comps = safe_components(&raw, strip, &label)?;
                if comps.is_empty() {
                    continue;
                }
                st.add_file(&comps, &label, &mut entry, mode)?;
            }
            T::Symlink => {
                let comps = safe_components(&raw, strip, &label)?;
                if comps.is_empty() {
                    continue;
                }
                let target = entry
                    .link_name()
                    .map_err(arch)?
                    .ok_or_else(|| unsafe_entry(&label, "symlink without target"))?
                    .into_owned();
                st.add_symlink(&comps, &label, &target)?;
            }
            T::Link => {
                let comps = safe_components(&raw, strip, &label)?;
                if comps.is_empty() {
                    continue;
                }
                let target = entry
                    .link_name()
                    .map_err(arch)?
                    .ok_or_else(|| unsafe_entry(&label, "hardlink without target"))?
                    .into_owned();
                let src = safe_components(&target, strip, &label)?;
                st.add_hardlink(&comps, &label, &src)?;
            }
            _ => return Err(unsafe_entry(&label, "unsupported entry type")),
        }
    }
    Ok(())
}

fn extract_zip(file: &Path, st: &mut SafeTree<'_>) -> Result<(), InstallError> {
    let f = fs::File::open(file).map_err(io_ctx("open download"))?;
    let mut archive = zip::ZipArchive::new(BufReader::new(f))
        .map_err(|e| InstallError::Archive(e.to_string()))?;
    for i in 0..archive.len() {
        st.check()?;
        let mut entry = archive
            .by_index(i)
            .map_err(|e| InstallError::Archive(e.to_string()))?;
        let label = entry.name().to_string();
        if entry.enclosed_name().is_none() {
            return Err(unsafe_entry(&label, "path escapes the target directory"));
        }
        let comps = safe_components(Path::new(&label), 0, &label)?;
        if comps.is_empty() {
            continue;
        }
        let mode = entry.unix_mode();
        let is_symlink = mode.is_some_and(|m| m & 0o170000 == 0o120000);
        if entry.is_dir() {
            st.add_dir(&comps, &label)?;
        } else if is_symlink {
            let mut target = String::new();
            entry
                .by_ref()
                .take(4096)
                .read_to_string(&mut target)
                .map_err(|e| InstallError::Archive(e.to_string()))?;
            st.add_symlink(&comps, &label, Path::new(&target))?;
        } else {
            st.add_file(&comps, &label, &mut entry, mode)?;
        }
    }
    Ok(())
}

/// Checks every declared entry and marks native binaries executable.
fn finish_entries(tree: &Path, artifacts: &[Artifact]) -> Result<(), InstallError> {
    let root = fs::canonicalize(tree).map_err(io_ctx("canonicalize tree"))?;
    for a in artifacts {
        let comps = safe_components(Path::new(&a.entry), 0, &a.entry)?;
        let joined: PathBuf = comps.iter().collect();
        let path = fs::canonicalize(root.join(&joined))
            .map_err(|_| InstallError::EntryMissing(a.entry.clone()))?;
        if !path.starts_with(&root) || !path.is_file() {
            return Err(InstallError::EntryMissing(a.entry.clone()));
        }
        if a.kind != ArtifactKind::NpmTarball {
            make_executable(&path)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), InstallError> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path)
        .map_err(io_ctx("stat entry"))?
        .permissions()
        .mode();
    fs::set_permissions(path, fs::Permissions::from_mode(mode | 0o755))
        .map_err(io_ctx("chmod entry"))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), InstallError> {
    Ok(())
}

/// Convenience for callers that only need the slug of a server.
pub fn cache_slug(id: ServerId) -> &'static str {
    server_slug(id)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::Write;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    // ---- fixtures ----

    fn gz(data: Vec<u8>) -> Vec<u8> {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(&data).unwrap();
        enc.finish().unwrap()
    }

    fn tar_header(kind: tar::EntryType, size: u64, mode: u32) -> tar::Header {
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(kind);
        h.set_size(size);
        h.set_mode(mode);
        h
    }

    /// Writes the name bytes directly: `Header::set_path` refuses `..`.
    fn raw_name(h: &mut tar::Header, name: &str) {
        let field = &mut h.as_old_mut().name;
        field.fill(0);
        field[..name.len()].copy_from_slice(name.as_bytes());
    }

    fn tar_gz(files: &[(&str, &[u8], u32)]) -> Vec<u8> {
        let mut b = tar::Builder::new(Vec::new());
        for (name, data, mode) in files {
            let mut h = tar_header(tar::EntryType::Regular, data.len() as u64, *mode);
            raw_name(&mut h, name);
            h.set_cksum();
            b.append(&h, *data).unwrap();
        }
        gz(b.into_inner().unwrap())
    }

    fn tar_gz_symlink(name: &str, target: &str) -> Vec<u8> {
        let mut b = tar::Builder::new(Vec::new());
        let mut h = tar_header(tar::EntryType::Symlink, 0, 0o777);
        raw_name(&mut h, name);
        h.set_link_name(target).unwrap();
        h.set_cksum();
        b.append(&h, std::io::empty()).unwrap();
        gz(b.into_inner().unwrap())
    }

    fn npm_tgz(name: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
        let pkg = format!("{{\"name\":\"{name}\",\"version\":\"1.0.0\"}}");
        let mut files: Vec<(String, Vec<u8>, u32)> =
            vec![("package/package.json".into(), pkg.into_bytes(), 0o644)];
        for (n, d) in extra {
            files.push((format!("package/{n}"), d.to_vec(), 0o644));
        }
        let refs: Vec<(&str, &[u8], u32)> = files
            .iter()
            .map(|(n, d, m)| (n.as_str(), d.as_slice(), *m))
            .collect();
        tar_gz(&refs)
    }

    fn zip_bytes(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);
        for (name, data) in files {
            w.start_file(*name, opts).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    fn sha(data: &[u8]) -> String {
        hex(&Sha256::digest(data))
    }

    // ---- local HTTP server ----

    #[derive(Clone)]
    enum Route {
        Ok(Vec<u8>),
        /// Claims `claimed` bytes, sends only the body, then closes.
        Truncated {
            claimed: usize,
            body: Vec<u8>,
        },
        Status(u16),
        Slow(Vec<u8>, u64),
    }

    #[derive(Clone)]
    struct TestServer {
        base: String,
        routes: Arc<Mutex<HashMap<String, Route>>>,
        hits: Arc<Mutex<HashMap<String, usize>>>,
    }

    impl TestServer {
        async fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let routes: Arc<Mutex<HashMap<String, Route>>> = Default::default();
            let hits: Arc<Mutex<HashMap<String, usize>>> = Default::default();
            let (r2, h2) = (routes.clone(), hits.clone());
            tokio::spawn(async move {
                loop {
                    let Ok((mut sock, _)) = listener.accept().await else {
                        return;
                    };
                    let (routes, hits) = (r2.clone(), h2.clone());
                    tokio::spawn(async move {
                        let mut buf = Vec::new();
                        let mut tmp = [0u8; 1024];
                        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            match sock.read(&mut tmp).await {
                                Ok(0) | Err(_) => return,
                                Ok(n) => buf.extend_from_slice(&tmp[..n]),
                            }
                        }
                        let head = String::from_utf8_lossy(&buf).into_owned();
                        let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                        *hits.lock().unwrap().entry(path.clone()).or_default() += 1;
                        let route = routes.lock().unwrap().get(&path).cloned();
                        let (status, claimed, body, delay) = match route {
                            Some(Route::Ok(b)) => (200, b.len(), b, 0),
                            Some(Route::Slow(b, ms)) => (200, b.len(), b, ms),
                            Some(Route::Truncated { claimed, body }) => (200, claimed, body, 0),
                            Some(Route::Status(s)) => (s, 0, Vec::new(), 0),
                            None => (404, 0, Vec::new(), 0),
                        };
                        if delay > 0 {
                            tokio::time::sleep(Duration::from_millis(delay)).await;
                        }
                        let head = format!(
                            "HTTP/1.1 {status} X\r\nContent-Length: {claimed}\r\nConnection: close\r\n\r\n"
                        );
                        let _ = sock.write_all(head.as_bytes()).await;
                        let _ = sock.write_all(&body).await;
                        let _ = sock.shutdown().await;
                    });
                }
            });
            Self { base, routes, hits }
        }

        fn url(&self, path: &str) -> String {
            format!("{}{}", self.base, path)
        }

        fn serve(&self, path: &str, route: Route) {
            self.routes.lock().unwrap().insert(path.to_string(), route);
        }

        fn hits(&self, path: &str) -> usize {
            self.hits.lock().unwrap().get(path).copied().unwrap_or(0)
        }
    }

    fn installer(root: &Path) -> Installer {
        Installer::new(ServerCache::new(root), Arc::new(HttpFetch::new().unwrap()))
    }

    fn art(srv: &TestServer, path: &str, data: &[u8], kind: ArtifactKind, entry: &str) -> Artifact {
        Artifact {
            url: srv.url(path),
            sha256: sha(data),
            kind,
            entry: entry.into(),
            parent: None,
        }
    }

    fn plan(version: &str, artifacts: Vec<Artifact>) -> InstallPlan {
        InstallPlan {
            version: version.into(),
            artifacts,
        }
    }

    fn listing(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .map(|rd| {
                rd.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        v.sort();
        v
    }

    fn leftover_downloads(cache: &ServerCache, id: ServerId, version: &str) -> Vec<String> {
        listing(&cache.staging_dir(id, version).join("downloads"))
    }

    // ---- tests ----

    #[tokio::test]
    async fn installs_a_nested_npm_copy_inside_its_parent() {
        let srv = TestServer::start().await;
        let top = npm_tgz("host", &[("index.js", b"top")]);
        let nested = npm_tgz("shared", &[("index.js", b"nested")]);
        let flat = npm_tgz("shared", &[("index.js", b"flat")]);
        srv.serve("/host.tgz", Route::Ok(top.clone()));
        srv.serve("/nested.tgz", Route::Ok(nested.clone()));
        srv.serve("/flat.tgz", Route::Ok(flat.clone()));
        let mut inside = art(
            &srv,
            "/nested.tgz",
            &nested,
            ArtifactKind::NpmTarball,
            "node_modules/host/node_modules/shared/package.json",
        );
        inside.parent = Some("host".into());
        let p = plan(
            "1.0.0",
            vec![
                art(
                    &srv,
                    "/host.tgz",
                    &top,
                    ArtifactKind::NpmTarball,
                    "node_modules/host/index.js",
                ),
                art(
                    &srv,
                    "/flat.tgz",
                    &flat,
                    ArtifactKind::NpmTarball,
                    "node_modules/shared/index.js",
                ),
                inside,
            ],
        );
        let tmp = tempfile::tempdir().unwrap();
        let out = installer(tmp.path())
            .install(ServerId::Json, &p, &[], None)
            .await
            .unwrap();
        assert_eq!(
            fs::read(out.dir.join("node_modules/shared/index.js")).unwrap(),
            b"flat"
        );
        assert_eq!(
            fs::read(
                out.dir
                    .join("node_modules/host/node_modules/shared/index.js")
            )
            .unwrap(),
            b"nested"
        );
        assert_eq!(
            fs::read(out.dir.join("node_modules/host/index.js")).unwrap(),
            b"top"
        );
    }

    #[tokio::test]
    async fn installs_every_artifact_kind() {
        let srv = TestServer::start().await;
        let tgz = tar_gz(&[
            ("bin/tool", b"#!/bin/sh\necho hi\n", 0o644),
            ("lib/a.txt", b"a", 0o644),
        ]);
        let zp = zip_bytes(&[("bin/z.exe", b"zzz"), ("data/d.txt", b"d")]);
        let gzf = gz(b"native-binary".to_vec());
        let npm_a = npm_tgz("@scope/alpha", &[("bin/alpha.js", b"console.log(1)")]);
        let npm_b = npm_tgz("beta", &[("index.js", b"1")]);
        srv.serve("/tool.tar.gz", Route::Ok(tgz.clone()));
        srv.serve("/z.zip", Route::Ok(zp.clone()));
        srv.serve("/g.gz", Route::Ok(gzf.clone()));
        srv.serve("/a.tgz", Route::Ok(npm_a.clone()));
        srv.serve("/b.tgz", Route::Ok(npm_b.clone()));
        let p = plan(
            "1.0.0",
            vec![
                art(&srv, "/tool.tar.gz", &tgz, ArtifactKind::TarGz, "bin/tool"),
                art(&srv, "/z.zip", &zp, ArtifactKind::Zip, "bin/z.exe"),
                art(&srv, "/g.gz", &gzf, ArtifactKind::Gz, "bin/native"),
                art(
                    &srv,
                    "/a.tgz",
                    &npm_a,
                    ArtifactKind::NpmTarball,
                    "node_modules/@scope/alpha/bin/alpha.js",
                ),
                art(
                    &srv,
                    "/b.tgz",
                    &npm_b,
                    ArtifactKind::NpmTarball,
                    "node_modules/beta/index.js",
                ),
            ],
        );
        let tmp = tempfile::tempdir().unwrap();
        let inst = installer(tmp.path());
        let (tx, mut rx) = mpsc::channel(256);
        let out = inst
            .install(ServerId::Json, &p, &[], Some(&tx))
            .await
            .unwrap();
        assert_eq!(
            out.dir,
            tmp.path()
                .join("vscode-langservers-extracted")
                .join("1.0.0")
        );
        assert_eq!(fs::read(&out.entries[0]).unwrap(), b"#!/bin/sh\necho hi\n");
        assert_eq!(fs::read(&out.entries[2]).unwrap(), b"native-binary");
        assert_eq!(fs::read(out.dir.join("lib/a.txt")).unwrap(), b"a");
        assert_eq!(fs::read(out.dir.join("data/d.txt")).unwrap(), b"d");
        assert!(out.dir.join(MARKER_FILE).exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for i in 0..3 {
                let mode = fs::metadata(&out.entries[i]).unwrap().permissions().mode();
                assert_eq!(mode & 0o111, 0o111, "entry {i} must be executable");
            }
            let js = fs::metadata(&out.entries[3]).unwrap().permissions().mode();
            assert_eq!(js & 0o111, 0, "npm entries are not made executable");
        }
        // Staging is gone, the cache holds only the version dir and the lock.
        assert_eq!(
            listing(&tmp.path().join("vscode-langservers-extracted")),
            vec![".1.0.0.lock", "1.0.0"]
        );

        // Second call is a no-op without network.
        let before = srv.hits("/tool.tar.gz");
        inst.install(ServerId::Json, &p, &[], Some(&tx))
            .await
            .unwrap();
        assert_eq!(srv.hits("/tool.tar.gz"), before);

        drop(tx);
        let mut events = Vec::new();
        while let Some(e) = rx.recv().await {
            events.push(e);
        }
        assert!(matches!(
            events.first(),
            Some(InstallProgress::Started { artifacts: 5, .. })
        ));
        assert!(events
            .iter()
            .any(|e| matches!(e, InstallProgress::Downloading { received, .. } if *received > 0)));
        assert!(events
            .iter()
            .any(|e| matches!(e, InstallProgress::Extracting { index: 4 })));
        assert!(events
            .iter()
            .any(|e| matches!(e, InstallProgress::AlreadyInstalled { .. })));
        assert!(events
            .iter()
            .any(|e| matches!(e, InstallProgress::Finished { .. })));
        assert!(matches!(
            events.last(),
            Some(InstallProgress::AlreadyInstalled { .. })
        ));
    }

    #[tokio::test]
    async fn hash_mismatch_is_rejected_and_nothing_is_kept() {
        let srv = TestServer::start().await;
        let good = tar_gz(&[("bin/tool", b"good", 0o755)]);
        let evil = tar_gz(&[("bin/tool", b"evil", 0o755)]);
        srv.serve("/t.tar.gz", Route::Ok(evil));
        let p = plan(
            "1.0.0",
            vec![art(
                &srv,
                "/t.tar.gz",
                &good,
                ArtifactKind::TarGz,
                "bin/tool",
            )],
        );
        let tmp = tempfile::tempdir().unwrap();
        let inst = installer(tmp.path());
        let err = inst
            .install(ServerId::Html, &p, &[], None)
            .await
            .unwrap_err();
        match err {
            InstallError::HashMismatch {
                expected, actual, ..
            } => {
                assert_eq!(expected, sha(&good));
                assert_ne!(actual, expected);
            }
            other => panic!("unexpected error: {other:?}"),
        }
        assert!(!tmp
            .path()
            .join("vscode-langservers-extracted/1.0.0")
            .exists());
        assert!(leftover_downloads(inst.cache(), ServerId::Html, "1.0.0").is_empty());
        assert!(!inst
            .cache()
            .staging_dir(ServerId::Html, "1.0.0")
            .join("tree/bin")
            .exists());
    }

    #[tokio::test]
    async fn truncated_download_over_tcp_fails_cleanly() {
        let srv = TestServer::start().await;
        let full = tar_gz(&[("bin/tool", &[7u8; 4096], 0o755)]);
        srv.serve(
            "/t.tar.gz",
            Route::Truncated {
                claimed: full.len(),
                body: full[..full.len() / 2].to_vec(),
            },
        );
        let p = plan(
            "1.0.0",
            vec![art(
                &srv,
                "/t.tar.gz",
                &full,
                ArtifactKind::TarGz,
                "bin/tool",
            )],
        );
        let tmp = tempfile::tempdir().unwrap();
        let inst = installer(tmp.path());
        let err = inst
            .install(ServerId::Css, &p, &[], None)
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                InstallError::Truncated { .. } | InstallError::Network { .. }
            ),
            "{err:?}"
        );
        assert!(!tmp
            .path()
            .join("vscode-langservers-extracted/1.0.0")
            .exists());
        assert!(leftover_downloads(inst.cache(), ServerId::Css, "1.0.0").is_empty());
    }

    struct ShortFetch;
    struct OneChunk(Option<Bytes>);
    impl ByteStream for OneChunk {
        fn next_chunk(&mut self) -> BoxFuture<'_, Result<Option<Bytes>, FetchError>> {
            let c = self.0.take();
            Box::pin(async move { Ok(c) })
        }
    }
    impl Fetch for ShortFetch {
        fn get<'a>(&'a self, _url: &'a str) -> BoxFuture<'a, Result<FetchResponse, FetchError>> {
            Box::pin(async {
                Ok(FetchResponse {
                    status: 200,
                    content_length: Some(100),
                    body: Box::new(OneChunk(Some(Bytes::from_static(b"short")))),
                })
            })
        }
    }

    #[tokio::test]
    async fn short_body_is_a_typed_truncation_error() {
        let tmp = tempfile::tempdir().unwrap();
        let inst = Installer::new(ServerCache::new(tmp.path()), Arc::new(ShortFetch));
        let p = plan(
            "1.0.0",
            vec![Artifact {
                url: "mem://x".into(),
                sha256: "0".repeat(64),
                kind: ArtifactKind::Gz,
                entry: "bin/x".into(),
                parent: None,
            }],
        );
        let err = inst
            .install(ServerId::Json, &p, &[], None)
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                InstallError::Truncated {
                    expected: 100,
                    received: 5,
                    ..
                }
            ),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn http_error_status_is_typed() {
        let srv = TestServer::start().await;
        srv.serve("/missing", Route::Status(404));
        let p = plan(
            "1.0.0",
            vec![Artifact {
                url: srv.url("/missing"),
                sha256: "0".repeat(64),
                kind: ArtifactKind::Gz,
                entry: "x".into(),
                parent: None,
            }],
        );
        let tmp = tempfile::tempdir().unwrap();
        let err = installer(tmp.path())
            .install(ServerId::Json, &p, &[], None)
            .await
            .unwrap_err();
        assert!(
            matches!(err, InstallError::HttpStatus { status: 404, .. }),
            "{err:?}"
        );
    }

    async fn assert_rejected(archive: Vec<u8>, kind: ArtifactKind, entry: &str) {
        let srv = TestServer::start().await;
        srv.serve("/a", Route::Ok(archive.clone()));
        let p = plan("1.0.0", vec![art(&srv, "/a", &archive, kind, entry)]);
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("cache");
        let inst = installer(&root);
        let err = inst
            .install(ServerId::Jdtls, &p, &[], None)
            .await
            .unwrap_err();
        assert!(matches!(err, InstallError::UnsafeArchive { .. }), "{err:?}");
        assert!(!root.join("jdtls/1.0.0").exists());
        // Nothing escaped next to the cache or into the tempdir.
        assert!(!tmp.path().join("evil").exists());
        assert!(!root.join("evil").exists());
        assert!(!root.join("jdtls/evil").exists());
    }

    #[tokio::test]
    async fn tar_path_traversal_is_rejected() {
        let a = tar_gz(&[("bin/tool", b"ok", 0o755), ("../../evil", b"x", 0o644)]);
        assert_rejected(a, ArtifactKind::TarGz, "bin/tool").await;
    }

    #[tokio::test]
    async fn tar_absolute_path_is_rejected() {
        let a = tar_gz(&[("/tmp/span-evil-abs", b"x", 0o644)]);
        assert_rejected(a, ArtifactKind::TarGz, "bin/tool").await;
        assert!(!Path::new("/tmp/span-evil-abs").exists());
    }

    #[tokio::test]
    async fn tar_symlink_escape_is_rejected() {
        let a = tar_gz_symlink("link", "../../evil");
        assert_rejected(a, ArtifactKind::TarGz, "link").await;
        let b = tar_gz_symlink("link", "/etc");
        assert_rejected(b, ArtifactKind::TarGz, "link").await;
    }

    /// `d/` , `d/s -> ..` (the root), `x -> d/s/..` (one above the root). No
    /// entry writes through a link, so only the target check can stop it.
    #[cfg(unix)]
    fn tar_chain_gz(prefix: &str) -> Vec<u8> {
        let mut b = tar::Builder::new(Vec::new());
        let pkg: &[u8] = br#"{"name":"p"}"#;
        let mut h = tar_header(tar::EntryType::Regular, pkg.len() as u64, 0o644);
        raw_name(&mut h, &format!("{prefix}package.json"));
        h.set_cksum();
        b.append(&h, pkg).unwrap();
        let mut h = tar_header(tar::EntryType::Directory, 0, 0o755);
        raw_name(&mut h, &format!("{prefix}d/"));
        h.set_cksum();
        b.append(&h, std::io::empty()).unwrap();
        for (name, target) in [("d/s", ".."), ("x", "d/s/..")] {
            let mut h = tar_header(tar::EntryType::Symlink, 0, 0o777);
            raw_name(&mut h, &format!("{prefix}{name}"));
            h.set_link_name(target).unwrap();
            h.set_cksum();
            b.append(&h, std::io::empty()).unwrap();
        }
        gz(b.into_inner().unwrap())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn tar_symlink_chain_escape_is_rejected() {
        assert_rejected(tar_chain_gz(""), ArtifactKind::TarGz, "x").await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn npm_symlink_chain_escape_is_rejected() {
        assert_rejected(
            tar_chain_gz("package/"),
            ArtifactKind::NpmTarball,
            "node_modules/p/package.json",
        )
        .await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn zip_symlink_chain_escape_is_rejected() {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default();
        w.add_directory("d/", opts).unwrap();
        w.add_symlink("d/s", "..", opts).unwrap();
        w.add_symlink("x", "d/s/..", opts).unwrap();
        let a = w.finish().unwrap().into_inner();
        assert_rejected(a, ArtifactKind::Zip, "x").await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_staying_inside_is_accepted() {
        let mut b = tar::Builder::new(Vec::new());
        let mut h = tar_header(tar::EntryType::Regular, 1, 0o755);
        raw_name(&mut h, "bin/tool");
        h.set_cksum();
        b.append(&h, &b"x"[..]).unwrap();
        for (name, target) in [("bin/self", "."), ("alias", "bin/self/tool")] {
            let mut h = tar_header(tar::EntryType::Symlink, 0, 0o777);
            raw_name(&mut h, name);
            h.set_link_name(target).unwrap();
            h.set_cksum();
            b.append(&h, std::io::empty()).unwrap();
        }
        let a = gz(b.into_inner().unwrap());
        let srv = TestServer::start().await;
        srv.serve("/a", Route::Ok(a.clone()));
        let p = plan(
            "1.0.0",
            vec![art(&srv, "/a", &a, ArtifactKind::TarGz, "bin/tool")],
        );
        let tmp = tempfile::tempdir().unwrap();
        installer(tmp.path())
            .install(ServerId::Json, &p, &[], None)
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn group_and_other_write_bits_are_dropped() {
        use std::os::unix::fs::PermissionsExt;
        let a = tar_gz(&[
            ("bin/tool", b"x", 0o777),
            ("lib/data", b"y", 0o666),
            ("lib/suid", b"z", 0o4777),
        ]);
        let srv = TestServer::start().await;
        srv.serve("/a", Route::Ok(a.clone()));
        let p = plan(
            "1.0.0",
            vec![art(&srv, "/a", &a, ArtifactKind::TarGz, "bin/tool")],
        );
        let tmp = tempfile::tempdir().unwrap();
        let out = installer(tmp.path())
            .install(ServerId::Json, &p, &[], None)
            .await
            .unwrap();
        let mode = |rel: &str| {
            fs::metadata(out.dir.join(rel))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777
        };
        assert_eq!(mode("bin/tool"), 0o755);
        assert_eq!(mode("lib/data"), 0o644);
        assert_eq!(mode("lib/suid"), 0o755);
    }

    #[tokio::test]
    async fn zip_path_traversal_is_rejected() {
        let a = zip_bytes(&[("bin/tool", b"ok"), ("../../evil", b"x")]);
        assert_rejected(a, ArtifactKind::Zip, "bin/tool").await;
    }

    #[tokio::test]
    async fn npm_path_traversal_is_rejected() {
        let a = tar_gz(&[
            ("package/package.json", br#"{"name":"p"}"#, 0o644),
            ("package/../../../evil", b"x", 0o644),
        ]);
        assert_rejected(a, ArtifactKind::NpmTarball, "node_modules/p/package.json").await;
    }

    #[tokio::test]
    async fn missing_entry_point_fails_install() {
        let srv = TestServer::start().await;
        let a = tar_gz(&[("bin/other", b"x", 0o755)]);
        srv.serve("/a", Route::Ok(a.clone()));
        let p = plan(
            "1.0.0",
            vec![art(&srv, "/a", &a, ArtifactKind::TarGz, "bin/tool")],
        );
        let tmp = tempfile::tempdir().unwrap();
        let err = installer(tmp.path())
            .install(ServerId::Json, &p, &[], None)
            .await
            .unwrap_err();
        assert!(matches!(err, InstallError::EntryMissing(_)), "{err:?}");
        assert!(!tmp
            .path()
            .join("vscode-langservers-extracted/1.0.0")
            .exists());
    }

    #[tokio::test]
    async fn concurrent_installs_download_once() {
        let srv = TestServer::start().await;
        let a = tar_gz(&[("bin/tool", b"x", 0o755)]);
        srv.serve("/a", Route::Slow(a.clone(), 300));
        let p = plan(
            "1.0.0",
            vec![art(&srv, "/a", &a, ArtifactKind::TarGz, "bin/tool")],
        );
        let tmp = tempfile::tempdir().unwrap();
        // Two independent installers on one cache, like two processes.
        let (i1, i2) = (installer(tmp.path()), installer(tmp.path()));
        let (tx, mut rx) = mpsc::channel(256);
        let (r1, r2) = tokio::join!(
            i1.install(ServerId::Vtsls, &p, &[], Some(&tx)),
            i2.install(ServerId::Vtsls, &p, &[], None)
        );
        let (r1, r2) = (r1.unwrap(), r2.unwrap());
        assert_eq!(r1, r2);
        assert_eq!(srv.hits("/a"), 1, "only one installer may download");
        assert_eq!(fs::read(&r1.entries[0]).unwrap(), b"x");
        drop(tx);
        let mut n = 0;
        while rx.recv().await.is_some() {
            n += 1;
        }
        assert!(n > 0);
    }

    #[tokio::test]
    async fn shared_slug_servers_install_once() {
        let srv = TestServer::start().await;
        let a = tar_gz(&[("bin/html", b"h", 0o755), ("bin/css", b"c", 0o755)]);
        srv.serve("/a", Route::Slow(a.clone(), 300));
        let mk = |entry: &str| {
            plan(
                "1.0.0",
                vec![art(&srv, "/a", &a, ArtifactKind::TarGz, entry)],
            )
        };
        let (ph, pc) = (mk("bin/html"), mk("bin/css"));
        let tmp = tempfile::tempdir().unwrap();
        let (i1, i2) = (installer(tmp.path()), installer(tmp.path()));
        let (r1, r2) = tokio::join!(
            i1.install(ServerId::Html, &ph, &[], None),
            i2.install(ServerId::Css, &pc, &[], None)
        );
        let (r1, r2) = (r1.unwrap(), r2.unwrap());
        assert_eq!(srv.hits("/a"), 1, "html and css must share one download");
        assert_eq!(r1.dir, r2.dir);
        assert_eq!(fs::read(&r1.entries[0]).unwrap(), b"h");
        assert_eq!(fs::read(&r2.entries[0]).unwrap(), b"c");
        assert_eq!(listing(tmp.path()).len(), 1);
    }

    #[tokio::test]
    async fn resumes_from_partial_and_corrupt_state() {
        let srv = TestServer::start().await;
        let one = tar_gz(&[("bin/one", b"1", 0o755)]);
        let two = tar_gz(&[("bin/two", b"2", 0o755)]);
        srv.serve("/one", Route::Ok(one.clone()));
        // Second artifact is not available yet.
        let p = plan(
            "2.0.0",
            vec![
                art(&srv, "/one", &one, ArtifactKind::TarGz, "bin/one"),
                art(&srv, "/two", &two, ArtifactKind::TarGz, "bin/two"),
            ],
        );
        let tmp = tempfile::tempdir().unwrap();
        let inst = installer(tmp.path());
        let cache = inst.cache().clone();

        // Pre-existing garbage: a corrupt version dir with a marker for other
        // hashes, a stale staging tree and a partial download.
        let vdir = cache.version_dir(ServerId::Basedpyright, "2.0.0");
        fs::create_dir_all(vdir.join("bin")).unwrap();
        fs::write(vdir.join("bin/one"), b"corrupt").unwrap();
        let mut stale = InstallMarker::for_plan(&p);
        stale.artifacts[0].sha256 = "f".repeat(64);
        fs::write(vdir.join(MARKER_FILE), serde_json::to_vec(&stale).unwrap()).unwrap();
        let st = cache.staging_dir(ServerId::Basedpyright, "2.0.0");
        fs::create_dir_all(st.join("downloads")).unwrap();
        fs::create_dir_all(st.join("tree/junk")).unwrap();
        fs::write(st.join("downloads/0.part"), b"half").unwrap();
        assert!(!cache.is_complete(ServerId::Basedpyright, &p).await);

        let err = inst
            .install(ServerId::Basedpyright, &p, &[], None)
            .await
            .unwrap_err();
        assert!(
            matches!(err, InstallError::HttpStatus { status: 404, .. }),
            "{err:?}"
        );
        assert_eq!(srv.hits("/one"), 1);
        assert!(!cache.is_complete(ServerId::Basedpyright, &p).await);
        // The verified first artifact survives for the retry.
        assert_eq!(
            leftover_downloads(&cache, ServerId::Basedpyright, "2.0.0"),
            vec![format!("{}.verified", sha(&one))]
        );

        srv.serve("/two", Route::Ok(two.clone()));
        let (tx, mut rx) = mpsc::channel(256);
        let out = inst
            .install(ServerId::Basedpyright, &p, &[], Some(&tx))
            .await
            .unwrap();
        assert_eq!(
            srv.hits("/one"),
            1,
            "verified artifact must not be fetched again"
        );
        assert_eq!(srv.hits("/two"), 2);
        assert_eq!(fs::read(out.dir.join("bin/one")).unwrap(), b"1");
        assert_eq!(fs::read(out.dir.join("bin/two")).unwrap(), b"2");
        assert!(!out.dir.join("junk").exists());
        assert!(!st.exists(), "staging removed after activation");
        drop(tx);
        let mut reused = false;
        while let Some(e) = rx.recv().await {
            reused |= matches!(e, InstallProgress::Reused { index: 0 });
        }
        assert!(reused);
    }

    #[tokio::test]
    async fn tampered_verified_download_is_refetched() {
        let srv = TestServer::start().await;
        let a = tar_gz(&[("bin/tool", b"x", 0o755)]);
        srv.serve("/a", Route::Ok(a.clone()));
        let p = plan(
            "1.0.0",
            vec![art(&srv, "/a", &a, ArtifactKind::TarGz, "bin/tool")],
        );
        let tmp = tempfile::tempdir().unwrap();
        let inst = installer(tmp.path());
        let st = inst.cache().staging_dir(ServerId::Json, "1.0.0");
        fs::create_dir_all(st.join("downloads")).unwrap();
        fs::write(
            st.join("downloads").join(format!("{}.verified", sha(&a))),
            b"tampered",
        )
        .unwrap();
        inst.install(ServerId::Json, &p, &[], None).await.unwrap();
        assert_eq!(srv.hits("/a"), 1);
    }

    #[tokio::test]
    async fn update_keeps_old_until_new_is_complete_then_prunes() {
        let srv = TestServer::start().await;
        let mut plans = Vec::new();
        for v in ["1.0.0", "2.0.0", "3.0.0"] {
            let data = tar_gz(&[("bin/tool", v.as_bytes(), 0o755)]);
            let path = format!("/{v}");
            srv.serve(&path, Route::Ok(data.clone()));
            plans.push(plan(
                v,
                vec![art(&srv, &path, &data, ArtifactKind::TarGz, "bin/tool")],
            ));
        }
        let tmp = tempfile::tempdir().unwrap();
        let inst = installer(tmp.path());
        let dir = tmp.path().join("vtsls");
        let versions = |d: &Path| -> Vec<String> {
            listing(d)
                .into_iter()
                .filter(|n| !n.starts_with('.'))
                .collect()
        };

        inst.install(ServerId::Vtsls, &plans[0], &[], None)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;
        inst.install(ServerId::Vtsls, &plans[1], &[], None)
            .await
            .unwrap();
        assert_eq!(versions(&dir), vec!["1.0.0", "2.0.0"]);

        // A failing update leaves everything as it was.
        let bad = plan(
            "9.9.9",
            vec![Artifact {
                url: srv.url("/nope"),
                sha256: "1".repeat(64),
                kind: ArtifactKind::TarGz,
                entry: "bin/tool".into(),
                parent: None,
            }],
        );
        assert!(inst
            .install(ServerId::Vtsls, &bad, &[], None)
            .await
            .is_err());
        assert_eq!(versions(&dir), vec!["1.0.0", "2.0.0"]);

        tokio::time::sleep(Duration::from_millis(5)).await;
        let (tx, mut rx) = mpsc::channel(256);
        inst.install(ServerId::Vtsls, &plans[2], &[], Some(&tx))
            .await
            .unwrap();
        // 3.0.0 is current, 2.0.0 is the rollback; 1.0.0 is pruned.
        assert_eq!(versions(&dir), vec!["2.0.0", "3.0.0"]);
        drop(tx);
        let mut pruned = None;
        while let Some(e) = rx.recv().await {
            if let InstallProgress::Pruned { versions } = e {
                pruned = Some(versions);
            }
        }
        assert_eq!(pruned, Some(vec!["1.0.0".to_string()]));

        // A running version is never pruned.
        let data = tar_gz(&[("bin/tool", b"4", 0o755)]);
        srv.serve("/4.0.0", Route::Ok(data.clone()));
        let p4 = plan(
            "4.0.0",
            vec![art(&srv, "/4.0.0", &data, ArtifactKind::TarGz, "bin/tool")],
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
        inst.install(ServerId::Vtsls, &p4, &["2.0.0".to_string()], None)
            .await
            .unwrap();
        assert_eq!(versions(&dir), vec!["2.0.0", "3.0.0", "4.0.0"]);
    }

    #[tokio::test]
    async fn dropping_the_future_cancels_and_releases_the_lock() {
        let srv = TestServer::start().await;
        let a = tar_gz(&[("bin/tool", b"x", 0o755)]);
        srv.serve("/a", Route::Slow(a.clone(), 5000));
        let p = plan(
            "1.0.0",
            vec![art(&srv, "/a", &a, ArtifactKind::TarGz, "bin/tool")],
        );
        let tmp = tempfile::tempdir().unwrap();
        let inst = installer(tmp.path());
        let res = tokio::time::timeout(
            Duration::from_millis(200),
            inst.install(ServerId::Json, &p, &[], None),
        )
        .await;
        assert!(res.is_err(), "install should still be running");
        assert!(!tmp
            .path()
            .join("vscode-langservers-extracted/1.0.0")
            .exists());
        // Lock is free again.
        inst.cache()
            .acquire_lock(ServerId::Json, "1.0.0", Duration::from_millis(500))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn invalid_plans_are_rejected_before_any_io() {
        let tmp = tempfile::tempdir().unwrap();
        let inst = installer(tmp.path());
        let mut p = plan("../x", vec![]);
        assert!(inst.install(ServerId::Json, &p, &[], None).await.is_err());
        p.version = "1.0.0".into();
        assert!(matches!(
            inst.install(ServerId::Json, &p, &[], None).await,
            Err(InstallError::InvalidPlan(_))
        ));
        p.artifacts.push(Artifact {
            url: "http://127.0.0.1:1/x".into(),
            sha256: "0".repeat(64),
            kind: ArtifactKind::Gz,
            entry: "../escape".into(),
            parent: None,
        });
        assert!(matches!(
            inst.install(ServerId::Json, &p, &[], None).await,
            Err(InstallError::UnsafeArchive { .. })
        ));
        assert!(listing(tmp.path()).is_empty());
    }
}
