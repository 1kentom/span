//! Java safety checks for the shared current-file runner.
use crate::{CoreError, CoreWorkspace, Result, RunConfiguration, CURRENT_FILE_RUN_ID};

impl CoreWorkspace {
    /// Inspect a source file without starting Java. Dirty buffers are allowed
    /// during discovery so the UI can offer its explicit Save and Run action.
    pub(crate) fn java_source(&self, path: &str, require_saved: bool) -> Result<String> {
        let reject = |message: &str| CoreError::RunConfiguration(message.into());
        if crate::resolve_program("java").is_none() || crate::resolve_program("javac").is_none() {
            return Err(reject(
                "A Java development kit is required. Install JDK 11 or newer and refresh Tools.",
            ));
        }
        let resolved = self.resolve(path)?;
        let relative = self.relative(&resolved)?;
        let disk = crate::run_detection::read_manifest(&self.root, &relative)?
            .ok_or_else(|| reject("Java source no longer exists. Save it before running."))?;
        let source = if let Some(buffer) = self.buffers.get(&relative) {
            if buffer.rope.len_bytes() > 1024 * 1024 {
                return Err(reject("Java file mode supports source files up to 1 MiB."));
            }
            if require_saved && buffer.revision != buffer.saved_revision {
                return Err(reject(
                    "Save this Java source before running it. Unsaved edits were preserved.",
                ));
            }
            if require_saved && buffer.rope != disk.as_str() {
                return Err(reject(
                    "Java source changed on disk. Reload or compare it before running.",
                ));
            }
            buffer.rope.to_string()
        } else {
            disk
        };
        if span_syntax::java_main(&source).is_none() {
            return Err(reject("Java file mode requires a valid conventional main method in the first top-level class. Review a project run configuration for other launch targets."));
        }
        Ok(source)
    }

    /// This runs on initial start and restart through the same preparation
    /// path. Saved custom project commands retain their explicit semantics.
    pub(crate) fn validate_java_run(&self, configuration: &RunConfiguration) -> Result<()> {
        if configuration.id != CURRENT_FILE_RUN_ID || configuration.executable != "java" {
            return Ok(());
        }
        let reject = |message: &str| CoreError::RunConfiguration(message.into());
        let path = configuration
            .args
            .first()
            .ok_or_else(|| reject("Java source path is missing."))?;
        if crate::current_file_run(path).configuration.as_ref() != Some(configuration) {
            return Err(reject(
                "The current-file Java command changed. Refresh its run target.",
            ));
        }
        self.java_source(path, true)?;
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
    fn java_current_file_launch_and_restart_reject_dirty_or_changed_source() {
        if crate::resolve_program("java").is_none() || crate::resolve_program("javac").is_none() {
            return;
        }
        let (directory, mut workspace) = fixture();
        let configuration = workspace
            .current_file_run("Test.java")
            .unwrap()
            .configuration
            .unwrap();
        assert_eq!(configuration.args, ["./Test.java"]);
        assert!(workspace.prepare_run(configuration.clone()).is_ok());
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
            .prepare_run(configuration.clone())
            .err()
            .unwrap()
            .to_string()
            .contains("Save"));
        workspace.discard_buffer("Test.java").unwrap();
        std::fs::write(directory.path().join("Test.java"), "class Other {}").unwrap();
        assert!(workspace
            .prepare_run(configuration)
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
        let configuration = workspace
            .current_file_run(path)
            .unwrap()
            .configuration
            .unwrap();
        let prepared = workspace.prepare_run(configuration).unwrap();
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
    #[test]
    fn java_argument_file_names_are_literal_sources_and_tampered_configs_are_rejected() {
        if crate::resolve_program("java").is_none() || crate::resolve_program("javac").is_none() {
            return;
        }
        let (directory, mut workspace) = fixture();
        std::fs::write(directory.path().join("@Test.java"), SOURCE).unwrap();
        workspace.open_buffer("@Test.java").unwrap();
        let configuration = workspace
            .current_file_run("@Test.java")
            .unwrap()
            .configuration
            .unwrap();
        assert_eq!(configuration.args, ["./@Test.java"]);
        let mut tampered = configuration.clone();
        tampered.args[0] = "@Test.java".into();
        assert!(workspace.prepare_run(tampered).is_err());
        let prepared = workspace.prepare_run(configuration).unwrap();
        let output = std::process::Command::new(prepared.executable)
            .args(prepared.args)
            .current_dir(prepared.cwd)
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
        assert!(workspace
            .run_configurations()
            .unwrap()
            .detected
            .iter()
            .all(|task| !task.configuration.id.starts_with("detected:java-main:")));
    }
}
