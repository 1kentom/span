//! Per-session startup wrappers preserve user configuration without dotfile edits.
use crate::{operation, TerminalError};
use portable_pty::CommandBuilder;
use std::{ffi::OsString, os::unix::fs::PermissionsExt, path::Path};
use tempfile::TempDir;

const ZSH_PROMPT: &str = include_str!("shell/zsh-prompt.zsh");
const BASH_PROMPT: &str = include_str!("shell/bash-prompt.bash");

pub(crate) fn configure(
    command: &mut CommandBuilder,
    shell: &Path,
) -> Result<Option<TempDir>, TerminalError> {
    match shell.file_stem().and_then(|name| name.to_str()) {
        Some("zsh") => {
            let directory = zsh_directory()?;
            zsh_environment(command, directory.path(), std::env::var_os("ZDOTDIR"));
            command.arg("-i");
            Ok(Some(directory))
        }
        Some("bash") => {
            let directory = private_directory()?;
            let rcfile = directory.path().join("bashrc");
            std::fs::write(&rcfile, BASH_PROMPT).map_err(operation)?;
            command.args([
                OsString::from("--rcfile"),
                rcfile.into_os_string(),
                OsString::from("-i"),
            ]);
            Ok(Some(directory))
        }
        _ => {
            command.arg("-i");
            Ok(None)
        }
    }
}

fn zsh_environment(command: &mut CommandBuilder, directory: &Path, original: Option<OsString>) {
    // A cached theme preview can paint a multiline header before the user's rc
    // finishes and before Span can install its compact prompt. Opt out of that
    // preview for this child process, while still loading the full user config.
    command.env("POWERLEVEL9K_INSTANT_PROMPT", "off");
    command.env("SPAN_INTEGRATION_DIR", directory);
    command.env(
        "_SPAN_ORIGINAL_ZDOTDIR_SET",
        if original.is_some() { "1" } else { "0" },
    );
    command.env(
        "_SPAN_ORIGINAL_ZDOTDIR_EXPORTED",
        if original.is_some() { "1" } else { "0" },
    );
    command.env("_SPAN_ORIGINAL_ZDOTDIR", original.unwrap_or_default());
    command.env("ZDOTDIR", directory);
}

fn private_directory() -> Result<TempDir, TerminalError> {
    tempfile::Builder::new()
        .prefix("span-shell-")
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .map_err(operation)
}

