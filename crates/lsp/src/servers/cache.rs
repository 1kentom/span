//! On-disk cache layout, completion markers, install locks and pruning.
//!
//! Layout: `<cache_root>/<server-slug>/<version>/` holds a complete install.
//! Dot-prefixed siblings (`.staging-<version>`, `.<version>.lock`) are
//! installer scratch space and are never treated as versions.

use super::spec::{InstallPlan, ServerId};
use serde::{Deserialize, Serialize};
use std::fs::{File, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Name of the file whose presence (and content) marks a complete install.
pub const MARKER_FILE: &str = ".span-install.json";

const MARKER_SCHEMA: u32 = 1;

#[derive(Debug, thiserror::Error)]
pub enum CacheError {
    #[error("invalid {what} {value:?}: must be a plain name without separators")]
    InvalidName { what: &'static str, value: String },
    #[error("timed out waiting for the install lock of {0}")]
    LockTimeout(String),
    #[error("cache io error ({context}): {source}")]
    Io {
        context: String,
        #[source]
        source: io::Error,
    },
}

fn io_err(context: impl Into<String>) -> impl FnOnce(io::Error) -> CacheError {
    let context = context.into();
    move |source| CacheError::Io { context, source }
}

/// Stable directory name of a server. Servers that ship from one npm package
/// share a slug, so the package closure is downloaded and stored once and the
/// install lock serialises them.
pub fn server_slug(id: ServerId) -> &'static str {
    match id {
        ServerId::Vtsls => "vtsls",
        ServerId::Html | ServerId::Css | ServerId::Json => "vscode-langservers-extracted",
        ServerId::RustAnalyzer => "rust-analyzer",
        ServerId::Basedpyright => "basedpyright",
        ServerId::Jdtls => "jdtls",
        ServerId::Svelte => "svelte",
        ServerId::Vue => "vue",
        ServerId::Astro => "astro",
    }
}

/// A version string becomes a directory name, so it must be a plain component.
pub fn validate_version(version: &str) -> Result<(), CacheError> {
    let ok = !version.is_empty()
        && version.len() <= 128
        && !version.starts_with('.')
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'));
    if ok {
        Ok(())
    } else {
        Err(CacheError::InvalidName {
            what: "version",
            value: version.to_string(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarkerArtifact {
    pub url: String,
    pub sha256: String,
}

/// Written last, into the staging dir, before the atomic rename.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallMarker {
    pub schema: u32,
    pub version: String,
    /// Nanoseconds since the Unix epoch when the install completed.
    pub installed_at_ns: u64,
    pub artifacts: Vec<MarkerArtifact>,
}

impl InstallMarker {
    pub fn for_plan(plan: &InstallPlan) -> Self {
        let installed_at_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        Self {
            schema: MARKER_SCHEMA,
            version: plan.version.clone(),
            installed_at_ns,
            artifacts: plan
                .artifacts
                .iter()
                .map(|a| MarkerArtifact {
                    url: a.url.clone(),
                    sha256: a.sha256.to_ascii_lowercase(),
                })
                .collect(),
        }
    }

    fn matches(&self, plan: &InstallPlan) -> bool {
        self.schema == MARKER_SCHEMA
            && self.version == plan.version
            && self.artifacts.len() == plan.artifacts.len()
            && self
                .artifacts
                .iter()
                .zip(&plan.artifacts)
                .all(|(m, a)| m.sha256 == a.sha256.to_ascii_lowercase())
    }
}

/// Handle on the cache root. Cheap to clone.
#[derive(Debug, Clone)]
pub struct ServerCache {
    root: PathBuf,
}

impl ServerCache {
    /// `root` is supplied by the caller (platform cache dir, or a tempdir in tests).
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn server_dir(&self, id: ServerId) -> PathBuf {
        self.root.join(server_slug(id))
    }

    pub fn version_dir(&self, id: ServerId, version: &str) -> PathBuf {
        self.server_dir(id).join(version)
    }

    pub fn staging_dir(&self, id: ServerId, version: &str) -> PathBuf {
        self.server_dir(id).join(format!(".staging-{version}"))
    }

    fn lock_path(&self, id: ServerId, version: &str) -> PathBuf {
        self.server_dir(id).join(format!(".{version}.lock"))
    }

    /// Reads and parses the marker of a version dir, if any.
    pub async fn read_marker(dir: &Path) -> Option<InstallMarker> {
        let bytes = tokio::fs::read(dir.join(MARKER_FILE)).await.ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// True when `version` is fully installed with exactly the hashes of `plan`
    /// and every declared entry point exists.
    pub async fn is_complete(&self, id: ServerId, plan: &InstallPlan) -> bool {
        let dir = self.version_dir(id, &plan.version);
        match Self::read_marker(&dir).await {
            Some(marker) if marker.matches(plan) => {}
            _ => return false,
        }
        for artifact in &plan.artifacts {
            if tokio::fs::metadata(dir.join(&artifact.entry))
                .await
                .is_err()
            {
                return false;
            }
        }
        true
    }

    /// Complete versions of a server, newest first.
    pub async fn installed_versions(&self, id: ServerId) -> Vec<InstallMarker> {
        let mut out = Vec::new();
        let Ok(mut rd) = tokio::fs::read_dir(self.server_dir(id)).await else {
            return out;
        };
        while let Ok(Some(ent)) = rd.next_entry().await {
            let name = ent.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            if let Some(marker) = Self::read_marker(&ent.path()).await {
                if marker.version == name {
                    out.push(marker);
                }
            }
        }
        out.sort_by(|a, b| {
            b.installed_at_ns
                .cmp(&a.installed_at_ns)
                .then_with(|| b.version.cmp(&a.version))
        });
        out
    }

    /// Removes versions that are neither `current`, nor listed in `in_use`, nor
    /// the newest previous complete version (kept for rollback). Also removes
    /// corrupt or partial version dirs that nobody is installing right now.
    /// Returns the removed version names. Best effort: failures are skipped.
    pub async fn prune(&self, id: ServerId, current: &str, in_use: &[String]) -> Vec<String> {
        let mut removed = Vec::new();
        let complete = self.installed_versions(id).await;
        let rollback = complete
            .iter()
            .find(|m| m.version != current)
            .map(|m| m.version.clone());

        let Ok(mut rd) = tokio::fs::read_dir(self.server_dir(id)).await else {
            return removed;
        };
        let mut names = Vec::new();
        while let Ok(Some(ent)) = rd.next_entry().await {
            let name = ent.file_name().to_string_lossy().into_owned();
            if !name.starts_with('.') && validate_version(&name).is_ok() {
                names.push(name);
            }
        }
        for name in names {
            let keep = name == current
                || in_use.contains(&name)
                || rollback.as_deref() == Some(name.as_str());
            if keep {
                continue;
            }
            // Never touch a dir somebody may be installing into right now.
            let Ok(Some(_guard)) = self.try_lock(id, &name).await else {
                continue;
            };
            if tokio::fs::remove_dir_all(self.version_dir(id, &name))
                .await
                .is_ok()
            {
                removed.push(name);
            }
        }
        removed.sort();
        removed
    }

    async fn try_lock(
        &self,
        id: ServerId,
        version: &str,
    ) -> Result<Option<InstallLock>, CacheError> {
        validate_version(version)?;
        let dir = self.server_dir(id);
        let path = self.lock_path(id, version);
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(io_err(format!("create {}", dir.display())))?;
        let ctx = format!("lock {}", path.display());
        let res = tokio::task::spawn_blocking(move || -> io::Result<Option<File>> {
            let file = File::options()
                .create(true)
                .truncate(false)
                .write(true)
                .open(&path)?;
            match file.try_lock() {
                Ok(()) => Ok(Some(file)),
                Err(TryLockError::WouldBlock) => Ok(None),
                Err(TryLockError::Error(e)) => Err(e),
            }
        })
        .await
        .map_err(|e| CacheError::Io {
            context: ctx.clone(),
            source: io::Error::other(e),
        })?
        .map_err(io_err(ctx))?;
        Ok(res.map(|file| InstallLock { _file: file }))
    }

    /// Waits for the exclusive install lock of `(id, version)`. Returns the
    /// guard and whether the caller had to wait. The lock is an OS advisory
    /// file lock, so a crashed installer never leaves a stale lock behind.
    /// Dropping the future cancels the wait.
    pub async fn acquire_lock(
        &self,
        id: ServerId,
        version: &str,
        max_wait: Duration,
    ) -> Result<(InstallLock, bool), CacheError> {
        let started = tokio::time::Instant::now();
        let mut waited = false;
        loop {
            if let Some(lock) = self.try_lock(id, version).await? {
                return Ok((lock, waited));
            }
            waited = true;
            if started.elapsed() >= max_wait {
                return Err(CacheError::LockTimeout(format!(
                    "{}/{}",
                    server_slug(id),
                    version
                )));
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

/// Exclusive install lock; released when dropped.
#[derive(Debug)]
pub struct InstallLock {
    _file: File,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::servers::spec::{Artifact, ArtifactKind};

    fn plan(version: &str, sha: &str) -> InstallPlan {
        InstallPlan {
            version: version.into(),
            artifacts: vec![Artifact {
                url: "http://x/y".into(),
                sha256: sha.into(),
                kind: ArtifactKind::TarGz,
                entry: "bin/tool".into(),
                parent: None,
            }],
        }
    }

    async fn fake_install(cache: &ServerCache, p: &InstallPlan, at: u64) {
        let dir = cache.version_dir(ServerId::Json, &p.version);
        tokio::fs::create_dir_all(dir.join("bin")).await.unwrap();
        tokio::fs::write(dir.join("bin/tool"), b"x").await.unwrap();
        let mut m = InstallMarker::for_plan(p);
        m.installed_at_ns = at;
        tokio::fs::write(dir.join(MARKER_FILE), serde_json::to_vec(&m).unwrap())
            .await
            .unwrap();
    }

    #[test]
    fn vscode_langservers_share_one_slug() {
        assert_eq!(server_slug(ServerId::Html), "vscode-langservers-extracted");
        assert_eq!(server_slug(ServerId::Html), server_slug(ServerId::Css));
        assert_eq!(server_slug(ServerId::Css), server_slug(ServerId::Json));
        let cache = ServerCache::new("/c");
        assert_eq!(
            cache.version_dir(ServerId::Html, "4.10.0"),
            cache.version_dir(ServerId::Json, "4.10.0")
        );
        for other in [
            ServerId::Vtsls,
            ServerId::RustAnalyzer,
            ServerId::Basedpyright,
            ServerId::Jdtls,
        ] {
            assert_ne!(server_slug(other), server_slug(ServerId::Html));
        }
    }

    #[tokio::test]
    async fn shared_slug_shares_completeness_and_lock() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = ServerCache::new(tmp.path());
        let p = plan("1.0.0", &"a".repeat(64));
        fake_install(&cache, &p, 1).await;
        assert!(cache.is_complete(ServerId::Html, &p).await);
        assert!(cache.is_complete(ServerId::Css, &p).await);
        let (_g, _) = cache
            .acquire_lock(ServerId::Html, "1.0.0", Duration::from_secs(1))
            .await
            .unwrap();
        let err = cache
            .acquire_lock(ServerId::Json, "1.0.0", Duration::from_millis(100))
            .await
            .unwrap_err();
        assert!(matches!(err, CacheError::LockTimeout(_)));
    }

    #[test]
    fn version_names_are_validated() {
        assert!(validate_version("1.2.3-beta+1").is_ok());
        for bad in ["", "..", ".hidden", "a/b", "a\\b", "a b"] {
            assert!(validate_version(bad).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn completeness_requires_matching_marker_and_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = ServerCache::new(tmp.path());
        let p = plan("1.0.0", &"a".repeat(64));
        assert!(!cache.is_complete(ServerId::Json, &p).await);
        fake_install(&cache, &p, 1).await;
        assert!(cache.is_complete(ServerId::Json, &p).await);
        // A different pinned hash for the same version is not complete.
        let other = plan("1.0.0", &"b".repeat(64));
        assert!(!cache.is_complete(ServerId::Json, &other).await);
        // Missing entry point means corrupt.
        tokio::fs::remove_file(cache.version_dir(ServerId::Json, "1.0.0").join("bin/tool"))
            .await
            .unwrap();
        assert!(!cache.is_complete(ServerId::Json, &p).await);
    }

    #[tokio::test]
    async fn lock_is_exclusive_and_released_on_drop() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = ServerCache::new(tmp.path());
        let (guard, waited) = cache
            .acquire_lock(ServerId::Css, "1.0.0", Duration::from_secs(1))
            .await
            .unwrap();
        assert!(!waited);
        let err = cache
            .acquire_lock(ServerId::Css, "1.0.0", Duration::from_millis(100))
            .await
            .unwrap_err();
        assert!(matches!(err, CacheError::LockTimeout(_)));
        // A different version is independent.
        cache
            .acquire_lock(ServerId::Css, "2.0.0", Duration::from_secs(1))
            .await
            .unwrap();
        drop(guard);
        cache
            .acquire_lock(ServerId::Css, "1.0.0", Duration::from_secs(1))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn prune_keeps_current_in_use_and_newest_previous() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = ServerCache::new(tmp.path());
        for (i, v) in ["1.0.0", "2.0.0", "3.0.0", "4.0.0"].iter().enumerate() {
            fake_install(&cache, &plan(v, &"c".repeat(64)), (i + 1) as u64).await;
        }
        // Corrupt dir without marker.
        tokio::fs::create_dir_all(cache.version_dir(ServerId::Json, "0.1.0"))
            .await
            .unwrap();
        let removed = cache
            .prune(ServerId::Json, "4.0.0", &["1.0.0".to_string()])
            .await;
        assert_eq!(removed, vec!["0.1.0".to_string(), "2.0.0".to_string()]);
        let left: Vec<String> = cache
            .installed_versions(ServerId::Json)
            .await
            .into_iter()
            .map(|m| m.version)
            .collect();
        assert_eq!(left, vec!["4.0.0", "3.0.0", "1.0.0"]);
    }
}
