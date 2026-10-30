//! How Span answers an agent's permission request in each thread mode
//! (ADR 0015). [`decide`] is a pure table: (mode, tool kind, where the paths
//! are, what class the command is) to allow, reject or prompt. The helpers
//! [`classify_paths`] and [`classify_command`] turn a request into those
//! facts. The ACP adapter applies the decision; nothing here is reachable
//! from an agent or a tool.
use crate::permission_mode::ThreadPermissionMode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::path::{Component, Path, PathBuf};

/// ACP `ToolKind`. Anything unknown is `Other`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    SwitchMode,
    Other,
}

impl ToolKind {
    pub fn parse(kind: Option<&str>) -> Self {
        match kind.unwrap_or("other") {
            "read" => Self::Read,
            "edit" => Self::Edit,
            "delete" => Self::Delete,
            "move" => Self::Move,
            "search" => Self::Search,
            "execute" => Self::Execute,
            "think" => Self::Think,
            "fetch" => Self::Fetch,
            "switch_mode" => Self::SwitchMode,
            _ => Self::Other,
        }
    }

    /// Kinds that only look: still allowed (prompted as before) in Plan.
    pub fn read_only(self) -> bool {
        matches!(self, Self::Read | Self::Search | Self::Fetch | Self::Think)
    }
}

/// Where the paths a request names are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathScope {
    /// At least one path, all inside the workspace (and not under `.git`).
    Inside,
    /// At least one path outside the workspace or under `.git`.
    Outside,
    /// The request names no path Span can check.
    Unknown,
}

/// What a command request runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandClass {
    /// Exactly matches the small safe allowlist.
    Safe,
    /// Anything else, including any shell syntax.
    Other,
    /// The request carries no command.
    None,
}

/// Why Span answered without asking. Sent to the UI and logged in the feed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PolicyReason {
    /// Plan mode: writes and commands are refused (reject once).
    PlanModeReadOnly,
    /// Accept edits (or Auto): an edit inside the workspace.
    AcceptEditsWorkspace,
    /// Auto: a command on the safe allowlist.
    AutoSafeCommand,
    /// Full access: allowed without asking, logged.
    FullAccess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyDecision {
    Allow(PolicyReason),
    Reject(PolicyReason),
    Prompt,
}

/// The facts [`decide`] needs about one request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestFacts {
    pub kind: ToolKind,
    pub paths: PathScope,
    pub command: CommandClass,
}

/// The policy table.
///
/// - Ask: everything prompts.
/// - Plan: edit, delete, move, execute, mode switches and unknown tools are
///   rejected once with `plan_mode_read_only`; read, search, fetch and think
///   prompt as in Ask.
/// - Accept edits: an edit whose paths are all inside the workspace is
///   allowed; everything else prompts (commands too).
/// - Auto: Accept edits, plus a command on the safe allowlist is allowed;
///   everything else prompts.
/// - Full: everything is allowed (and logged by the caller).
pub fn decide(mode: ThreadPermissionMode, facts: RequestFacts) -> PolicyDecision {
    use ThreadPermissionMode::*;
    let workspace_edit = facts.kind == ToolKind::Edit && facts.paths == PathScope::Inside;
    match mode {
        Ask => PolicyDecision::Prompt,
        Plan if facts.kind.read_only() => PolicyDecision::Prompt,
        Plan => PolicyDecision::Reject(PolicyReason::PlanModeReadOnly),
        AcceptEdits if workspace_edit => PolicyDecision::Allow(PolicyReason::AcceptEditsWorkspace),
        AcceptEdits => PolicyDecision::Prompt,
        Auto if workspace_edit => PolicyDecision::Allow(PolicyReason::AcceptEditsWorkspace),
        Auto if facts.kind == ToolKind::Execute && facts.command == CommandClass::Safe => {
            PolicyDecision::Allow(PolicyReason::AutoSafeCommand)
        }
        Auto => PolicyDecision::Prompt,
        Full => PolicyDecision::Allow(PolicyReason::FullAccess),
    }
}

/// Drops a Windows verbatim prefix so `\\?\C:\w` and `C:\w` compare equal.
fn plain(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path.to_path_buf(),
    }
}

