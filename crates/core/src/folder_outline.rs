//! Bounded outline of a workspace folder for a folder attachment (#91). The
//! outline is Span-side text sent next to a link to the folder, not an ACP
//! content type. It walks breadth first through `list_directory`, so the
//! workspace's ignore rules apply, and it skips version control, Span's own
//! data and dependency folders. Paths are relative to the folder: no absolute
//! path ever appears in the text.
use crate::workspace::CoreWorkspace;
use crate::Result;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::VecDeque;

/// Default number of entries an outline lists. Matches the UI's limit.
pub const FOLDER_OUTLINE_LIMIT: usize = 200;
/// Largest limit a caller may ask for.
pub const MAX_FOLDER_OUTLINE_LIMIT: usize = 2000;

/// Folders an outline never walks into.
const SKIPPED: &[&str] = &[
    ".git",
    ".span",
    "node_modules",
    ".hg",
    ".svn",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    "__pycache__",
    ".venv",
    "venv",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderOutline {
    /// The folder's own name, or the workspace folder's name for the root.
    pub name: String,
    /// Workspace-relative path with forward slashes, `.` for the root.
    pub path: String,
    /// Header line, a blank line, then one entry per line (folders end in `/`).
    pub text: String,
    /// Files listed. A lower bound when `truncated`.
    pub files: u32,
    /// The walk stopped at the entry limit.
    pub truncated: bool,
}

fn skipped(name: &str) -> bool {
    SKIPPED.contains(&name)
}

impl CoreWorkspace {
    /// Outline of the workspace folder at `path` (`""` or `.` for the root),
    /// listing at most `limit` entries (capped at `MAX_FOLDER_OUTLINE_LIMIT`).
    pub fn folder_outline(&self, path: &str, limit: usize) -> Result<FolderOutline> {
        let limit = limit.clamp(1, MAX_FOLDER_OUTLINE_LIMIT);
        let base = path.trim_matches('/');
        let base = if base == "." { "" } else { base };
        // Resolves inside the workspace and refuses anything outside it.
        let resolved = self.scan_directory(std::path::Path::new(if base.is_empty() {
            "."
        } else {
            base
        }))?;
        let relative_root = self.relative(&resolved)?;
        let name = if relative_root.is_empty() {
            self.root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "workspace".into())
        } else {
            relative_root
                .rsplit('/')
                .next()
                .unwrap_or(&relative_root)
                .to_owned()
        };
        let mut lines: Vec<String> = Vec::new();
        let mut files = 0u32;
        let mut truncated = false;
        let mut queue: VecDeque<String> = VecDeque::from([String::new()]);
        'walk: while let Some(dir) = queue.pop_front() {
            let listing = if dir.is_empty() {
                relative_root.clone()
            } else if relative_root.is_empty() {
                dir.clone()
            } else {
                format!("{relative_root}/{dir}")
            };
            let Ok(mut entries) =
                self.list_directory(if listing.is_empty() { "." } else { &listing })
            else {
                continue;
            };
            entries.sort_by(|a, b| {
                b.is_dir
                    .cmp(&a.is_dir)
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });
            for entry in entries {
                if entry.is_dir && skipped(&entry.name) {
                    continue;
                }
                if lines.len() >= limit {
                    truncated = true;
                    break 'walk;
                }
                let child = if dir.is_empty() {
                    entry.name.clone()
                } else {
                    format!("{dir}/{}", entry.name)
                };
                if entry.is_dir {
                    lines.push(format!("{child}/"));
                    queue.push_back(child);
                } else {
                    lines.push(child);
                    files += 1;
                }
            }
        }
        let count = if files == 1 && !truncated {
            "1 file".to_owned()
        } else {
            format!("{files}{} files", if truncated { "+" } else { "" })
        };
        let first = if truncated {
            format!(", first {limit} entries")
        } else {
            String::new()
        };
        let head = format!(
            "Folder outline of {name}/ ({count}{first}). Added by Span, not an ACP content type."
        );
        let mut text = head;
        text.push_str("\n\n");
        text.push_str(&lines.join("\n"));
        Ok(FolderOutline {
            name,
            path: if relative_root.is_empty() {
                ".".into()
            } else {
                relative_root
            },
            text,
            files,
            truncated,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn workspace() -> (tempfile::TempDir, CoreWorkspace) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(root.join("target/debug")).unwrap();
        fs::create_dir_all(root.join("ignored")).unwrap();
        fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        fs::write(root.join("README.md"), "x").unwrap();
        fs::write(root.join("src/main.rs"), "x").unwrap();
        fs::write(root.join("src/nested/deep.rs"), "x").unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "x").unwrap();
        fs::write(root.join("target/debug/app"), "x").unwrap();
        fs::write(root.join("ignored/secret.txt"), "x").unwrap();
        let workspace = CoreWorkspace::open(root).unwrap();
        (dir, workspace)
    }

    #[test]
    fn outlines_breadth_first_with_relative_paths_and_skips() {
        let (dir, workspace) = workspace();
        let outline = workspace.folder_outline(".", FOLDER_OUTLINE_LIMIT).unwrap();
        assert_eq!(outline.path, ".");
        assert!(!outline.truncated);
        assert_eq!(outline.files, 4, "{}", outline.text);
        let lines: Vec<&str> = outline.text.lines().skip(2).collect();
        assert_eq!(
            lines,
            [
                "src/",
                ".gitignore",
                "README.md",
                "src/nested/",
                "src/main.rs",
                "src/nested/deep.rs"
            ]
        );
        assert!(outline.text.starts_with(&format!(
            "Folder outline of {}/ (4 files). Added by Span",
            outline.name
        )));
        let root = dir.path().canonicalize().unwrap();
        assert!(!outline.text.contains(&*root.to_string_lossy()));
        assert!(!outline.text.contains("node_modules"));
        assert!(!outline.text.contains("target"));
        assert!(!outline.text.contains("secret"));
    }

    #[test]
    fn a_subfolder_outline_is_relative_to_that_folder() {
        let (_dir, workspace) = workspace();
        let outline = workspace
            .folder_outline("src/", FOLDER_OUTLINE_LIMIT)
            .unwrap();
        assert_eq!(
            (outline.name.as_str(), outline.path.as_str()),
            ("src", "src")
        );
        assert_eq!(outline.files, 2);
        assert_eq!(
            outline.text.lines().skip(2).collect::<Vec<_>>(),
            ["nested/", "main.rs", "nested/deep.rs"]
        );
    }

    #[test]
    fn the_outline_stops_at_the_limit_and_says_so() {
        let (_dir, workspace) = workspace();
        let outline = workspace.folder_outline(".", 2).unwrap();
        assert!(outline.truncated);
        assert_eq!(outline.text.lines().skip(2).count(), 2);
        assert!(
            outline.text.contains("(1+ files, first 2 entries)"),
            "{}",
            outline.text
        );
    }

    #[test]
    fn folders_outside_the_workspace_are_refused() {
        let (_dir, workspace) = workspace();
        assert!(workspace.folder_outline("..", 10).is_err());
        assert!(workspace.folder_outline("README.md", 10).is_err());
    }
}
