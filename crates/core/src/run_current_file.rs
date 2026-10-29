//! Maps the active editor file to a single, non-interactive run command.
//!
//! The mapping is deliberately small and pure: a workspace relative path in,
//! either a run configuration or a short reason out. Nothing is executed here.
use crate::{CoreWorkspace, Result, RunConfiguration};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

/// Stable identifier for the synthesized current file configuration.
pub const CURRENT_FILE_RUN_ID: &str = "current-file";

/// The runner chosen for one file, or the reason no runner applies.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentFileRun {
    /// Workspace relative path with forward slashes.
    pub path: String,
    pub configuration: Option<RunConfiguration>,
    pub reason: Option<String>,
}

fn unavailable(path: &str, reason: impl Into<String>) -> CurrentFileRun {
    CurrentFileRun {
        path: path.to_owned(),
        configuration: None,
        reason: Some(reason.into()),
    }
}

fn runnable(path: &str, executable: &str, args: Vec<String>, cwd: &str) -> CurrentFileRun {
    let file_name = path.rsplit('/').next().unwrap_or(path);
    CurrentFileRun {
        path: path.to_owned(),
        configuration: Some(RunConfiguration {
            id: CURRENT_FILE_RUN_ID.to_owned(),
            name: format!("Run {file_name}"),
            executable: executable.to_owned(),
            args,
            cwd: cwd.to_owned(),
            env: BTreeMap::new(),
        }),
        reason: None,
    }
}

/// Rust files run through Cargo only when they are a binary or an example
/// target by Cargo's default layout. The crate directory becomes the cwd.
fn rust_run(path: &str) -> CurrentFileRun {
    let segments: Vec<&str> = path.split('/').collect();
    let crate_dir = |index: usize| {
        if index == 0 {
            ".".to_owned()
        } else {
            segments[..index].join("/")
        }
    };
    let stem = |name: &str| name.strip_suffix(".rs").unwrap_or(name).to_owned();
    for (index, segment) in segments.iter().enumerate() {
        let rest = &segments[index + 1..];
        let target = match (*segment, rest) {
            ("examples", [file]) => Some(("--example", stem(file))),
            ("examples", [name, "main.rs"]) => Some(("--example", (*name).to_owned())),
            ("src", ["main.rs"]) => Some(("", String::new())),
            ("src", ["bin", file]) => Some(("--bin", stem(file))),
            ("src", ["bin", name, "main.rs"]) => Some(("--bin", (*name).to_owned())),
            _ => None,
        };
        if let Some((flag, name)) = target {
            let mut args = vec!["run".to_owned()];
            if !flag.is_empty() {
                args.extend([flag.to_owned(), name]);
            }
            return runnable(path, "cargo", args, &crate_dir(index));
        }
    }
    unavailable(
        path,
        "Only Rust binaries and examples run directly: src/main.rs, src/bin, or examples.",
    )
}

/// Choose a runner for a workspace relative file path. Pure and side effect free.
pub fn current_file_run(path: &str) -> CurrentFileRun {
    let path = path.replace('\\', "/");
    let path = path.trim_start_matches("./");
    if path.is_empty() {
        return unavailable(path, "Open a file to run it.");
    }
    if path.contains("${") {
        return unavailable(
            path,
            "File paths with ${...} references cannot run directly.",
        );
    }
    let file_name = path.rsplit('/').next().unwrap_or(path);
    let extension = file_name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    // A leading dash would read as an option to the runner.
    let argument = if path.starts_with('-') {
        format!("./{path}")
    } else {
        path.to_owned()
    };
    let single = |executable: &str, prefix: &[&str]| {
        let mut args: Vec<String> = prefix.iter().map(|value| (*value).to_owned()).collect();
        args.push(argument.clone());
        runnable(path, executable, args, ".")
    };
    match extension.as_str() {
        "js" | "mjs" | "cjs" => single("node", &[]),
        "ts" | "mts" | "cts" => single("npx", &["--no-install", "tsx"]),
        "py" => single("python3", &[]),
        "sh" => single("sh", &[]),
        "bash" => single("bash", &[]),
        "zsh" => single("zsh", &[]),
        // Java also expands @argument-files before interpreting source paths.
        "java" => runnable(path, "java", vec![format!("./{path}")], "."),
        "rs" => rust_run(path),
        "" => unavailable(path, "No runner for files without an extension."),
        other => unavailable(path, format!("No runner for .{other} files.")),
    }
}