/// Lexically normalised: `.` dropped, `..` pops (never above the root).
fn normalise(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    Some(out)
}

/// Resolves symlinks of the deepest part of `path` that exists, so a link
/// inside the workspace that points outside is seen as outside.
fn resolve_existing(path: &Path) -> PathBuf {
    let mut existing = path.to_path_buf();
    let mut rest = Vec::new();
    while !existing.as_os_str().is_empty() {
        if let Ok(real) = std::fs::canonicalize(&existing) {
            let mut real = plain(&real);
            for part in rest.iter().rev() {
                real.push(part);
            }
            return real;
        }
        match (
            existing.file_name().map(|n| n.to_os_string()),
            existing.parent(),
        ) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent.to_path_buf();
            }
            _ => break,
        }
    }
    path.to_path_buf()
}

/// True when `path` (absolute, or relative to `root`) is inside `root` and
/// not inside its `.git` folder.
pub fn path_inside(root: &Path, path: &str) -> bool {
    if path.trim().is_empty() || path.starts_with('~') {
        return false;
    }
    let root = plain(root);
    let candidate = Path::new(path);
    let joined = if candidate.is_absolute() {
        plain(candidate)
    } else {
        root.join(candidate)
    };
    let Some(lexical) = normalise(&joined) else {
        return false;
    };
    let resolved = resolve_existing(&lexical);
    [lexical, resolved].iter().all(|candidate| {
        candidate.strip_prefix(&root).is_ok_and(|rest| {
            rest.components().next().map(|c| c.as_os_str()) != Some(".git".as_ref())
        })
    })
}

/// Where a set of named paths is.
pub fn classify_paths(root: &Path, paths: &[String]) -> PathScope {
    if paths.is_empty() {
        return PathScope::Unknown;
    }
    if paths.iter().all(|path| path_inside(root, path)) {
        PathScope::Inside
    } else {
        PathScope::Outside
    }
}

/// The file paths a permission request names: tool call locations, diff
/// paths, and the common `rawInput` keys agents use for a file.
pub fn request_paths(
    locations: &[String],
    diffs: &[String],
    raw_input: Option<&Value>,
) -> Vec<String> {
    let mut paths: Vec<String> = locations.iter().chain(diffs).cloned().collect();
    if let Some(raw) = raw_input {
        for key in ["file_path", "filePath", "path", "notebook_path", "abs_path"] {
            if let Some(path) = raw.get(key).and_then(Value::as_str) {
                paths.push(path.to_owned());
            }
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

/// Characters that make a command shell syntax rather than one plain argv:
/// pipes, redirections, separators, substitution, quoting, globbing, and
/// variables. Any of them makes the command `Other`.
const SHELL_SYNTAX: &[char] = &[
    '|', '&', ';', '<', '>', '(', ')', '$', '`', '\\', '"', '\'', '*', '?', '[', ']', '{', '}',
    '~', '!', '#', '\n', '\r', '%', '^',
];

/// Shells whose `-c` / `-lc` script is read as the command.
const SHELLS: &[&str] = &["bash", "sh", "zsh", "/bin/bash", "/bin/sh", "/bin/zsh"];

/// The command text or argv a request carries (`rawInput.command` as a
/// string or an array, or `rawInput.cmd`).
fn command_argv(raw: &Value) -> Option<Result<Vec<String>, ()>> {
    let command = raw.get("command").or_else(|| raw.get("cmd"))?;
    let words = match command {
        Value::String(text) => return Some(split_plain(text)),
        Value::Array(items) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned).ok_or(()))
            .collect::<Result<Vec<_>, _>>(),
        _ => return Some(Err(())),
    };
    let Ok(words) = words else {
        return Some(Err(()));
    };
    // `["bash", "-lc", "git status"]`: the script is the command.
    if words.len() == 3
        && SHELLS.contains(&words[0].as_str())
        && matches!(words[1].as_str(), "-c" | "-lc")
    {
        return Some(split_plain(&words[2]));
    }
    if words
        .iter()
        .any(|word| word.contains(SHELL_SYNTAX) || word.chars().any(char::is_whitespace))
    {
        return Some(Err(()));
    }
    Some(Ok(words))
}

fn split_plain(text: &str) -> Result<Vec<String>, ()> {
    if text.contains(SHELL_SYNTAX) {
        return Err(());
    }
    let words: Vec<String> = text.split_whitespace().map(str::to_owned).collect();
    if words.is_empty() {
        Err(())
    } else {
        Ok(words)
    }
}

/// One allowlist entry: the exact program and subcommand words, the flags
/// that may follow, and whether plain positional words (paths, package names,
/// test filters, patterns) may follow, and whether they must be paths inside
/// the workspace.
struct SafeCommand {
    prefix: &'static [&'static str],
    flags: &'static [&'static str],
    positionals: Positionals,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Positionals {
    None,
    /// Plain words: package names, test filters, search patterns.
    Words,
    /// Paths inside the workspace (the first word may be a search pattern).
    Paths,
    /// A search pattern then paths inside the workspace.
    PatternThenPaths,
}

