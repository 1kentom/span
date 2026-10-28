//! The concrete [`LaunchResolver`]: runtime detection, install and launch spec.
//!
//! For one server the resolver
//! 1. locates the runtime the catalog demands (Node.js from `PATH`, a JDK for
//!    JDT LS, nothing for rust-analyzer), failing fast and before any download,
//! 2. installs the pinned artifacts into the cache root unless they are already
//!    cached and verified (`Installer`, which checks every SHA-256),
//! 3. builds the [`LaunchSpec`] through the catalog.
//!
//! Everything blocking runs on the blocking pool and the manager already calls
//! `resolve` from a spawned lifecycle task, so the editor never waits on it.
//!
//! # Finding a JDK
//!
//! JDT LS 1.62.0 needs Java 25 (see the catalog), which is rarely the default
//! `java`. [`locate_java`] looks, in order, at `JAVA_HOME`, the macOS
//! `/usr/libexec/java_home -v <n>+` helper, Homebrew `openjdk*` directories,
//! `/usr/lib/jvm/*` and finally `java` on `PATH`. Every probe uses an explicit
//! argument array, never a shell. If nothing qualifies, [`JavaLocateError`] names
//! the required version and every JDK that was found.
//!
//! # JDT LS state
//!
//! The `-data` and `-configuration` directories are created under
//! `<cache_root>/jdtls-state/<hash of workspace root>/`. They are writable and
//! unique per workspace root; the extracted distribution (including its
//! `config_*` directory) is only ever read, as the catalog passes it as the
//! read-only shared configuration area.

use std::ffi::OsString;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};

use super::cache::ServerCache;
use super::catalog::{self, CatalogError, LaunchContext, Platform};
use super::install::{Fetch, FetchError, HttpFetch, InstallError, Installer};
use super::manager::{LaunchResolver, ServerError};
use super::runtime::{
    self, parse_java_version, CommandProbe, RuntimeError, RuntimeInfo, SystemProbe,
};
use super::spec::{LaunchSpec, Runtime, ServerId};

// ---------------------------------------------------------------------------
// Java location
// ---------------------------------------------------------------------------

/// A JDK that was found and probed but is too old.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundJdk {
    pub java: PathBuf,
    pub version: String,
    pub major: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub struct JavaLocateError {
    pub required: u32,
    pub found: Vec<FoundJdk>,
}

impl std::fmt::Display for JavaLocateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Java {}+ is required by the Java language server",
            self.required
        )?;
        if self.found.is_empty() {
            return write!(f, ", but no Java installation was found");
        }
        let mut list = String::new();
        for (i, j) in self.found.iter().enumerate() {
            if i > 0 {
                list.push_str(", ");
            }
            let _ = write!(list, "{} (Java {})", j.java.display(), j.version);
        }
        write!(f, ", but only older versions were found: {list}")
    }
}

/// Where to look for a JDK. [`JavaSearch::from_host`] reads the real environment;
/// tests build their own.
#[derive(Debug, Clone, Default)]
pub struct JavaSearch {
    pub java_home: Option<PathBuf>,
    /// `/usr/libexec/java_home` on macOS.
    pub macos_java_home_tool: Option<PathBuf>,
    /// Homebrew `opt` directories (`/opt/homebrew/opt`, `/usr/local/opt`, ...).
    pub brew_opt_dirs: Vec<PathBuf>,
    /// Linux style JVM directories (`/usr/lib/jvm`).
    pub jvm_dirs: Vec<PathBuf>,
    pub path: Option<OsString>,
}

impl JavaSearch {
    pub fn from_host() -> Self {
        let tool = PathBuf::from("/usr/libexec/java_home");
        Self {
            java_home: std::env::var_os("JAVA_HOME")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            macos_java_home_tool: (cfg!(target_os = "macos") && tool.exists()).then_some(tool),
            brew_opt_dirs: vec![
                PathBuf::from("/opt/homebrew/opt"),
                PathBuf::from("/usr/local/opt"),
                PathBuf::from("/home/linuxbrew/.linuxbrew/opt"),
            ],
            jvm_dirs: vec![PathBuf::from("/usr/lib/jvm")],
            path: std::env::var_os("PATH"),
        }
    }
}

