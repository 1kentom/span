use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

pub const HELP: &str = "Usage: span [OPTIONS] [FOLDER | FILE[:LINE[:COLUMN]]]...\n\nOpen a folder or one or more existing files. Relative paths use the invoking\nshell's working directory. Quote paths containing spaces. Line and column\nnumbers are 1-based. Requests sent to an existing window use its unsaved\nchanges confirmation before changing projects.\n\nOptions:\n  --goto FILE[:LINE[:COLUMN]]  Open a file at a location\n  --help, -h                   Print this help without starting the GUI\n  --version, -V                Print the version without starting the GUI\n  --                          Treat following arguments as paths\n\nExamples:\n  span .\n  span \"path/to/my project\"\n  span src/main.rs:12:3\n  span --goto src/main.rs:12 other.rs\n\n--new-window and --wait are not implemented.\n";

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartupFile {
    /// Canonical absolute path, resolved relative to the invoking process.
    pub path: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartupRequest {
    pub workspace_root: Option<String>,
    pub files: Vec<StartupFile>,
    /// True when `workspace_root` was derived from the files (no folder was named). The window
    /// then keeps an open project and opens the files in it, instead of switching project.
    #[serde(default)]
    pub implied_root: bool,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliAction {
    Open(StartupRequest),
    Help,
    Version,
}

/// Arguments exclude argv[0]. This function never starts a GUI or changes files.
pub fn parse_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Result<CliAction, String> {
    let args: Vec<_> = args.into_iter().collect();
    let mut positional = false;
    // Informational commands do not touch the filesystem.
    for arg in &args {
        if arg == "--" {
            break;
        }
        if arg == "--help" || arg == "-h" {
            return Ok(CliAction::Help);
        }
        if arg == "--version" || arg == "-V" {
            return Ok(CliAction::Version);
        }
    }
    let mut targets = vec![];
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if !positional && arg == "--" {
            positional = true;
            continue;
        }
        if !positional && arg == "--goto" {
            let value = args
                .next()
                .filter(|s| !s.is_empty() && !s.starts_with("--"))
                .ok_or_else(|| "--goto requires FILE[:LINE[:COLUMN]]".to_owned())?;
            targets.push((value, true));
            continue;
        }
        if !positional && arg.starts_with('-') {
            return Err(format!(
                "Unknown option: {arg}. Run span --help for supported options."
            ));
        }
        if arg.is_empty() {
            return Err("A path cannot be empty".into());
        }
        targets.push((arg, false));
    }
    let mut request = StartupRequest::default();
    for (value, goto) in targets {
        // Prefer a real literal path, including filenames with numeric colon suffixes.
        let literal = resolve(cwd, &value);
        let (raw, line, column) = if literal.exists() {
            (value.as_str(), None, None)
        } else {
            split_location(&value)?
        };
        let path = std::fs::canonicalize(resolve(cwd, raw))
            .map_err(|e| format!("Cannot open {raw}: {e}"))?;
        let path_text = path
            .to_str()
            .ok_or_else(|| format!("Path is not valid Unicode: {}", path.display()))?
            .to_owned();
        if path.is_dir() {
            if goto || line.is_some() {
                return Err(format!("Expected a file: {raw}"));
            }
            if request
                .workspace_root
                .as_ref()
                .is_some_and(|root| root != &path_text)
            {
                return Err("Only one project folder can be opened per request".into());
            }
            request.workspace_root = Some(path_text);
        } else if path.is_file() {
            request.files.push(StartupFile {
                path: path_text,
                line,
                column,
            });
        } else {
            return Err(format!("Expected a file or folder: {raw}"));
        }
    }
    if request.workspace_root.is_none() {
        request.implied_root = !request.files.is_empty();
        if let Some(first) = request.files.first() {
            let mut root = Path::new(&first.path)
                .parent()
                .ok_or("File has no parent folder")?
                .to_path_buf();
            for file in &request.files {
                while !Path::new(&file.path).starts_with(&root) {
                    if !root.pop() {
                        return Err("Files must share a filesystem root".into());
                    }
                }
            }
            request.workspace_root = Some(
                root.to_str()
                    .ok_or("Project path is not valid Unicode")?
                    .to_owned(),
            );
        }
    }
    if let Some(root) = &request.workspace_root {
        for file in &request.files {
            if !Path::new(&file.path).starts_with(root) {
                return Err(format!(
                    "File is outside the requested project folder: {}",
                    file.path
                ));
            }
        }
    }
    Ok(CliAction::Open(request))
}
fn resolve(cwd: &Path, raw: &str) -> PathBuf {
    let path = Path::new(raw);
    if path.is_absolute() {
        path.to_owned()
    } else {
        cwd.join(path)
    }
}
/// Peel at most two rightmost numeric fields, retaining drive letters and other colons.
fn split_location(value: &str) -> Result<(&str, Option<u32>, Option<u32>), String> {
    let Some((head, tail)) = value.rsplit_once(':') else {
        return Ok((value, None, None));
    };
    if tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit()) {
        return Ok((value, None, None));
    }
    let last = parse_coordinate(tail)?;
    if let Some((path, previous)) = head.rsplit_once(':') {
        if !previous.is_empty() && previous.bytes().all(|b| b.is_ascii_digit()) {
            if path.is_empty() {
                return Err("A location requires a file path".into());
            }
            return Ok((path, Some(parse_coordinate(previous)?), Some(last)));
        }
    }
    if head.is_empty() {
        return Err("A location requires a file path".into());
    }
    Ok((head, Some(last), None))
}
fn parse_coordinate(value: &str) -> Result<u32, String> {
    value.parse::<u32>().ok().filter(|n| *n > 0).ok_or_else(|| {
        format!(
            "Line and column must be between 1 and {}: {value}",
            u32::MAX
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(args: &[&str], cwd: &Path) -> Result<CliAction, String> {
        parse_args(args.iter().map(|s| s.to_string()), cwd)
    }
    #[test]
    fn preserves_drive_letters_and_filename_colons() {
        assert_eq!(
            split_location(r"C:\a\file.rs:12:3").unwrap(),
            (r"C:\a\file.rs", Some(12), Some(3))
        );
        assert_eq!(
            split_location(r"C:\a\file.rs:12").unwrap(),
            (r"C:\a\file.rs", Some(12), None)
        );
        assert_eq!(
            split_location("a:part.rs:12:3").unwrap(),
            ("a:part.rs", Some(12), Some(3))
        );
        assert_eq!(
            split_location("a:part.rs").unwrap(),
            ("a:part.rs", None, None)
        );
        assert!(split_location("file:0").is_err());
        assert!(split_location("file:4294967296").is_err());
    }
    #[test]
    fn help_version_and_missing_arguments() {
        assert_eq!(
            parse(&["--help"], Path::new("/missing")).unwrap(),
            CliAction::Help
        );
        assert_eq!(
            parse(&["--version"], Path::new("/missing")).unwrap(),
            CliAction::Version
        );
        assert!(parse(&["--goto"], Path::new("."))
            .unwrap_err()
            .contains("requires"));
        assert!(parse(&["--new-window"], Path::new(".")).is_err());
        assert!(parse(&["missing.rs"], Path::new(".")).is_err());
    }
    #[test]
    fn resolves_invoking_cwd_unicode_spaces_multiple_files_and_locations() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("mój project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("one.rs"), "one").unwrap();
        std::fs::write(root.join("two.rs"), "two").unwrap();
        let CliAction::Open(request) = parse(&["--goto", "one.rs:2:3", "two.rs"], &root).unwrap()
        else {
            panic!()
        };
        assert_eq!(
            request.workspace_root.unwrap(),
            std::fs::canonicalize(&root).unwrap().to_str().unwrap()
        );
        assert_eq!(request.files.len(), 2);
        assert_eq!(request.files[0].line, Some(2));
        assert_eq!(request.files[0].column, Some(3));
        assert!(request
            .files
            .iter()
            .all(|file| Path::new(&file.path).is_absolute()));
    }
    #[test]
    fn double_dash_and_literal_colon_paths() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("--help"), "text").unwrap();
        let CliAction::Open(request) = parse(&["--", "--help"], temp.path()).unwrap() else {
            panic!()
        };
        assert_eq!(request.files.len(), 1);
        #[cfg(unix)]
        {
            std::fs::write(temp.path().join("actual:12"), "text").unwrap();
            let CliAction::Open(request) = parse(&["actual:12"], temp.path()).unwrap() else {
                panic!()
            };
            assert_eq!(request.files[0].line, None);
        }
    }
    #[test]
    fn explicit_folder_rejects_outside_files_without_changing_anything() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("project")).unwrap();
        std::fs::write(temp.path().join("outside.rs"), "precious").unwrap();
        assert!(parse(&["project", "outside.rs"], temp.path())
            .unwrap_err()
            .contains("outside"));
        assert_eq!(
            std::fs::read_to_string(temp.path().join("outside.rs")).unwrap(),
            "precious"
        );
    }
}