const SAFE_COMMANDS: &[SafeCommand] = &[
    SafeCommand {
        prefix: &["git", "status"],
        flags: &["--short", "-s", "--porcelain", "-sb", "--branch", "-b"],
        positionals: Positionals::None,
    },
    SafeCommand {
        prefix: &["git", "diff"],
        flags: &[
            "--stat",
            "--cached",
            "--staged",
            "--name-only",
            "--name-status",
            "--no-ext-diff",
        ],
        positionals: Positionals::Paths,
    },
    SafeCommand {
        prefix: &["git", "log"],
        flags: &["--oneline", "--stat", "--graph", "--decorate", "-n"],
        positionals: Positionals::Words,
    },
    SafeCommand {
        prefix: &["ls"],
        flags: &["-l", "-a", "-la", "-al", "-1", "-R", "-lh", "-A"],
        positionals: Positionals::Paths,
    },
    SafeCommand {
        prefix: &["cat"],
        flags: &[],
        positionals: Positionals::Paths,
    },
    SafeCommand {
        prefix: &["rg"],
        flags: &["-n", "-i", "-l", "-w", "-F", "-S", "--files", "--hidden"],
        positionals: Positionals::PatternThenPaths,
    },
    SafeCommand {
        prefix: &["cargo", "check"],
        flags: &[
            "-q",
            "--quiet",
            "--workspace",
            "--all-targets",
            "--lib",
            "--tests",
            "--offline",
            "--locked",
            "-p",
            "--package",
        ],
        positionals: Positionals::Words,
    },
    SafeCommand {
        prefix: &["cargo", "test"],
        flags: &[
            "-q",
            "--quiet",
            "--workspace",
            "--all-targets",
            "--lib",
            "--tests",
            "--offline",
            "--locked",
            "--no-fail-fast",
            "-p",
            "--package",
        ],
        positionals: Positionals::Words,
    },
    SafeCommand {
        prefix: &["pnpm", "test"],
        flags: &[],
        positionals: Positionals::None,
    },
    SafeCommand {
        prefix: &["pnpm", "typecheck"],
        flags: &[],
        positionals: Positionals::None,
    },
    SafeCommand {
        prefix: &["pnpm", "run", "test"],
        flags: &[],
        positionals: Positionals::None,
    },
    SafeCommand {
        prefix: &["pnpm", "run", "typecheck"],
        flags: &[],
        positionals: Positionals::None,
    },
    SafeCommand {
        prefix: &["npm", "test"],
        flags: &[],
        positionals: Positionals::None,
    },
    SafeCommand {
        prefix: &["npm", "run", "test"],
        flags: &[],
        positionals: Positionals::None,
    },
];

/// A plain word: letters, digits and `_ . : / @ + , -`, not starting with
/// `-`, with no `..` and no `=` (so no env assignment and no `--opt=value`).
fn plain_word(word: &str) -> bool {
    !word.is_empty()
        && !word.starts_with('-')
        && !word.contains("..")
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.:/@+,-".contains(c))
}