fn java_exe() -> &'static str {
    if cfg!(windows) {
        "java.exe"
    } else {
        "java"
    }
}

/// Homebrew formula directories named `openjdk` or `openjdk@N`, newest first
/// (the unversioned formula tracks the latest release).
fn brew_jdk_homes(opt: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(opt) else {
        return Vec::new();
    };
    let mut dirs: Vec<(u32, PathBuf)> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let rest = name.strip_prefix("openjdk")?;
            let rank = match rest.strip_prefix('@') {
                None if rest.is_empty() => u32::MAX,
                Some(v) => v.parse().ok()?,
                None => return None,
            };
            Some((rank, e.path()))
        })
        .collect();
    dirs.sort_by_key(|a| std::cmp::Reverse(a.0));
    let mut homes = Vec::new();
    for (_, dir) in dirs {
        // macOS bottles keep the JDK under libexec; Linux keeps bin/ at top level.
        homes.push(dir.join("libexec/openjdk.jdk/Contents/Home"));
        homes.push(dir);
    }
    homes
}

fn probe_java(probe: &dyn CommandProbe, java: &Path) -> Option<FoundJdk> {
    let out = probe.run(java, &["-version"]).ok()?;
    if !out.success {
        return None;
    }
    let combined = format!("{}\n{}", out.stdout, out.stderr);
    let (version, major) = parse_java_version(&combined)?;
    Some(FoundJdk {
        java: java.to_path_buf(),
        version,
        major,
    })
}

