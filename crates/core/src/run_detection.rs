//! Read-only discovery of common project run and check tasks.
use crate::{io_error, CoreError, DetectedRunTask, Result, RunConfiguration};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{ErrorKind, Read},
    path::Path,
};

const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

/// Detect common project tasks without executing tools, scripts, or installers.
/// Only root-level manifests are inspected, and their resolved paths must stay
/// inside `root`.
pub(crate) fn detect_tasks(root: &Path) -> Result<Vec<DetectedRunTask>> {
    let root = root
        .canonicalize()
        .map_err(|error| io_error("Resolve run configuration root", root, error))?;
    if !root.is_dir() {
        return Err(CoreError::InvalidEdit(format!(
            "Run configuration root is not a directory: {}",
            root.display()
        )));
    }

    let mut tasks = Vec::new();
    if let Some(text) = read_manifest(&root, "package.json")? {
        detect_package_scripts(&text, &mut tasks)?;
    }
    if read_manifest(&root, "Cargo.toml")?.is_some() {
        for (id, name, arg) in [
            ("cargo-check", "Cargo check", "check"),
            ("cargo-test", "Cargo test", "test"),
            ("cargo-build", "Cargo build", "build"),
            ("cargo-run", "Cargo run", "run"),
        ] {
            push_task(
                &mut tasks,
                "cargo",
                id,
                name,
                "cargo",
                vec![arg.to_owned()],
                "Cargo.toml",
            );
        }
    }

    for manifest in ["pyproject.toml", "setup.py"] {
        if read_manifest(&root, manifest)?.is_some() {
            push_python_tasks(&mut tasks, manifest);
        }
    }
    if read_manifest(&root, "pom.xml")?.is_some() {
        push_task(
            &mut tasks,
            "maven",
            "maven-test",
            "Maven test",
            "mvn",
            vec!["test".into()],
            "pom.xml",
        );
        push_task(
            &mut tasks,
            "maven",
            "maven-package",
            "Maven package",
            "mvn",
            vec!["package".into()],
            "pom.xml",
        );
    }
    for manifest in ["build.gradle", "build.gradle.kts"] {
        if read_manifest(&root, manifest)?.is_some() {
            push_task(
                &mut tasks,
                "gradle",
                "gradle-test",
                "Gradle test",
                "gradle",
                vec!["test".into()],
                manifest,
            );
            push_task(
                &mut tasks,
                "gradle",
                "gradle-build",
                "Gradle build",
                "gradle",
                vec!["build".into()],
                manifest,
            );
        }
    }
    if let Some(text) = read_manifest(&root, "Makefile")? {
        detect_make_targets(&text, &mut tasks);
    }

    tasks.sort_by(|left, right| left.configuration.id.cmp(&right.configuration.id));
    tasks.dedup_by(|left, right| left.configuration.id == right.configuration.id);
    Ok(tasks)
}

pub(crate) fn read_manifest(root: &Path, name: &str) -> Result<Option<String>> {
    let candidate = root.join(name);
    match fs::symlink_metadata(&candidate) {
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error("Inspect run manifest", &candidate, error)),
    }

    let resolved = candidate
        .canonicalize()
        .map_err(|error| io_error("Resolve run manifest", &candidate, error))?;
    if !resolved.starts_with(root) {
        return Err(CoreError::OutsideWorkspace(candidate.display().to_string()));
    }
    let metadata = fs::metadata(&resolved)
        .map_err(|error| io_error("Inspect run manifest", &resolved, error))?;
    if !metadata.is_file() {
        return Ok(None);
    }
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err(CoreError::InvalidEdit(format!(
            "Run manifest exceeds 1 MiB: {name}"
        )));
    }

    let file =
        File::open(&resolved).map_err(|error| io_error("Read run manifest", &resolved, error))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error("Read run manifest", &resolved, error))?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(CoreError::InvalidEdit(format!(
            "Run manifest exceeds 1 MiB: {name}"
        )));
    }
    String::from_utf8(bytes).map(Some).map_err(|error| {
        CoreError::InvalidEdit(format!("Run manifest is not UTF-8 ({name}): {error}"))
    })
}

fn detect_package_scripts(text: &str, tasks: &mut Vec<DetectedRunTask>) -> Result<()> {
    let package: Value = serde_json::from_str(text)
        .map_err(|error| CoreError::InvalidEdit(format!("Invalid package.json: {error}")))?;
    let Some(object) = package.as_object() else {
        return Err(CoreError::InvalidEdit(
            "Invalid package.json: expected a JSON object".into(),
        ));
    };
    let Some(scripts) = object.get("scripts") else {
        return Ok(());
    };
    let Some(scripts) = scripts.as_object() else {
        return Err(CoreError::InvalidEdit(
            "Invalid package.json: scripts must be an object".into(),
        ));
    };
    for (name, script) in scripts {
        if !script.is_string() {
            return Err(CoreError::InvalidEdit(format!(
                "Invalid package.json: script {name:?} must be a string"
            )));
        }
        if !valid_task_name(name) || name.len() > 239 || name.chars().count() > 155 {
            continue;
        }
        push_task(
            tasks,
            "package",
            name,
            &format!("npm: {name}"),
            "npm",
            vec!["run".into(), name.clone()],
            "package.json scripts",
        );
    }
    Ok(())
}