fn matches_entry(root: &Path, entry: &SafeCommand, argv: &[String]) -> bool {
    if argv.len() < entry.prefix.len()
        || argv
            .iter()
            .zip(entry.prefix)
            .any(|(have, want)| have != want)
    {
        return false;
    }
    let mut positional = 0;
    for word in &argv[entry.prefix.len()..] {
        if word.starts_with('-') {
            if !entry.flags.contains(&word.as_str()) {
                return false;
            }
            continue;
        }
        let ok = plain_word(word)
            && match entry.positionals {
                Positionals::None => false,
                Positionals::Words => true,
                Positionals::Paths => path_inside(root, word),
                Positionals::PatternThenPaths => positional == 0 || path_inside(root, word),
            };
        if !ok {
            return false;
        }
        positional += 1;
    }
    true
}

/// The class of the command a request carries, from its `rawInput`.
pub fn classify_command(root: &Path, raw_input: Option<&Value>) -> CommandClass {
    let Some(argv) = raw_input.and_then(command_argv) else {
        return CommandClass::None;
    };
    let Ok(argv) = argv else {
        return CommandClass::Other;
    };
    if SAFE_COMMANDS
        .iter()
        .any(|entry| matches_entry(root, entry, &argv))
    {
        CommandClass::Safe
    } else {
        CommandClass::Other
    }
}

/// Every fact for one request.
pub fn facts(
    root: &Path,
    kind: Option<&str>,
    locations: &[String],
    diffs: &[String],
    raw_input: Option<&Value>,
) -> RequestFacts {
    RequestFacts {
        kind: ToolKind::parse(kind),
        paths: classify_paths(root, &request_paths(locations, diffs, raw_input)),
        command: classify_command(root, raw_input),
    }
}

#[cfg(test)]
mod tests {
    use super::PolicyDecision::*;
    use super::PolicyReason::*;
    use super::*;
    use crate::permission_mode::ThreadPermissionMode::{self, *};
    use serde_json::json;

    const KINDS: [ToolKind; 10] = [
        ToolKind::Read,
        ToolKind::Edit,
        ToolKind::Delete,
        ToolKind::Move,
        ToolKind::Search,
        ToolKind::Execute,
        ToolKind::Think,
        ToolKind::Fetch,
        ToolKind::SwitchMode,
        ToolKind::Other,
    ];
    const SCOPES: [PathScope; 3] = [PathScope::Inside, PathScope::Outside, PathScope::Unknown];
    const COMMANDS: [CommandClass; 3] =
        [CommandClass::Safe, CommandClass::Other, CommandClass::None];

    /// The expected answer, written out independently of `decide`.
    fn expected(mode: ThreadPermissionMode, f: RequestFacts) -> PolicyDecision {
        let edit_inside = f.kind == ToolKind::Edit && f.paths == PathScope::Inside;
        let safe_exec = f.kind == ToolKind::Execute && f.command == CommandClass::Safe;
        match mode {
            Ask => Prompt,
            Plan => match f.kind {
                ToolKind::Read | ToolKind::Search | ToolKind::Fetch | ToolKind::Think => Prompt,
                _ => Reject(PlanModeReadOnly),
            },
            AcceptEdits => {
                if edit_inside {
                    Allow(AcceptEditsWorkspace)
                } else {
                    Prompt
                }
            }
            Auto => {
                if edit_inside {
                    Allow(AcceptEditsWorkspace)
                } else if safe_exec {
                    Allow(AutoSafeCommand)
                } else {
                    Prompt
                }
            }
            Full => Allow(FullAccess),
        }
    }

    #[test]
    fn the_whole_matrix_matches_the_table() {
        let mut rows = 0;
        for mode in ThreadPermissionMode::ALL {
            for kind in KINDS {
                for paths in SCOPES {
                    for command in COMMANDS {
                        let f = RequestFacts {
                            kind,
                            paths,
                            command,
                        };
                        assert_eq!(decide(mode, f), expected(mode, f), "{mode:?} {f:?}");
                        rows += 1;
                    }
                }
            }
        }
        assert_eq!(rows, 5 * 10 * 3 * 3);
    }