/// Finds a JDK with at least `required` as its major version.
pub fn locate_java(
    probe: &dyn CommandProbe,
    search: &JavaSearch,
    required: u32,
) -> Result<RuntimeInfo, JavaLocateError> {
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut too_old: Vec<FoundJdk> = Vec::new();

    let mut try_java = |java: PathBuf| -> Option<RuntimeInfo> {
        if seen.contains(&java) {
            return None;
        }
        seen.push(java.clone());
        let found = probe_java(probe, &java)?;
        if found.major >= required {
            return Some(RuntimeInfo {
                runtime: Runtime::Java,
                program: found.java,
                version: found.version,
                major: found.major,
            });
        }
        too_old.push(found);
        None
    };

    if let Some(home) = &search.java_home {
        if let Some(info) = try_java(home.join("bin").join(java_exe())) {
            return Ok(info);
        }
    }

    if let Some(tool) = &search.macos_java_home_tool {
        let want = format!("{required}+");
        if let Ok(out) = probe.run(tool, &["-v", &want]) {
            let home = out.stdout.trim();
            if out.success && !home.is_empty() {
                if let Some(info) = try_java(Path::new(home).join("bin").join(java_exe())) {
                    return Ok(info);
                }
            }
        }
    }

    for opt in &search.brew_opt_dirs {
        for home in brew_jdk_homes(opt) {
            let java = home.join("bin").join(java_exe());
            if java.is_file() {
                if let Some(info) = try_java(java) {
                    return Ok(info);
                }
            }
        }
    }

    for dir in &search.jvm_dirs {
        let Ok(rd) = std::fs::read_dir(dir) else {
            continue;
        };
        let mut homes: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        homes.sort();
        homes.reverse();
        for home in homes {
            let java = home.join("bin").join(java_exe());
            if java.is_file() {
                if let Some(info) = try_java(java) {
                    return Ok(info);
                }
            }
        }
    }

    if let Some(path) = &search.path {
        for dir in std::env::split_paths(path) {
            let java = dir.join(java_exe());
            if java.is_file() {
                if let Some(info) = try_java(java) {
                    return Ok(info);
                }
            }
        }
    }

    Err(JavaLocateError {
        required,
        found: too_old,
    })
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum ResolveError {
    #[error("{0:?} has no pinned build for this platform")]
    UnsupportedPlatform(ServerId),
    #[error(transparent)]
    Runtime(#[from] RuntimeError),
    #[error(transparent)]
    Java(#[from] JavaLocateError),
    #[error(transparent)]
    Catalog(#[from] CatalogError),
    #[error("installing {server:?} failed: {source}")]
    Install {
        server: ServerId,
        source: InstallError,
    },
    #[error("preparing {path}: {message}")]
    State { path: PathBuf, message: String },
    #[error("a background task failed: {0}")]
    Task(String),
}

impl From<ResolveError> for ServerError {
    fn from(e: ResolveError) -> Self {
        ServerError::Launch(e.to_string())
    }
}

/// Resolves launch commands from the pinned catalog, installing on demand.
pub struct CatalogResolver {
    installer: Installer,
    cache_root: PathBuf,
    platform: Option<Platform>,
    java_search: JavaSearch,
}

impl CatalogResolver {
    /// Downloads over HTTPS with the real [`HttpFetch`].
    pub fn new(cache_root: impl Into<PathBuf>) -> Result<Self, FetchError> {
        Ok(Self::with_fetch(cache_root, Arc::new(HttpFetch::new()?)))
    }

    /// Uses a caller supplied download source (tests point it at a local server).
    pub fn with_fetch(cache_root: impl Into<PathBuf>, fetch: Arc<dyn Fetch>) -> Self {
        let cache_root = cache_root.into();
        Self {
            installer: Installer::new(ServerCache::new(cache_root.clone()), fetch),
            cache_root,
            platform: Platform::current(),
            java_search: JavaSearch::from_host(),
        }
    }

    /// Overrides the target platform (tests).
    pub fn with_platform(mut self, platform: Platform) -> Self {
        self.platform = Some(platform);
        self
    }

    /// Overrides where JDKs are searched for (tests).
    pub fn with_java_search(mut self, search: JavaSearch) -> Self {
        self.java_search = search;
        self
    }

    pub fn cache_root(&self) -> &Path {
        &self.cache_root
    }

    /// Resolves a launch command. `root` selects the per-workspace JDT LS state;
    /// without it a shared "default" workspace is used.
    pub async fn resolve_typed(
        &self,
        id: ServerId,
        root: Option<&Path>,
    ) -> Result<LaunchSpec, ResolveError> {
        let platform = self.platform.ok_or(ResolveError::UnsupportedPlatform(id))?;
        let spec = catalog::spec(id);

        // Runtime first: failing here must not cost a download.
        let req = spec.runtime.clone();
        let search = self.java_search.clone();
        let runtime =
            tokio::task::spawn_blocking(move || -> Result<Option<RuntimeInfo>, ResolveError> {
                match req.runtime {
                    Runtime::None => Ok(None),
                    Runtime::Node => Ok(Some(runtime::locate_node(
                        &SystemProbe,
                        &runtime::NodeSearch::from_env(),
                        req.min_major,
                    )?)),
                    Runtime::Java => Ok(Some(locate_java(&SystemProbe, &search, req.min_major)?)),
                }
            })
            .await
            .map_err(|e| ResolveError::Task(e.to_string()))??;

        let plan = catalog::install_plan(id, platform)?;
        let installed = self
            .installer
            .install(id, &plan, &[], None)
            .await
            .map_err(|source| ResolveError::Install { server: id, source })?;

        let mut ctx = LaunchContext::new(installed.dir, platform);
        if let Some(rt) = &runtime {
            ctx.runtime_program = Some(rt.program.clone());
            if rt.runtime == Runtime::Java {
                ctx.java_major = Some(rt.major);
            }
        }
        if id == ServerId::Jdtls {
            let state = self.jdtls_state_dir(root);
            let data = state.join("data");
            let config = state.join("config");
            for dir in [&data, &config] {
                tokio::fs::create_dir_all(dir)
                    .await
                    .map_err(|e| ResolveError::State {
                        path: dir.clone(),
                        message: e.to_string(),
                    })?;
            }
            ctx.workspace_dir = Some(data);
            ctx.config_dir = Some(config);
        }
        Ok(catalog::launch_spec(id, &ctx)?)
    }

    fn jdtls_state_dir(&self, root: Option<&Path>) -> PathBuf {
        let key = root
            .map(|r| r.to_string_lossy().into_owned())
            .unwrap_or_else(|| "default".to_string());
        let digest = Sha256::digest(key.as_bytes());
        let mut name = String::with_capacity(16);
        for b in &digest[..8] {
            let _ = write!(name, "{b:02x}");
        }
        self.cache_root.join("jdtls-state").join(name)
    }
}

impl LaunchResolver for CatalogResolver {
    async fn resolve(&self, id: ServerId) -> Result<LaunchSpec, ServerError> {
        Ok(self.resolve_typed(id, None).await?)
    }

    async fn resolve_for(&self, id: ServerId, root: &Path) -> Result<LaunchSpec, ServerError> {
        Ok(self.resolve_typed(id, Some(root)).await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::servers::runtime::ProbeOutput;
    use std::collections::HashMap;
    use std::io;

    /// Canned `java -version` / `java_home` answers keyed by program path.
    #[derive(Default)]
    struct FakeProbe {
        java: HashMap<PathBuf, &'static str>,
        java_home_answer: Option<(PathBuf, String)>,
    }

    impl CommandProbe for FakeProbe {
        fn run(&self, program: &Path, args: &[&str]) -> io::Result<ProbeOutput> {
            if let Some((tool, home)) = &self.java_home_answer {
                if program == tool {
                    assert_eq!(args[0], "-v");
                    return Ok(ProbeOutput {
                        success: true,
                        stdout: format!("{home}\n"),
                        stderr: String::new(),
                    });
                }
            }
            assert_eq!(args, ["-version"]);
            match self.java.get(program) {
                Some(v) => Ok(ProbeOutput {
                    success: true,
                    stdout: String::new(),
                    stderr: format!("openjdk version \"{v}\" 2026-01-01\n"),
                }),
                None => Err(io::Error::from(io::ErrorKind::NotFound)),
            }
        }
    }

    fn make_java(home: &Path) -> PathBuf {
        let bin = home.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let java = bin.join("java");
        std::fs::write(&java, "").unwrap();
        java
    }

    #[test]
    fn java_home_wins_when_new_enough() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("jdk27");
        let java = make_java(&home);
        let mut probe = FakeProbe::default();
        probe.java.insert(java.clone(), "27.0.1");
        let search = JavaSearch {
            java_home: Some(home),
            ..Default::default()
        };
        let info = locate_java(&probe, &search, 25).unwrap();
        assert_eq!(info.program, java);
        assert_eq!(info.major, 27);
    }

    #[test]
    fn skips_old_java_home_and_uses_macos_helper() {
        let dir = tempfile::tempdir().unwrap();
        let old = make_java(&dir.path().join("jdk21"));
        let new_home = dir.path().join("jdk25");
        let new = make_java(&new_home);
        let tool = dir.path().join("java_home");
        let mut probe = FakeProbe::default();
        probe.java.insert(old, "21.0.13");
        probe.java.insert(new.clone(), "25.0.1");
        probe.java_home_answer = Some((tool.clone(), new_home.to_string_lossy().into_owned()));
        let search = JavaSearch {
            java_home: Some(dir.path().join("jdk21")),
            macos_java_home_tool: Some(tool),
            ..Default::default()
        };
        let info = locate_java(&probe, &search, 25).unwrap();
        assert_eq!(info.program, new);
    }

    #[test]
    fn finds_homebrew_openjdk_newest_first_before_path() {
        let dir = tempfile::tempdir().unwrap();
        let opt = dir.path().join("opt");
        let j21 = make_java(&opt.join("openjdk@21/libexec/openjdk.jdk/Contents/Home"));
        let j27 = make_java(&opt.join("openjdk@27/libexec/openjdk.jdk/Contents/Home"));
        let path_java = make_java(&dir.path().join("pathjdk"));
        let mut probe = FakeProbe::default();
        probe.java.insert(j21, "21.0.13");
        probe.java.insert(j27.clone(), "27.0.1");
        probe.java.insert(path_java, "21.0.13");
        let search = JavaSearch {
            brew_opt_dirs: vec![opt],
            path: Some(dir.path().join("pathjdk/bin").into_os_string()),
            ..Default::default()
        };
        assert_eq!(locate_java(&probe, &search, 25).unwrap().program, j27);
    }

    #[test]
    fn falls_back_to_path() {
        let dir = tempfile::tempdir().unwrap();
        let path_java = make_java(&dir.path().join("pathjdk"));
        let mut probe = FakeProbe::default();
        probe.java.insert(path_java.clone(), "25");
        let search = JavaSearch {
            path: Some(dir.path().join("pathjdk/bin").into_os_string()),
            ..Default::default()
        };
        let info = locate_java(&probe, &search, 25).unwrap();
        assert_eq!(info.program, path_java);
        assert_eq!(info.major, 25);
    }

    #[test]
    fn error_names_required_version_and_what_was_found() {
        let dir = tempfile::tempdir().unwrap();
        let j21 = make_java(&dir.path().join("jdk21"));
        let mut probe = FakeProbe::default();
        probe.java.insert(j21.clone(), "21.0.13");
        let search = JavaSearch {
            java_home: Some(dir.path().join("jdk21")),
            ..Default::default()
        };
        let err = locate_java(&probe, &search, 25).unwrap_err();
        assert_eq!(err.required, 25);
        assert_eq!(err.found.len(), 1);
        assert_eq!(err.found[0].major, 21);
        let text = err.to_string();
        assert!(text.contains("Java 25+"), "{text}");
        assert!(text.contains("21.0.13"), "{text}");
        assert!(text.contains(&j21.display().to_string()), "{text}");
    }

    #[test]
    fn error_when_nothing_is_installed() {
        let probe = FakeProbe::default();
        let err = locate_java(&probe, &JavaSearch::default(), 25).unwrap_err();
        assert!(err.found.is_empty());
        assert!(err.to_string().contains("no Java installation"), "{err}");
    }

    #[test]
    fn java_error_converts_to_launch_error_with_message() {
        let e: ResolveError = JavaLocateError {
            required: 25,
            found: vec![],
        }
        .into();
        match ServerError::from(e) {
            ServerError::Launch(m) => assert!(m.contains("Java 25+"), "{m}"),
            other => panic!("{other:?}"),
        }
    }

    struct NoFetch;
    impl Fetch for NoFetch {
        fn get<'a>(
            &'a self,
            _url: &'a str,
        ) -> super::super::install::BoxFuture<
            'a,
            Result<super::super::install::FetchResponse, FetchError>,
        > {
            Box::pin(async { Err(FetchError("offline".into())) })
        }
    }

    #[tokio::test]
    async fn missing_jdk_fails_before_any_download() {
        let dir = tempfile::tempdir().unwrap();
        let r = CatalogResolver::with_fetch(dir.path(), Arc::new(NoFetch))
            .with_java_search(JavaSearch::default());
        let err = r.resolve_typed(ServerId::Jdtls, None).await.unwrap_err();
        assert!(matches!(err, ResolveError::Java(_)), "{err:?}");
        assert!(!dir.path().join("jdtls").exists());
    }

    #[tokio::test]
    async fn download_failure_is_a_typed_install_error() {
        let dir = tempfile::tempdir().unwrap();
        let r = CatalogResolver::with_fetch(dir.path(), Arc::new(NoFetch));
        // rust-analyzer needs no runtime, so the failure comes from the fetch.
        let err = r
            .resolve_typed(ServerId::RustAnalyzer, None)
            .await
            .unwrap_err();
        assert!(matches!(err, ResolveError::Install { .. }), "{err:?}");
    }

    #[test]
    fn jdtls_state_dirs_are_per_root_and_under_cache() {
        let dir = tempfile::tempdir().unwrap();
        let r = CatalogResolver::with_fetch(dir.path(), Arc::new(NoFetch));
        let a = r.jdtls_state_dir(Some(Path::new("/a")));
        let b = r.jdtls_state_dir(Some(Path::new("/b")));
        assert_ne!(a, b);
        assert_eq!(a, r.jdtls_state_dir(Some(Path::new("/a"))));
        assert!(a.starts_with(dir.path()));
    }
}
