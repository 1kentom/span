//! Host runtime detection (Node.js and Java) for servers that need one.
//!
//! The probe runs `node --version` or `java -version` through
//! `std::process::Command` with explicit arguments, never a shell. Probing is
//! behind [`CommandProbe`] so tests can inject canned output.
//!
//! Output formats handled:
//! - `node --version` prints `v22.23.2` on stdout.
//! - `java -version` prints to stderr, for example
//!   `openjdk version "21.0.5" 2024-10-15 LTS`, `java version "1.8.0_392"`
//!   (legacy `1.x` scheme, major 8) or `openjdk version "25" 2025-09-16`,
//!   possibly after a `Picked up JAVA_TOOL_OPTIONS: ...` line.

use super::spec::{Runtime, RuntimeRequirement};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// A runtime that was found and is new enough.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeInfo {
    pub runtime: Runtime,
    /// Executable that was probed (use it as `LaunchSpec::program`).
    pub program: PathBuf,
    /// Full version string, for example `22.23.2` or `21.0.5`.
    pub version: String,
    pub major: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RuntimeError {
    #[error("{name} is not installed (could not run `{program}`); {name} {required}+ is required")]
    Missing {
        runtime: Runtime,
        name: &'static str,
        program: String,
        required: u32,
    },
    #[error("{name} {found} is too old; {name} {required}+ is required")]
    TooOld {
        runtime: Runtime,
        name: &'static str,
        found: String,
        required: u32,
    },
    #[error("could not read the {name} version from the output of `{program}`: {output:?}")]
    Unparseable {
        runtime: Runtime,
        name: &'static str,
        program: String,
        output: String,
    },
    #[error("running `{program}` failed: {reason}")]
    ProbeFailed {
        runtime: Runtime,
        name: &'static str,
        program: String,
        reason: String,
    },
}

fn runtime_name(runtime: &Runtime) -> &'static str {
    match runtime {
        Runtime::Node => "Node.js",
        Runtime::Java => "Java",
        Runtime::None => "no runtime",
    }
}

/// Captured result of a probe command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a program with explicit arguments and captures its output.
pub trait CommandProbe {
    fn run(&self, program: &Path, args: &[&str]) -> io::Result<ProbeOutput>;
}

/// Real probe backed by `std::process::Command`. Stdin is closed. There is no
/// timeout: `node --version` and `java -version` return immediately.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemProbe;