impl CoreWorkspace {
    /// Resolve an editor path inside this workspace and map it to a runner.
    /// Files that are not saved on disk report a reason instead of an error.
    pub fn current_file_run(&self, path: &str) -> Result<CurrentFileRun> {
        let resolved = self.resolve(path)?;
        let relative = resolved
            .strip_prefix(&self.root)
            .map_err(|_| crate::CoreError::OutsideWorkspace(path.to_owned()))?
            .components()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        if !resolved.is_file() {
            return Ok(unavailable(
                &relative,
                "Save the file to disk before running it.",
            ));
        }
        let plan = current_file_run(&relative);
        if plan
            .configuration
            .as_ref()
            .is_some_and(|configuration| configuration.executable == "java")
        {
            if let Err(error) = self.java_source(&relative, false) {
                return Ok(unavailable(&relative, error.to_string()));
            }
        }
        Ok(plan)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(path: &str) -> (String, Vec<String>, String) {
        let run = current_file_run(path);
        let configuration = run.configuration.expect("runnable");
        (
            configuration.executable,
            configuration.args,
            configuration.cwd,
        )
    }

    #[test]
    fn maps_script_languages_to_single_file_runners() {
        assert_eq!(
            command("scripts/build.mjs"),
            ("node".into(), vec!["scripts/build.mjs".into()], ".".into())
        );
        assert_eq!(
            command("src/tool.ts").1,
            vec!["--no-install", "tsx", "src/tool.ts"]
        );
        assert_eq!(command("main.py").0, "python3");
        assert_eq!(command("bin/setup.sh").0, "sh");
        assert_eq!(command("bin/setup.bash").0, "bash");
        assert_eq!(
            command("Hello.java"),
            ("java".into(), vec!["./Hello.java".into()], ".".into())
        );
        assert_eq!(
            current_file_run("a.py").configuration.unwrap().name,
            "Run a.py"
        );
        assert_eq!(
            current_file_run("a.py").configuration.unwrap().id,
            CURRENT_FILE_RUN_ID
        );
    }

    #[test]
    fn maps_rust_binaries_and_examples_to_cargo_targets() {
        assert_eq!(
            command("src/main.rs"),
            ("cargo".into(), vec!["run".into()], ".".into())
        );
        assert_eq!(
            command("examples/demo.rs").1,
            vec!["run", "--example", "demo"]
        );
        assert_eq!(
            command("examples/demo/main.rs").1,
            vec!["run", "--example", "demo"]
        );
        assert_eq!(command("src/bin/tool.rs").1, vec!["run", "--bin", "tool"]);
        assert_eq!(
            command("crates/app/src/bin/tool/main.rs"),
            (
                "cargo".into(),
                vec!["run".into(), "--bin".into(), "tool".into()],
                "crates/app".into()
            )
        );
        let library = current_file_run("src/lib.rs");
        assert!(library.configuration.is_none());
        assert!(library.reason.unwrap().contains("binaries and examples"));
    }

    #[test]
    fn workspace_resolves_editor_paths_and_refuses_outside_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("examples")).unwrap();
        std::fs::write(dir.path().join("examples/demo.rs"), "fn main() {}").unwrap();
        let workspace = CoreWorkspace::open(dir.path()).unwrap();
        let absolute = dir.path().canonicalize().unwrap().join("examples/demo.rs");
        let plan = workspace
            .current_file_run(&absolute.to_string_lossy())
            .unwrap();
        assert_eq!(plan.path, "examples/demo.rs");
        assert_eq!(
            plan.configuration.unwrap().args,
            vec!["run", "--example", "demo"]
        );
        let unsaved = workspace.current_file_run("new.py").unwrap();
        assert!(unsaved.configuration.is_none());
        assert!(unsaved.reason.unwrap().contains("Save the file"));
        assert!(workspace.current_file_run("../outside.py").is_err());
        let prepared = workspace
            .current_file_run("examples/demo.rs")
            .unwrap()
            .configuration
            .unwrap();
        assert_eq!(prepared.cwd, ".");
    }

    #[test]
    fn explains_unsupported_and_unsafe_paths() {
        assert_eq!(
            current_file_run("README.md").reason.as_deref(),
            Some("No runner for .md files.")
        );
        assert_eq!(
            current_file_run("Makefile").reason.as_deref(),
            Some("No runner for files without an extension.")
        );
        assert!(current_file_run("").reason.is_some());
        assert!(current_file_run("${env:HOME}.py").configuration.is_none());
        assert_eq!(command("-x.py").1, vec!["./-x.py"]);
        assert_eq!(command("@Test.java").1, vec!["./@Test.java"]);
        assert_eq!(command("dir\\tool.py").1, vec!["dir/tool.py"]);
    }
}