fn push_python_tasks(tasks: &mut Vec<DetectedRunTask>, manifest: &str) {
    push_task(
        tasks,
        "python",
        "python-compileall",
        "Python compileall",
        "python",
        vec!["-m".into(), "compileall".into(), ".".into()],
        manifest,
    );
    push_task(
        tasks,
        "python",
        "python-unittest",
        "Python unittest discovery",
        "python",
        vec!["-m".into(), "unittest".into(), "discover".into()],
        manifest,
    );
}

fn detect_make_targets(text: &str, tasks: &mut Vec<DetectedRunTask>) {
    let mut names = BTreeSet::new();
    for line in text.lines() {
        if line.chars().next().is_some_and(char::is_whitespace)
            || line.trim_start().starts_with('#')
        {
            continue;
        }
        let Some((target, _)) = line.split_once(':') else {
            continue;
        };
        let target = target.trim();
        if target.is_empty()
            || target.starts_with('.')
            || !valid_task_name(target)
            || target.len() > 230
            || !target
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
            || target.chars().any(char::is_whitespace)
        {
            continue;
        }
        names.insert(target.to_owned());
    }
    for name in names {
        push_task(
            tasks,
            "make",
            &name,
            &format!("make {name}"),
            "make",
            vec![name.clone()],
            "Makefile",
        );
    }
}

fn valid_task_name(name: &str) -> bool {
    !name.is_empty() && !name.contains(['\0', '\r', '\n'])
}

fn push_task(
    tasks: &mut Vec<DetectedRunTask>,
    source_id: &str,
    task_id: &str,
    name: &str,
    executable: &str,
    args: Vec<String>,
    source: &str,
) {
    let id = format!("detected:{source_id}:{task_id}");
    tasks.push(DetectedRunTask {
        configuration: RunConfiguration {
            id,
            name: name.to_owned(),
            executable: executable.to_owned(),
            args,
            cwd: ".".into(),
            env: BTreeMap::new(),
        },
        source: source.to_owned(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn detects_common_tasks_with_stable_ids_and_separate_arguments() {
        let root = TempDir::new().unwrap();
        fs::write(
            root.path().join("package.json"),
            r#"{"scripts":{"test":"touch should-not-exist","lint":"eslint ."}}"#,
        )
        .unwrap();
        fs::write(root.path().join("Cargo.toml"), "[package]\nname='x'\n").unwrap();
        fs::write(root.path().join("pyproject.toml"), "[project]\nname='x'\n").unwrap();
        fs::write(root.path().join("pom.xml"), "<project />").unwrap();
        fs::write(root.path().join("build.gradle.kts"), "plugins {}\n").unwrap();
        fs::write(
            root.path().join("Makefile"),
            "test: deps\n\t@echo test\nrelease-candidate: test\n.PHONY: test\n$(DYNAMIC):\nunsafe;touch: all\n",
        )
        .unwrap();

        let first = detect_tasks(root.path()).unwrap();
        let second = detect_tasks(root.path()).unwrap();
        let ids = first
            .iter()
            .map(|task| task.configuration.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            second
                .iter()
                .map(|task| task.configuration.id.as_str())
                .collect::<Vec<_>>()
        );
        let npm = first
            .iter()
            .find(|task| task.configuration.id == "detected:package:test")
            .unwrap();
        assert_eq!(npm.configuration.executable, "npm");
        assert_eq!(
            npm.configuration.args,
            vec!["run".to_owned(), "test".to_owned()]
        );
        assert_eq!(npm.configuration.cwd, ".");
        assert!(first
            .iter()
            .any(|task| task.configuration.id == "detected:cargo:cargo-check"));
        assert!(first
            .iter()
            .any(|task| task.configuration.id == "detected:python:python-compileall"));
        assert!(first
            .iter()
            .any(|task| task.configuration.id == "detected:maven:maven-test"));
        assert!(first
            .iter()
            .any(|task| task.configuration.id == "detected:gradle:gradle-build"));
        assert!(first
            .iter()
            .any(|task| task.configuration.id == "detected:make:release-candidate"));
        assert!(!first
            .iter()
            .any(|task| task.configuration.id.contains("unsafe")));
        assert_eq!(
            fs::read_to_string(root.path().join("package.json")).unwrap(),
            r#"{"scripts":{"test":"touch should-not-exist","lint":"eslint ."}}"#
        );
        assert!(!root.path().join("should-not-exist").exists());
    }

    #[test]
    fn absent_manifest_returns_no_tasks() {
        let root = TempDir::new().unwrap();
        assert!(detect_tasks(root.path()).unwrap().is_empty());
    }

    #[test]
    fn malformed_package_json_has_context() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("package.json"), "{").unwrap();
        let error = detect_tasks(root.path()).unwrap_err().to_string();
        assert!(error.contains("package.json"));
    }

    #[test]
    fn oversized_manifest_is_rejected() {
        let root = TempDir::new().unwrap();
        fs::write(
            root.path().join("package.json"),
            vec![b' '; MAX_MANIFEST_BYTES as usize + 1],
        )
        .unwrap();
        let error = detect_tasks(root.path()).unwrap_err().to_string();
        assert!(error.contains("1 MiB"));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_manifest_symlink_outside_root() {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(
            outside.path().join("package.json"),
            r#"{"scripts":{"steal":"touch should-not-read"}}"#,
        )
        .unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("package.json"),
            root.path().join("package.json"),
        )
        .unwrap();
        let error = detect_tasks(root.path()).unwrap_err();
        assert!(matches!(error, CoreError::OutsideWorkspace(_)));
    }
}