impl CommandProbe for SystemProbe {
    fn run(&self, program: &Path, args: &[&str]) -> io::Result<ProbeOutput> {
        let out = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .output()?;
        Ok(ProbeOutput {
            success: out.status.success(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }
}

/// Parses `node --version` output (`v22.23.2`) into (version, major).
pub fn parse_node_version(output: &str) -> Option<(String, u32)> {
    let token = output.split_whitespace().next()?;
    let version = token.strip_prefix('v').unwrap_or(token);
    let major = leading_number(version)?;
    Some((version.to_string(), major))
}

/// Parses `java -version` output into (version, major). Handles the legacy
/// `1.8.0_392` scheme (major 8), plain `21`, and suffixes such as `-ea`/`+35`.
pub fn parse_java_version(output: &str) -> Option<(String, u32)> {
    let line = output.lines().find(|l| l.contains("version \""))?;
    let rest = &line[line.find("version \"")? + "version \"".len()..];
    let version = &rest[..rest.find('"')?];
    let major = if let Some(legacy) = version.strip_prefix("1.") {
        leading_number(legacy)?
    } else {
        leading_number(version)?
    };
    Some((version.to_string(), major))
}

fn leading_number(s: &str) -> Option<u32> {
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Candidate executable for a runtime. Java honours `JAVA_HOME` first, as the
/// JDTLS wrapper script does, then falls back to `java` on `PATH`.
fn candidate_programs(runtime: &Runtime, java_home: Option<&Path>) -> Vec<PathBuf> {
    match runtime {
        Runtime::Node => vec![PathBuf::from("node")],
        Runtime::Java => {
            let mut v = Vec::new();
            if let Some(home) = java_home {
                let exe = if cfg!(windows) { "java.exe" } else { "java" };
                v.push(home.join("bin").join(exe));
            }
            v.push(PathBuf::from("java"));
            v
        }
        Runtime::None => Vec::new(),
    }
}

/// Probes one program and checks it against the requirement.
fn probe_one(
    probe: &dyn CommandProbe,
    program: &Path,
    req: &RuntimeRequirement,
) -> Result<RuntimeInfo, RuntimeError> {
    let name = runtime_name(&req.runtime);
    let shown = program.display().to_string();
    let args: &[&str] = match req.runtime {
        Runtime::Node => &["--version"],
        Runtime::Java => &["-version"],
        Runtime::None => &[],
    };
    let out = match probe.run(program, args) {
        Ok(o) => o,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Err(RuntimeError::Missing {
                runtime: req.runtime.clone(),
                name,
                program: shown,
                required: req.min_major,
            })
        }
        Err(e) => {
            return Err(RuntimeError::ProbeFailed {
                runtime: req.runtime.clone(),
                name,
                program: shown,
                reason: e.to_string(),
            })
        }
    };
    if !out.success {
        return Err(RuntimeError::ProbeFailed {
            runtime: req.runtime.clone(),
            name,
            program: shown,
            reason: format!("non-zero exit: {}", out.stderr.trim()),
        });
    }
    // `java -version` writes to stderr; node writes to stdout. Accept either.
    let combined = format!("{}\n{}", out.stdout, out.stderr);
    let parsed = match req.runtime {
        Runtime::Java => parse_java_version(&combined),
        _ => parse_node_version(combined.trim_start()),
    };
    let Some((version, major)) = parsed else {
        return Err(RuntimeError::Unparseable {
            runtime: req.runtime.clone(),
            name,
            program: shown,
            output: combined.trim().to_string(),
        });
    };
    if major < req.min_major {
        return Err(RuntimeError::TooOld {
            runtime: req.runtime.clone(),
            name,
            found: version,
            required: req.min_major,
        });
    }
    Ok(RuntimeInfo {
        runtime: req.runtime.clone(),
        program: program.to_path_buf(),
        version,
        major,
    })
}

/// Detects the runtime demanded by `req` using an injectable probe.
///
/// Returns `Ok(None)` when no runtime is required. For Java, `java_home`
/// (normally `$JAVA_HOME`) is tried before `java` on `PATH`; when a candidate
/// exists but is too old, that error is reported unless a later candidate
/// satisfies the requirement.
pub fn detect_with(
    probe: &dyn CommandProbe,
    req: &RuntimeRequirement,
    java_home: Option<&Path>,
) -> Result<Option<RuntimeInfo>, RuntimeError> {
    let candidates = candidate_programs(&req.runtime, java_home);
    if candidates.is_empty() {
        return Ok(None);
    }
    probe_candidates(probe, &candidates, req).map(Some)
}

/// Probes candidates in order and returns the first that satisfies `req`.
/// When none does, the most informative error wins (too old or unparseable
/// beats missing). `candidates` must not be empty.
fn probe_candidates(
    probe: &dyn CommandProbe,
    candidates: &[PathBuf],
    req: &RuntimeRequirement,
) -> Result<RuntimeInfo, RuntimeError> {
    let mut first_err: Option<RuntimeError> = None;
    for program in candidates {
        match probe_one(probe, program, req) {
            Ok(info) => return Ok(info),
            Err(e) => {
                // Prefer an informative error (too old, unparseable) over a
                // missing candidate, whichever order they were probed in.
                let replace = match &first_err {
                    None => true,
                    Some(RuntimeError::Missing { .. }) => {
                        !matches!(e, RuntimeError::Missing { .. })
                    }
                    Some(_) => false,
                };
                if replace {
                    first_err = Some(e);
                }
            }
        }
    }
    Err(first_err.expect("at least one candidate was probed"))
}

/// Where to look for Node.js. A GUI app started from Finder gets a minimal
/// `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so Homebrew, nvm, Volta and fnm
/// installs are only found through the explicit locations below.
#[derive(Debug, Clone, Default)]
pub struct NodeSearch {
    /// Explicit node executable, tried first (for example a user setting).
    pub override_program: Option<PathBuf>,
    /// Value of `PATH`. Only absolute entries are used.
    pub path_env: Option<std::ffi::OsString>,
    /// Home directory for `~/.volta`, `~/.nvm` and `~/.local/share/fnm`.
    pub home: Option<PathBuf>,
    /// System directories tried after `PATH` and before the home locations.
    pub system_dirs: Vec<PathBuf>,
}

impl NodeSearch {
    /// Search configuration for the current process environment.
    pub fn from_env() -> Self {
        Self {
            override_program: std::env::var_os("SPAN_NODE").map(PathBuf::from),
            path_env: std::env::var_os("PATH"),
            home: std::env::var_os("HOME").map(PathBuf::from),
            system_dirs: vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin"),
            ],
        }
    }

    /// Candidate absolute paths in probe order: override, `PATH`, system
    /// directories, Volta, nvm (newest first), fnm (newest first).
    pub fn candidates(&self) -> Vec<PathBuf> {
        let exe = if cfg!(windows) { "node.exe" } else { "node" };
        let mut out: Vec<PathBuf> = Vec::new();
        let mut push = |p: PathBuf| {
            if p.is_absolute() && !out.contains(&p) {
                out.push(p);
            }
        };
        if let Some(p) = &self.override_program {
            push(p.clone());
        }
        if let Some(path) = &self.path_env {
            for dir in std::env::split_paths(path) {
                push(dir.join(exe));
            }
        }
        for dir in &self.system_dirs {
            push(dir.join(exe));
        }
        if let Some(home) = &self.home {
            push(home.join(".volta").join("bin").join(exe));
            for dir in versioned_dirs(&home.join(".nvm").join("versions").join("node")) {
                push(dir.join("bin").join(exe));
            }
            for dir in versioned_dirs(
                &home
                    .join(".local")
                    .join("share")
                    .join("fnm")
                    .join("node-versions"),
            ) {
                push(dir.join("installation").join("bin").join(exe));
            }
        }
        out
    }
}

/// Subdirectories of `root` named like `v22.1.0`, newest version first.
fn versioned_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found: Vec<(Vec<u32>, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let parts: Option<Vec<u32>> = name
                .trim_start_matches('v')
                .split('.')
                .map(|p| p.parse().ok())
                .collect();
            Some((parts?, e.path()))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, p)| p).collect()
}

