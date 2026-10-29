//! Explicit single-file Java launch discovery. No project build or classpath is inferred.
use crate::{CoreError, CoreWorkspace, DetectedRunTask, Result, RunConfiguration};
use std::{
    collections::BTreeMap,
    hash::{Hash, Hasher},
};

const PREFIX: &str = "detected:java-main:";

impl CoreWorkspace {
    pub(crate) fn java_run_tasks(&self) -> Vec<DetectedRunTask> {
        let Some(java) = crate::resolve_program("java") else {
            return vec![];
        };
        if crate::resolve_program("javac").is_none() {
            return vec![];
        }
        let mut tasks = Vec::new();
        for (path, buffer) in &self.buffers {
            if !path.ends_with(".java")
                || path.contains("${")
                || buffer.rope.len_bytes() > 1024 * 1024
            {
                continue;
            }
            let source = buffer.rope.to_string();
            let Some((class, _)) = span_syntax::java_main(&source) else {
                continue;
            };
            let name = format!("Java file: {class}.main()");
            if name.chars().count() > 160 {
                continue;
            }
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            path.hash(&mut hash);
            tasks.push(DetectedRunTask {
                source: path.clone(),
                configuration: RunConfiguration {
                    id: format!("{PREFIX}{:016x}", hash.finish()),
                    name,
                    executable: java.to_string_lossy().into_owned(),
                    args: vec![format!("./{path}")],
                    cwd: ".".into(),
                    env: BTreeMap::new(),
                },
            });
        }
        tasks.sort_by(|a, b| a.source.cmp(&b.source));
        tasks
    }

    pub(crate) fn validate_java_run(&self, configuration: &RunConfiguration) -> Result<()> {
        if !configuration.id.starts_with(PREFIX) {
            return Ok(());
        }
        let reject = |message: &str| CoreError::RunConfiguration(message.into());
        let task = self.java_run_tasks().into_iter().find(|task| &task.configuration == configuration)
            .ok_or_else(|| reject("Java entry point or runtime changed. Refresh Run configurations. This action supports conventional main methods in the first top-level class only."))?;
        let buffer = self
            .buffers
            .get(&task.source)
            .ok_or_else(|| reject("Open this Java source before running it."))?;
        if buffer.revision != buffer.saved_revision {
            return Err(reject(
                "Save this Java source before running it. Unsaved edits were preserved.",
            ));
        }
        let disk = crate::run_detection::read_manifest(&self.root, &task.source)?
            .ok_or_else(|| reject("Java source no longer exists. Save it before running."))?;
        if buffer.rope != disk.as_str() {
            return Err(reject(
                "Java source changed on disk. Reload or compare it before running.",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::{CoreWorkspace, TextEdit};
    const SOURCE: &str = "class Test { public static void main(String[] args) { System.out.println(\"Hello World\"); } }";
    fn fixture() -> (tempfile::TempDir, CoreWorkspace) {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("Test.java"), SOURCE).unwrap();
        let mut workspace = CoreWorkspace::open(directory.path()).unwrap();
        workspace.open_buffer("Test.java").unwrap();
        (directory, workspace)
    }
    #[test]
    fn java_discovery_does_not_execute_and_launch_rejects_dirty_or_changed_source() {
        if crate::resolve_program("java").is_none() || crate::resolve_program("javac").is_none() {
            return;
        }
        let (directory, mut workspace) = fixture();
        let task = workspace.java_run_tasks().remove(0);
        assert_eq!(task.configuration.args, ["./Test.java"]);
        assert!(workspace.prepare_run(task.configuration.clone()).is_ok());
        let revision = workspace.buffer_snapshot("Test.java").unwrap().revision;
        workspace
            .edit_buffer(
                "Test.java",
                revision,
                vec![TextEdit {
                    from: 0,
                    to: 0,
                    insert: "// unsaved\n".into(),
                }],
            )
            .unwrap();
        assert!(workspace
            .prepare_run(task.configuration.clone())
            .err()
            .unwrap()
            .to_string()
            .contains("Save"));
        workspace.discard_buffer("Test.java").unwrap();
        std::fs::write(directory.path().join("Test.java"), "class Other {}").unwrap();
        assert!(workspace
            .prepare_run(task.configuration)
            .err()
            .unwrap()
            .to_string()
            .contains("changed on disk"));
    }
    #[test]
    fn real_jdk_launches_scratch_file_inside_maven_tree_without_assuming_a_classpath() {
        if crate::resolve_program("java").is_none() || crate::resolve_program("javac").is_none() {
            return;
        }
        let (directory, mut workspace) = fixture();
        let path = "src/main/java/com/kentom/todo/new-file.java";
        std::fs::create_dir_all(directory.path().join("src/main/java/com/kentom/todo")).unwrap();
        std::fs::write(directory.path().join(path), SOURCE).unwrap();
        std::fs::write(directory.path().join("pom.xml"), "<project />").unwrap();
        workspace.open_buffer(path).unwrap();
        let task = workspace
            .java_run_tasks()
            .into_iter()
            .find(|task| task.source == path)
            .unwrap();
        let prepared = workspace.prepare_run(task.configuration).unwrap();
        let output = std::process::Command::new(prepared.executable)
            .args(prepared.args)
            .current_dir(prepared.cwd)
            .envs(prepared.env)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "Hello World"
        );
        assert!(!directory.path().join("target").exists());
        assert!(!directory
            .path()
            .join("src/main/java/com/kentom/todo/Test.class")
            .exists());
    }
}