fn zsh_directory() -> Result<TempDir, TerminalError> {
    // tempfile creates an unpredictable owner-only directory, and its lifetime
    // is retained by the PTY resources until that session closes.
    let directory = private_directory()?;
    std::fs::write(directory.path().join("prompt.zsh"), ZSH_PROMPT).map_err(operation)?;
    for file in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
        let source = format!(
            r#"# Restore the user's startup-file lookup context before loading their file.
if [[ ${{_SPAN_ORIGINAL_ZDOTDIR_SET:-0}} == 1 ]]; then
  ZDOTDIR=$_SPAN_ORIGINAL_ZDOTDIR
  if [[ ${{_SPAN_ORIGINAL_ZDOTDIR_EXPORTED:-0}} == 1 ]]; then
    export ZDOTDIR
  else
    typeset +x ZDOTDIR
  fi
else
  unset ZDOTDIR
fi
# macOS /etc/zshrc derives its default history path before the rc wrapper.
if [[ ${{HISTFILE-}} == "$SPAN_INTEGRATION_DIR/.zsh_history" ]]; then
  HISTFILE="${{ZDOTDIR:-$HOME}}/.zsh_history"
fi
if [[ -f "${{ZDOTDIR-$HOME}}/{file}" ]]; then
  builtin source "${{ZDOTDIR-$HOME}}/{file}"
fi
# .zshenv and later startup files may deliberately change ZDOTDIR.
_SPAN_ORIGINAL_ZDOTDIR_SET=${{+ZDOTDIR}}
_SPAN_ORIGINAL_ZDOTDIR=${{ZDOTDIR-}}
if [[ ${{parameters[ZDOTDIR]-}} == *export* ]]; then
  _SPAN_ORIGINAL_ZDOTDIR_EXPORTED=1
else
  _SPAN_ORIGINAL_ZDOTDIR_EXPORTED=0
fi
"#
        );
        let tail = match file {
            ".zshenv" | ".zprofile" => {
                r#"if [[ -o rcs ]]; then
  export ZDOTDIR=$SPAN_INTEGRATION_DIR
else
  builtin source "$SPAN_INTEGRATION_DIR/prompt.zsh"
fi
"#
            }
            ".zshrc" => {
                r#"if [[ -o login && -o rcs ]]; then
  export ZDOTDIR=$SPAN_INTEGRATION_DIR
else
  builtin source "$SPAN_INTEGRATION_DIR/prompt.zsh"
fi
"#
            }
            _ => "builtin source \"$SPAN_INTEGRATION_DIR/prompt.zsh\"\n",
        };
        std::fs::write(directory.path().join(file), source + tail).map_err(operation)?;
    }
    Ok(directory)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        process::{Command, Stdio},
    };

    fn run_shell(mut command: Command, input: &str) -> String {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "Shell failed: {:?}", output);
        String::from_utf8(output.stdout).unwrap() + &String::from_utf8(output.stderr).unwrap()
    }

    fn zsh_first_screen(home: &Path, workspace: &Path) -> String {
        let shell = Path::new("/bin/zsh");
        let mut command = CommandBuilder::new(shell);
        let integration = configure(&mut command, shell).unwrap().unwrap();
        zsh_environment(
            &mut command,
            integration.path(),
            Some(home.as_os_str().to_owned()),
        );
        command.cwd(workspace);
        command.env("HOME", home);
        command.env("TERM", "xterm-256color");
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize {
                rows: 24,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let (output, receiver) = std::sync::mpsc::channel();
        let reading = std::thread::spawn(move || {
            use std::io::Read;
            let mut bytes = [0; 8192];
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0 || output.send(bytes[..count].to_vec()).is_err() {
                    break;
                }
            }
        });
        let mut parser = vt100::Parser::new(
            std::num::NonZeroU16::new(24).unwrap(),
            std::num::NonZeroU16::new(100).unwrap(),
            0,
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut ready = false;
        while let Ok(bytes) =
            receiver.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
        {
            parser.process(&bytes);
            if parser.screen().contents().contains("git:(span-visible)") {
                ready = true;
                break;
            }
        }
        while let Ok(bytes) = receiver.recv_timeout(std::time::Duration::from_millis(100)) {
            parser.process(&bytes);
        }
        let screen = parser.screen().contents();
        let _ = child.kill();
        let _ = child.wait();
        drop(pair.master);
        reading.join().unwrap();
        assert!(ready, "zsh did not produce its compact prompt: {screen:?}");
        screen
    }

    #[test]
    fn zsh_cached_startup_preview_does_not_leave_a_visible_parent_path_or_clock() {
        if !Path::new("/bin/zsh").is_file() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let workspace = home
            .path()
            .join("parent-path-should-not-appear")
            .join("span-folder");
        std::fs::create_dir_all(&workspace).unwrap();
        assert!(Command::new("git")
            .args(["init", "-q", "--initial-branch", "span-visible"])
            .arg(&workspace)
            .status()
            .unwrap()
            .success());
        std::fs::write(
            home.path().join("cached-prompt.zsh"),
            r#"# Mirrors Powerlevel10k's documented cached-preview opt-out.
if [[ ${POWERLEVEL9K_INSTANT_PROMPT-} != off ]]; then
  printf '%s -------- 09:42:01\n' "$PWD"
fi
"#,
        )
        .unwrap();
        let rc = "builtin source \"$HOME/cached-prompt.zsh\"\nexport SPAN_SETTING=preserved\nalias span_alias='print alias-preserved'\nspan_completion() { compadd kept; }\nPOWERLEVEL9K_INSTANT_PROMPT=quiet\n";
        std::fs::write(home.path().join(".zshrc"), rc).unwrap();
        let screen = zsh_first_screen(home.path(), &workspace);
        let lines = screen
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>();
        assert_eq!(
            lines,
            ["→ span-folder git:(span-visible)"],
            "A cached startup prefix survived on the rendered screen: {screen:?}"
        );
        assert_eq!(
            std::fs::read_to_string(home.path().join(".zshrc")).unwrap(),
            rc
        );
    }

    #[test]
    fn zsh_preserves_custom_startup_completion_hooks_options_and_child_zdotdir() {
        if !Path::new("/bin/zsh").is_file() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let original = home.path().join("original config");
        let redirected = home.path().join("redirected config");
        std::fs::create_dir_all(&original).unwrap();
        std::fs::create_dir_all(&redirected).unwrap();
        std::fs::write(
            original.join(".zshenv"),
            "export SPAN_ENV_MARKER=env-loaded\nZDOTDIR=\"$HOME/redirected config\"\n",
        )
        .unwrap();
        std::fs::write(
            redirected.join(".zshrc"),
            r#"export SPAN_RC_MARKER=rc-loaded
POWERLEVEL9K_INSTANT_PROMPT=quiet
export SPAN_HISTORY_MARKER=$HISTFILE
autoload -Uz compinit
compinit -D
compdef _files span_fixture
alias span_alias='print ALIAS_PRESERVED'
span_fixture() { print FUNCTION_PRESERVED; }
span_user_precmd() { SPAN_USER_HOOK=hook-ran; }
precmd_functions+=(span_user_precmd)
setopt promptsubst promptbang
RPROMPT='clock-full-path'
"#,
        )
        .unwrap();
        let integration = zsh_directory().unwrap();
        let mut shell = Command::new("/bin/zsh");
        shell
            .arg("-i")
            .current_dir(home.path())
            .env("HOME", home.path())
            .env("POWERLEVEL9K_INSTANT_PROMPT", "off")
            .env("ZDOTDIR", integration.path())
            .env("SPAN_INTEGRATION_DIR", integration.path())
            .env("_SPAN_ORIGINAL_ZDOTDIR_SET", "1")
            .env("_SPAN_ORIGINAL_ZDOTDIR", &original)
            .env("_SPAN_ORIGINAL_ZDOTDIR_EXPORTED", "1");
        let output = run_shell(shell, "span_alias\nspan_fixture\nprintf 'SETTINGS:%s:%s:%s:%s:%s:%s\\n' \"$SPAN_ENV_MARKER\" \"$SPAN_RC_MARKER\" \"$SPAN_USER_HOOK\" \"${_comps[span_fixture]}\" \"$options[promptbang]\" \"$POWERLEVEL9K_INSTANT_PROMPT\"\n/bin/zsh -c 'printf \"CHILD:%s\\n\" \"$ZDOTDIR\"'\nexit\n");
        for marker in [
            "ALIAS_PRESERVED",
            "FUNCTION_PRESERVED",
            "SETTINGS:env-loaded:rc-loaded:hook-ran:_files:on:quiet",
        ] {
            assert!(output.contains(marker), "Missing {marker}: {output}");
        }
        assert!(
            output.contains(&format!("CHILD:{}", redirected.display())),
            "{output}"
        );
        assert!(!output.contains("clock-full-path"));
        assert_eq!(
            std::fs::read_to_string(original.join(".zshenv")).unwrap(),
            "export SPAN_ENV_MARKER=env-loaded\nZDOTDIR=\"$HOME/redirected config\"\n"
        );
    }

    #[test]
    fn compact_prompts_do_not_execute_hostile_directory_or_branch_names() {
        let home = tempfile::tempdir().unwrap();
        let directory_name = "$(touch SPAN_CWD_INJECTED)%n`touch SPAN_TICK_INJECTED`!";
        let cwd = home.path().join(directory_name);
        std::fs::create_dir(&cwd).unwrap();
        let branch = "branch$(>SPAN_BRANCH_INJECTED)%n";
        assert!(Command::new("git")
            .args(["init", "-q", "--initial-branch", branch])
            .arg(&cwd)
            .status()
            .unwrap()
            .success());
        for zsh in [false, true] {
            let shell_path = if zsh { "/bin/zsh" } else { "/bin/bash" };
            if !Path::new(shell_path).is_file() {
                continue;
            }
            let integration = if zsh {
                zsh_directory().unwrap()
            } else {
                tempfile::tempdir().unwrap()
            };
            let mut shell = Command::new(shell_path);
            shell.current_dir(&cwd).env("HOME", home.path());
            if zsh {
                std::fs::write(
                    home.path().join(".zshrc"),
                    "setopt promptsubst promptbang\n",
                )
                .unwrap();
                shell
                    .arg("-i")
                    .env("ZDOTDIR", integration.path())
                    .env("SPAN_INTEGRATION_DIR", integration.path())
                    .env("_SPAN_ORIGINAL_ZDOTDIR_SET", "0")
                    .env("_SPAN_ORIGINAL_ZDOTDIR", "")
                    .env("_SPAN_ORIGINAL_ZDOTDIR_EXPORTED", "0");
            } else {
                let rcfile = integration.path().join("bashrc");
                std::fs::write(&rcfile, BASH_PROMPT).unwrap();
                shell
                    .arg("--noediting")
                    .arg("--rcfile")
                    .arg(rcfile)
                    .arg("-i");
            }
            let output = run_shell(shell, "printf 'PROMPT_TEST_READY\\n'\nexit\n");
            assert!(
                output.contains(directory_name),
                "Missing literal cwd for {shell_path}: {output}"
            );
            assert!(
                output.contains(&format!("git:({branch})")),
                "Missing literal branch for {shell_path}: {output}"
            );
            for filename in [
                "SPAN_CWD_INJECTED",
                "SPAN_TICK_INJECTED",
                "SPAN_BRANCH_INJECTED",
            ] {
                assert!(!cwd.join(filename).exists(), "Prompt executed {filename}");
            }
            assert!(
                !output.contains(&format!("→ {}", cwd.display())),
                "Prompt displayed full path"
            );
        }
    }

    #[test]
    fn zsh_shim_is_private_temporary_and_preserves_unexported_zdotdir() {
        use std::os::unix::fs::PermissionsExt;
        if !Path::new("/bin/zsh").is_file() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let original = home.path().join("original config");
        let redirected = home.path().join("redirected config");
        std::fs::create_dir_all(&original).unwrap();
        std::fs::create_dir_all(&redirected).unwrap();
        std::fs::write(
            original.join(".zshenv"),
            "typeset +x ZDOTDIR\nZDOTDIR=\"$HOME/redirected config\"\n",
        )
        .unwrap();
        let integration = zsh_directory().unwrap();
        let integration_path = integration.path().to_owned();
        assert_eq!(
            std::fs::metadata(&integration_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let mut shell = Command::new("/bin/zsh");
        shell
            .arg("-i")
            .env("HOME", home.path())
            .env("ZDOTDIR", &integration_path)
            .env("SPAN_INTEGRATION_DIR", &integration_path)
            .env("_SPAN_ORIGINAL_ZDOTDIR_SET", "1")
            .env("_SPAN_ORIGINAL_ZDOTDIR_EXPORTED", "1")
            .env("_SPAN_ORIGINAL_ZDOTDIR", &original);
        let output = run_shell(shell, "printf 'PARENT_ATTR:%s\\n' \"${parameters[ZDOTDIR]}\"\n/bin/zsh -c 'printf \"CHILD_UNSET:%s\\n\" \"${ZDOTDIR-unset}\"'\nexit\n");
        assert!(output.contains("PARENT_ATTR:scalar"), "{output}");
        assert!(!output.contains("PARENT_ATTR:scalar-export"), "{output}");
        assert!(output.contains("CHILD_UNSET:unset"), "{output}");
        drop(integration);
        assert!(!integration_path.exists());
    }

    #[test]
    fn bash_preserves_array_prompt_commands_and_disabled_promptvars() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join(".bashrc"), "span_first_hook() { SPAN_FIRST_HOOK=ran; }\nspan_second_hook() { SPAN_SECOND_HOOK=ran; }\nPROMPT_COMMAND=(span_first_hook span_second_hook)\nshopt -u promptvars\n").unwrap();
        let integration = private_directory().unwrap();
        let rcfile = integration.path().join("bashrc");
        std::fs::write(&rcfile, BASH_PROMPT).unwrap();
        let mut shell = Command::new("/bin/bash");
        shell
            .arg("--noediting")
            .arg("--rcfile")
            .arg(rcfile)
            .arg("-i")
            .env("HOME", home.path())
            .current_dir(home.path());
        let output = run_shell(shell, "printf 'ARRAY_HOOK:%s:%s\\n' \"$SPAN_FIRST_HOOK\" \"${PROMPT_COMMAND[1]}\"\nprintf 'PROMPTVARS:%s\\n' \"$(shopt -q promptvars; printf %s $?)\"\nexit\n");
        assert!(
            output.contains("ARRAY_HOOK:ran:span_second_hook"),
            "{output}"
        );
        assert!(output.contains("PROMPTVARS:1"), "{output}");
        assert!(output.contains('→'), "{output}");
        assert!(!output.contains("${_span_prompt_cwd}"), "{output}");
    }

    #[test]
    fn bash_sources_user_rc_and_preserves_prompt_command() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join(".bashrc"), "export SPAN_BASH_SETTING=kept\nspan_user_hook() { SPAN_HOOK_MARKER=ran; }\nPROMPT_COMMAND=span_user_hook\nalias span_alias='printf ALIAS_PRESERVED'\nspan_function() { printf FUNCTION_PRESERVED; }\n").unwrap();
        let integration = tempfile::tempdir().unwrap();
        let rcfile = integration.path().join("bashrc");
        std::fs::write(&rcfile, BASH_PROMPT).unwrap();
        let mut shell = Command::new("/bin/bash");
        shell
            .arg("--rcfile")
            .arg(rcfile)
            .arg("-i")
            .env("HOME", home.path())
            .current_dir(home.path());
        let output = run_shell(shell, "span_alias\nspan_function\nprintf 'BASH_SETTINGS:%s:%s\\n' \"$SPAN_BASH_SETTING\" \"$SPAN_HOOK_MARKER\"\nexit\n");
        for marker in [
            "ALIAS_PRESERVED",
            "FUNCTION_PRESERVED",
            "BASH_SETTINGS:kept:ran",
        ] {
            assert!(output.contains(marker), "{output}");
        }
    }
}