/// Finds a Node.js that satisfies `min_major`. The returned
/// [`RuntimeInfo::program`] is always an absolute path.
pub fn locate_node(
    probe: &dyn CommandProbe,
    search: &NodeSearch,
    min_major: u32,
) -> Result<RuntimeInfo, RuntimeError> {
    let req = RuntimeRequirement {
        runtime: Runtime::Node,
        min_major,
    };
    let mut candidates = search.candidates();
    if candidates.is_empty() {
        // Keep a typed Missing error that names what was wanted.
        candidates.push(PathBuf::from("node"));
    }
    probe_candidates(probe, &candidates, &req)
}

/// Detects the runtime on the host with the real process probe.
pub fn detect(req: &RuntimeRequirement) -> Result<Option<RuntimeInfo>, RuntimeError> {
    let java_home = std::env::var_os("JAVA_HOME").map(PathBuf::from);
    detect_with(&SystemProbe, req, java_home.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// Maps a program path to a canned result and records calls.
    struct FakeProbe {
        results: HashMap<PathBuf, io::Result<ProbeOutput>>,
        calls: RefCell<Vec<(PathBuf, Vec<String>)>>,
    }

    impl FakeProbe {
        fn new() -> Self {
            Self {
                results: HashMap::new(),
                calls: RefCell::new(Vec::new()),
            }
        }
        fn with(mut self, program: &str, r: io::Result<ProbeOutput>) -> Self {
            self.results.insert(PathBuf::from(program), r);
            self
        }
    }

    impl CommandProbe for FakeProbe {
        fn run(&self, program: &Path, args: &[&str]) -> io::Result<ProbeOutput> {
            self.calls.borrow_mut().push((
                program.to_path_buf(),
                args.iter().map(|a| a.to_string()).collect(),
            ));
            match self.results.get(program) {
                Some(Ok(o)) => Ok(o.clone()),
                Some(Err(e)) => Err(io::Error::new(e.kind(), e.to_string())),
                None => Err(io::Error::new(io::ErrorKind::NotFound, "not found")),
            }
        }
    }

    fn ok(stdout: &str, stderr: &str) -> io::Result<ProbeOutput> {
        Ok(ProbeOutput {
            success: true,
            stdout: stdout.into(),
            stderr: stderr.into(),
        })
    }

    fn node(min: u32) -> RuntimeRequirement {
        RuntimeRequirement {
            runtime: Runtime::Node,
            min_major: min,
        }
    }
    fn java(min: u32) -> RuntimeRequirement {
        RuntimeRequirement {
            runtime: Runtime::Java,
            min_major: min,
        }
    }

    #[test]
    fn parses_real_node_output() {
        assert_eq!(
            parse_node_version("v22.23.2\n"),
            Some(("22.23.2".into(), 22))
        );
        assert_eq!(parse_node_version("v18.0.0"), Some(("18.0.0".into(), 18)));
        assert_eq!(
            parse_node_version("v8.17.0\r\n"),
            Some(("8.17.0".into(), 8))
        );
        assert_eq!(parse_node_version(""), None);
        assert_eq!(parse_node_version("command not found"), None);
    }

    #[test]
    fn parses_real_java_output() {
        let jdk21 = "openjdk version \"21.0.5\" 2024-10-15 LTS\n\
                     OpenJDK Runtime Environment Homebrew (build 21.0.5+11-LTS)\n\
                     OpenJDK 64-Bit Server VM Homebrew (build 21.0.5+11-LTS, mixed mode, sharing)\n";
        assert_eq!(parse_java_version(jdk21), Some(("21.0.5".into(), 21)));

        let jdk8 =
            "java version \"1.8.0_392\"\nJava(TM) SE Runtime Environment (build 1.8.0_392-b08)\n";
        assert_eq!(parse_java_version(jdk8), Some(("1.8.0_392".into(), 8)));

        let jdk17 = "openjdk version \"17.0.9\" 2023-10-17\nOpenJDK Runtime Environment Temurin-17.0.9+9 (build 17.0.9+9)\n";
        assert_eq!(parse_java_version(jdk17), Some(("17.0.9".into(), 17)));

        assert_eq!(
            parse_java_version("openjdk version \"25\" 2025-09-16\n"),
            Some(("25".into(), 25))
        );
        assert_eq!(
            parse_java_version("openjdk version \"26-ea\" 2026-03-17\n"),
            Some(("26-ea".into(), 26))
        );
        let with_banner = "Picked up JAVA_TOOL_OPTIONS: -Dfile.encoding=UTF-8\nopenjdk version \"21.0.2\" 2024-01-16\n";
        assert_eq!(parse_java_version(with_banner), Some(("21.0.2".into(), 21)));
        assert_eq!(parse_java_version("nothing useful"), None);
    }

    #[test]
    fn accepts_new_enough_node_and_uses_explicit_args() {
        let probe = FakeProbe::new().with("node", ok("v22.23.2\n", ""));
        let info = detect_with(&probe, &node(18), None).unwrap().unwrap();
        assert_eq!(info.major, 22);
        assert_eq!(info.version, "22.23.2");
        assert_eq!(info.program, PathBuf::from("node"));
        assert_eq!(
            *probe.calls.borrow(),
            vec![(PathBuf::from("node"), vec!["--version".to_string()])]
        );
    }

    #[test]
    fn rejects_old_node_with_versions_in_message() {
        let probe = FakeProbe::new().with("node", ok("v16.20.2\n", ""));
        let err = detect_with(&probe, &node(18), None).unwrap_err();
        assert!(matches!(err, RuntimeError::TooOld { required: 18, .. }));
        assert_eq!(
            err.to_string(),
            "Node.js 16.20.2 is too old; Node.js 18+ is required"
        );
    }

    #[test]
    fn reports_missing_runtime() {
        let probe = FakeProbe::new();
        let err = detect_with(&probe, &node(18), None).unwrap_err();
        assert!(matches!(err, RuntimeError::Missing { required: 18, .. }));
        assert!(err.to_string().contains("Node.js is not installed"));
        assert!(err.to_string().contains("18+ is required"));
    }

    #[test]
    fn java_reads_stderr_and_checks_minimum() {
        let out = "openjdk version \"21.0.5\" 2024-10-15 LTS\n";
        let probe = FakeProbe::new().with("java", ok("", out));
        let info = detect_with(&probe, &java(21), None).unwrap().unwrap();
        assert_eq!((info.major, info.version.as_str()), (21, "21.0.5"));
        assert_eq!(probe.calls.borrow()[0].1, vec!["-version".to_string()]);

        let old = FakeProbe::new().with("java", ok("", "java version \"1.8.0_392\"\n"));
        let err = detect_with(&old, &java(21), None).unwrap_err();
        assert_eq!(
            err.to_string(),
            "Java 1.8.0_392 is too old; Java 21+ is required"
        );
    }

    #[test]
    fn java_home_is_preferred_and_path_is_the_fallback() {
        let home = Path::new("/jdk");
        let home_java = home
            .join("bin")
            .join(if cfg!(windows) { "java.exe" } else { "java" });
        let probe = FakeProbe::new()
            .with(
                home_java.to_str().unwrap(),
                ok("", "openjdk version \"21.0.5\" 2024-10-15\n"),
            )
            .with("java", ok("", "openjdk version \"17.0.9\" 2023-10-17\n"));
        let info = detect_with(&probe, &java(21), Some(home)).unwrap().unwrap();
        assert_eq!(info.program, home_java);

        // JAVA_HOME points nowhere: fall back to PATH.
        let probe =
            FakeProbe::new().with("java", ok("", "openjdk version \"21.0.5\" 2024-10-15\n"));
        let info = detect_with(&probe, &java(21), Some(home)).unwrap().unwrap();
        assert_eq!(info.program, PathBuf::from("java"));
    }

    #[test]
    fn too_old_java_home_is_not_masked_by_missing_path_java() {
        let home = Path::new("/jdk");
        let home_java = home
            .join("bin")
            .join(if cfg!(windows) { "java.exe" } else { "java" });
        let probe = FakeProbe::new().with(
            home_java.to_str().unwrap(),
            ok("", "openjdk version \"17.0.9\" 2023-10-17\n"),
        );
        let err = detect_with(&probe, &java(21), Some(home)).unwrap_err();
        assert!(
            matches!(err, RuntimeError::TooOld { required: 21, .. }),
            "{err:?}"
        );
    }

    #[test]
    fn unparseable_and_failed_probes_are_typed() {
        let probe = FakeProbe::new().with("node", ok("hello\n", ""));
        assert!(matches!(
            detect_with(&probe, &node(18), None).unwrap_err(),
            RuntimeError::Unparseable { .. }
        ));

        let probe = FakeProbe::new().with(
            "node",
            Ok(ProbeOutput {
                success: false,
                stdout: String::new(),
                stderr: "boom".into(),
            }),
        );
        assert!(matches!(
            detect_with(&probe, &node(18), None).unwrap_err(),
            RuntimeError::ProbeFailed { .. }
        ));

        let probe = FakeProbe::new().with(
            "node",
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied")),
        );
        assert!(matches!(
            detect_with(&probe, &node(18), None).unwrap_err(),
            RuntimeError::ProbeFailed { .. }
        ));
    }

    #[test]
    fn no_runtime_requirement_needs_no_probe() {
        let probe = FakeProbe::new();
        let req = RuntimeRequirement {
            runtime: Runtime::None,
            min_major: 0,
        };
        assert_eq!(detect_with(&probe, &req, None), Ok(None));
        assert!(probe.calls.borrow().is_empty());
    }

    fn fake_home() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for v in ["v18.20.0", "v22.1.0", "v9.0.0"] {
            std::fs::create_dir_all(dir.path().join(".nvm/versions/node").join(v).join("bin"))
                .unwrap();
        }
        dir
    }

    fn search_in(home: &Path) -> NodeSearch {
        NodeSearch {
            override_program: None,
            path_env: Some(std::ffi::OsString::new()),
            home: Some(home.to_path_buf()),
            system_dirs: vec![PathBuf::from("/opt/homebrew/bin")],
        }
    }

    #[test]
    fn node_candidates_follow_documented_order_with_empty_path() {
        let home = fake_home();
        let mut search = search_in(home.path());
        search.override_program = Some(PathBuf::from("/custom/node"));
        let c = search.candidates();
        let h = home.path();
        assert_eq!(
            c,
            vec![
                PathBuf::from("/custom/node"),
                PathBuf::from("/opt/homebrew/bin/node"),
                h.join(".volta/bin/node"),
                h.join(".nvm/versions/node/v22.1.0/bin/node"),
                h.join(".nvm/versions/node/v18.20.0/bin/node"),
                h.join(".nvm/versions/node/v9.0.0/bin/node"),
            ]
        );
        assert!(c.iter().all(|p| p.is_absolute()));
    }

    #[test]
    fn locate_node_finds_nvm_install_with_empty_path_and_returns_absolute() {
        let home = fake_home();
        let newest = home.path().join(".nvm/versions/node/v22.1.0/bin/node");
        let probe = FakeProbe::new().with(newest.to_str().unwrap(), ok("v22.1.0\n", ""));
        let info = locate_node(&probe, &search_in(home.path()), 18).unwrap();
        assert_eq!(info.program, newest);
        assert!(info.program.is_absolute());
        assert_eq!(info.major, 22);
        // Nothing bare was ever probed.
        assert!(probe.calls.borrow().iter().all(|(p, _)| p.is_absolute()));
    }

    #[test]
    fn locate_node_prefers_override_then_path_then_known_dirs() {
        let home = fake_home();
        let mut search = search_in(home.path());
        search.path_env = Some(std::env::join_paths(["/usr/bin", "relative/bin"]).unwrap());
        let brew = FakeProbe::new().with("/opt/homebrew/bin/node", ok("v20.0.0\n", ""));
        assert_eq!(
            locate_node(&brew, &search, 18).unwrap().program,
            PathBuf::from("/opt/homebrew/bin/node")
        );
        let both = FakeProbe::new()
            .with("/opt/homebrew/bin/node", ok("v20.0.0\n", ""))
            .with("/usr/bin/node", ok("v19.0.0\n", ""));
        assert_eq!(
            locate_node(&both, &search, 18).unwrap().program,
            PathBuf::from("/usr/bin/node")
        );
        search.override_program = Some(PathBuf::from("/custom/node"));
        let all = both.with("/custom/node", ok("v21.0.0\n", ""));
        assert_eq!(
            locate_node(&all, &search, 18).unwrap().program,
            PathBuf::from("/custom/node")
        );
        // Relative PATH entries are never probed.
        assert!(all.calls.borrow().iter().all(|(p, _)| p.is_absolute()));
    }

    #[test]
    fn locate_node_skips_too_old_and_reports_it_when_nothing_else_works() {
        let home = fake_home();
        let old = home.path().join(".nvm/versions/node/v22.1.0/bin/node");
        let probe = FakeProbe::new().with(old.to_str().unwrap(), ok("v16.0.0\n", ""));
        let err = locate_node(&probe, &search_in(home.path()), 18).unwrap_err();
        assert!(
            matches!(err, RuntimeError::TooOld { required: 18, .. }),
            "{err:?}"
        );

        let err = locate_node(&FakeProbe::new(), &search_in(home.path()), 18).unwrap_err();
        assert!(matches!(err, RuntimeError::Missing { .. }), "{err:?}");

        let empty = NodeSearch::default();
        let err = locate_node(&FakeProbe::new(), &empty, 18).unwrap_err();
        assert!(matches!(err, RuntimeError::Missing { .. }), "{err:?}");
    }

    #[test]
    fn locate_node_runs_the_real_node_found_by_the_probe() {
        let search = NodeSearch::from_env();
        if search.candidates().iter().all(|p| !p.is_file()) {
            eprintln!("skipped: no node binary at any probed location on this host");
            return;
        }
        let info = locate_node(&SystemProbe, &search, 1).unwrap();
        assert!(info.program.is_absolute(), "{:?}", info.program);
        assert!(info.major >= 1 && !info.version.is_empty());
        let out = Command::new(&info.program)
            .arg("--version")
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains(&info.version));
    }

    #[test]
    fn system_probe_reports_not_found_for_missing_binary() {
        let err = SystemProbe
            .run(
                Path::new("definitely-not-a-real-binary-xyz"),
                &["--version"],
            )
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }
}