    #[test]
    fn named_rows_of_the_matrix() {
        let f = |kind, paths, command| RequestFacts {
            kind,
            paths,
            command,
        };
        let rows = [
            // Ask prompts for everything, even a safe command in the workspace.
            (
                Ask,
                f(ToolKind::Edit, PathScope::Inside, CommandClass::None),
                Prompt,
            ),
            (
                Ask,
                f(ToolKind::Execute, PathScope::Unknown, CommandClass::Safe),
                Prompt,
            ),
            // Plan refuses writes and commands without prompting.
            (
                Plan,
                f(ToolKind::Edit, PathScope::Inside, CommandClass::None),
                Reject(PlanModeReadOnly),
            ),
            (
                Plan,
                f(ToolKind::Execute, PathScope::Unknown, CommandClass::Safe),
                Reject(PlanModeReadOnly),
            ),
            (
                Plan,
                f(ToolKind::Delete, PathScope::Inside, CommandClass::None),
                Reject(PlanModeReadOnly),
            ),
            (
                Plan,
                f(ToolKind::SwitchMode, PathScope::Unknown, CommandClass::None),
                Reject(PlanModeReadOnly),
            ),
            (
                Plan,
                f(ToolKind::Other, PathScope::Unknown, CommandClass::None),
                Reject(PlanModeReadOnly),
            ),
            (
                Plan,
                f(ToolKind::Read, PathScope::Outside, CommandClass::None),
                Prompt,
            ),
            (
                Plan,
                f(ToolKind::Fetch, PathScope::Unknown, CommandClass::None),
                Prompt,
            ),
            // Accept edits: workspace edits only.
            (
                AcceptEdits,
                f(ToolKind::Edit, PathScope::Inside, CommandClass::None),
                Allow(AcceptEditsWorkspace),
            ),
            (
                AcceptEdits,
                f(ToolKind::Edit, PathScope::Outside, CommandClass::None),
                Prompt,
            ),
            (
                AcceptEdits,
                f(ToolKind::Edit, PathScope::Unknown, CommandClass::None),
                Prompt,
            ),
            (
                AcceptEdits,
                f(ToolKind::Delete, PathScope::Inside, CommandClass::None),
                Prompt,
            ),
            (
                AcceptEdits,
                f(ToolKind::Execute, PathScope::Unknown, CommandClass::Safe),
                Prompt,
            ),
            // Auto: safe commands too, nothing else.
            (
                Auto,
                f(ToolKind::Execute, PathScope::Unknown, CommandClass::Safe),
                Allow(AutoSafeCommand),
            ),
            (
                Auto,
                f(ToolKind::Execute, PathScope::Unknown, CommandClass::Other),
                Prompt,
            ),
            (
                Auto,
                f(ToolKind::Other, PathScope::Unknown, CommandClass::Safe),
                Prompt,
            ),
            (
                Auto,
                f(ToolKind::Edit, PathScope::Outside, CommandClass::None),
                Prompt,
            ),
            // Full allows (the caller logs it).
            (
                Full,
                f(ToolKind::Execute, PathScope::Outside, CommandClass::Other),
                Allow(FullAccess),
            ),
        ];
        for (mode, facts, want) in rows {
            assert_eq!(decide(mode, facts), want, "{mode:?} {facts:?}");
        }
    }

    fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = plain(&std::fs::canonicalize(dir.path()).unwrap());
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        (dir, root)
    }

    #[test]
    fn path_containment() {
        let (_dir, root) = root();
        let inside = root.join("src").join("lib.rs");
        let absolute = inside.to_string_lossy().into_owned();
        assert!(path_inside(&root, &absolute));
        assert!(path_inside(&root, "src/new_file.rs"));
        assert!(path_inside(&root, "./src/../README.md"));
        assert!(!path_inside(&root, "../outside.txt"));
        assert!(!path_inside(&root, "src/../../outside.txt"));
        assert!(!path_inside(&root, "~/.ssh/id_rsa"));
        assert!(!path_inside(&root, ".git/config"));
        assert!(!path_inside(&root, ""));
        let parent = root.parent().unwrap().join("sibling.txt");
        assert!(!path_inside(&root, &parent.to_string_lossy()));
        assert_eq!(classify_paths(&root, &[]), PathScope::Unknown);
        assert_eq!(
            classify_paths(&root, &[absolute.clone(), "../x".into()]),
            PathScope::Outside
        );
        assert_eq!(classify_paths(&root, &[absolute]), PathScope::Inside);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_workspace_is_outside() {
        let (_dir, root) = root();
        let away = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(away.path(), root.join("link")).unwrap();
        assert!(!path_inside(&root, "link/file.txt"));
    }

    #[test]
    fn request_paths_read_locations_diffs_and_raw_input() {
        let raw = json!({"file_path": "/w/a.rs", "content": "x"});
        let paths = request_paths(&["/w/b.rs".into()], &["/w/a.rs".into()], Some(&raw));
        assert_eq!(paths, vec!["/w/a.rs".to_owned(), "/w/b.rs".to_owned()]);
    }

    #[test]
    fn safe_commands_are_exact_argv_only() {
        let (_dir, root) = root();
        let class = |command: Value| classify_command(&root, Some(&json!({ "command": command })));
        for safe in [
            "git status",
            "git status --short",
            "git diff",
            "git diff --stat src",
            "git log --oneline -n 5",
            "ls",
            "ls -la src",
            "cat src/lib.rs",
            "rg -n needle src",
            "cargo check",
            "cargo test -p span-core permission",
            "pnpm test",
            "pnpm typecheck",
            "npm test",
        ] {
            assert_eq!(class(json!(safe)), CommandClass::Safe, "{safe}");
        }
        for unsafe_command in [
            "git status | sh",
            "git status; rm -rf src",
            "git status && curl x",
            "cat src/lib.rs > out",
            "cat < src/lib.rs",
            "echo $(whoami)",
            "cat `id`",
            "FOO=1 cargo test",
            "cargo test --config x",
            "cargo test --manifest-path=/elsewhere/Cargo.toml",
            "cargo build",
            "rg --pre sh needle",
            "cat ../outside",
            "cat /etc/passwd",
            "cat ~/.ssh/id_rsa",
            "ls -la *",
            "git push",
            "git diff --output=x",
            "pnpm test --watch",
            "npm install",
            "rm -rf src",
            "python -c 1",
            "\"git\" status",
            "git status\nrm x",
            "",
        ] {
            assert_eq!(
                class(json!(unsafe_command)),
                CommandClass::Other,
                "{unsafe_command:?}"
            );
        }
        // Codex sends argv, often wrapped in a shell.
        assert_eq!(class(json!(["git", "status"])), CommandClass::Safe);
        assert_eq!(
            class(json!(["bash", "-lc", "git diff"])),
            CommandClass::Safe
        );
        assert_eq!(
            class(json!(["bash", "-lc", "git diff | sh"])),
            CommandClass::Other
        );
        assert_eq!(class(json!(["git", "status; rm x"])), CommandClass::Other);
        assert_eq!(
            class(json!(["git", "log", "--format=%H"])),
            CommandClass::Other
        );
        assert_eq!(class(json!(42)), CommandClass::Other);
        assert_eq!(
            classify_command(&root, Some(&json!({"path": "x"}))),
            CommandClass::None
        );
        assert_eq!(classify_command(&root, None), CommandClass::None);
        assert_eq!(
            classify_command(&root, Some(&json!({"cmd": "ls"}))),
            CommandClass::Safe
        );
    }

    #[test]
    fn facts_from_a_request() {
        let (_dir, root) = root();
        let file = root.join("src").join("a.rs").to_string_lossy().into_owned();
        let edit = facts(&root, Some("edit"), &[file], &[], None);
        assert_eq!(edit.kind, ToolKind::Edit);
        assert_eq!(edit.paths, PathScope::Inside);
        let exec = facts(
            &root,
            Some("execute"),
            &[],
            &[],
            Some(&json!({"command": "git status"})),
        );
        assert_eq!(exec.command, CommandClass::Safe);
        assert_eq!(decide(Auto, exec), Allow(AutoSafeCommand));
        assert_eq!(ToolKind::parse(None), ToolKind::Other);
        assert_eq!(ToolKind::parse(Some("mcp")), ToolKind::Other);
        let reason = serde_json::to_string(&PlanModeReadOnly).unwrap();
        assert_eq!(reason, "\"plan_mode_read_only\"");
    }
}
