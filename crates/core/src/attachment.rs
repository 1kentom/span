//! Saving user-supplied attachments into the workspace without ever overwriting a file.
use crate::workspace::CoreWorkspace;
use crate::{io_error, CoreError, Result};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Largest attachment accepted in one save.
pub const MAX_ATTACHMENT_BYTES: usize = 32 * 1024 * 1024;
const MAX_NAME_BYTES: usize = 255;
const MAX_COLLISION_SUFFIX: u32 = 10_000;

static TEMP_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedAttachment {
    /// Workspace-relative path with forward slashes.
    pub path: String,
    pub size: u32,
    /// True when the requested name was taken and a numbered name was used.
    pub renamed: bool,
}

fn reject(message: impl Into<String>) -> CoreError {
    CoreError::Attachment(message.into())
}

/// Directories the workspace scan already hides, so attachments must not land in them.
fn is_protected(name: &str) -> bool {
    [".git", ".span", "node_modules"]
        .iter()
        .any(|protected| name.eq_ignore_ascii_case(protected))
}

fn is_windows_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").trim_end();
    let upper = stem.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|p| {
            upper
                .strip_prefix(p)
                .is_some_and(|n| n.len() == 1 && matches!(n.as_bytes()[0], b'1'..=b'9'))
        })
}

/// Shared by directory components and file names.
pub(crate) fn check_component(name: &str) -> Result<()> {
    if name.is_empty() || name == "." || name == ".." {
        return Err(reject("name is empty or relative"));
    }
    if name.len() > MAX_NAME_BYTES {
        return Err(reject("name is too long"));
    }
    if name.chars().any(|c| {
        c.is_control() || matches!(c, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*')
    }) {
        return Err(reject(
            "name contains a path separator, control or reserved character",
        ));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(reject("name ends with a dot or space"));
    }
    if is_windows_reserved(name) {
        return Err(reject("name is reserved on Windows"));
    }
    if is_protected(name) {
        return Err(reject("name is a protected directory"));
    }
    Ok(())
}

pub(crate) fn numbered(file_name: &str, n: u32) -> String {
    let path = Path::new(file_name);
    match (path.file_stem(), path.extension()) {
        (Some(stem), Some(ext)) => {
            format!("{} ({n}).{}", stem.to_string_lossy(), ext.to_string_lossy())
        }
        _ => format!("{file_name} ({n})"),
    }
}

impl CoreWorkspace {
    /// Save `bytes` as a new file named `file_name` inside workspace-relative `dir`.
    /// Never overwrites: a taken name gets a ` (n)` suffix and `renamed` is set.
    pub fn save_attachment(
        &mut self,
        dir: &str,
        file_name: &str,
        bytes: &[u8],
    ) -> Result<SavedAttachment> {
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(reject(format!(
                "attachment is larger than {MAX_ATTACHMENT_BYTES} bytes"
            )));
        }
        check_component(file_name)?;
        let directory = self.ensure_attachment_dir(dir)?;
        let temp = write_temp(&directory, bytes)?;
        let result = self.link_unique(&directory, file_name, &temp);
        let _ = fs::remove_file(&temp);
        let (final_path, renamed) = result?;
        Ok(SavedAttachment {
            path: self.relative(&final_path)?,
            size: bytes.len() as u32,
            renamed,
        })
    }

    /// Validate `dir` lexically, then create it one component at a time, re-checking the
    /// canonical location each step so a symlinked component cannot lead outside the root.
    fn ensure_attachment_dir(&self, dir: &str) -> Result<PathBuf> {
        if dir.contains('\0') {
            return Err(reject("directory contains NUL"));
        }
        let requested = Path::new(dir);
        if requested.is_absolute() {
            return Err(CoreError::OutsideWorkspace(dir.to_owned()));
        }
        let mut current = self.root.clone();
        for component in requested.components() {
            let part = match component {
                Component::CurDir => continue,
                Component::Normal(part) => part.to_string_lossy().into_owned(),
                _ => return Err(CoreError::OutsideWorkspace(dir.to_owned())),
            };
            check_component(&part)?;
            current.push(&part);
            if current.symlink_metadata().is_err() {
                fs::create_dir(&current).map_err(|e| io_error("Create directory", &current, e))?;
            }
            current = current
                .canonicalize()
                .map_err(|e| io_error("Resolve directory", &current, e))?;
            if !current.starts_with(&self.root) {
                return Err(CoreError::OutsideWorkspace(dir.to_owned()));
            }
            if !current.is_dir() {
                return Err(reject(format!("not a directory: {part}")));
            }
        }
        Ok(current)
    }

    /// Atomically publish `temp` under the first free name. A hard link fails when the
    /// target exists, so a concurrent writer cannot be clobbered; rename is the fallback
    /// for filesystems without hard links.
    fn link_unique(
        &self,
        directory: &Path,
        file_name: &str,
        temp: &Path,
    ) -> Result<(PathBuf, bool)> {
        for n in 0..=MAX_COLLISION_SUFFIX {
            let name = if n == 0 {
                file_name.to_owned()
            } else {
                numbered(file_name, n)
            };
            let target = directory.join(&name);
            // An open buffer may track a not yet existing file at this path.
            if self
                .relative(&target)
                .is_ok_and(|r| self.buffers.contains_key(&r))
            {
                continue;
            }
            match fs::hard_link(temp, &target) {
                Ok(()) => return Ok((target, n > 0)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => {
                    if target.symlink_metadata().is_ok() {
                        continue;
                    }
                    match publish_new(temp, &target) {
                        Ok(()) => return Ok((target, n > 0)),
                        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                        Err(e) => return Err(io_error("Save attachment", &target, e)),
                    }
                }
            }
        }
        Err(reject("too many files with the same name"))
    }
}

/// Fallback for filesystems without hard links: copy `temp` to `target`, which must
/// not exist (`create_new`). Unlike `rename`, this never replaces a file, even one
/// created after the caller looked. A failed copy leaves no partial target.
fn publish_new(temp: &Path, target: &Path) -> std::io::Result<()> {
    let bytes = fs::read(temp)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)?;
    let written = file.write_all(&bytes).and_then(|()| file.sync_all());
    drop(file);
    if let Err(e) = written {
        let _ = fs::remove_file(target);
        return Err(e);
    }
    fs::remove_file(temp)
}

fn write_temp(directory: &Path, bytes: &[u8]) -> Result<PathBuf> {
    let temp = directory.join(format!(
        ".attachment.span-{}-{}",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| io_error("Create attachment", &temp, e))?;
        file.write_all(bytes)
            .map_err(|e| io_error("Write attachment", &temp, e))?;
        file.sync_all()
            .map_err(|e| io_error("Flush attachment", &temp, e))
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&temp);
        return Err(e);
    }
    Ok(temp)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open() -> (tempfile::TempDir, CoreWorkspace) {
        let dir = tempfile::tempdir().unwrap();
        let ws = CoreWorkspace::open(dir.path()).unwrap();
        (dir, ws)
    }

    fn leftovers(dir: &Path) -> usize {
        fs::read_dir(dir)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".span-")
            })
            .count()
    }

    #[test]
    fn happy_path_creates_directory_and_file() {
        let (root, mut ws) = open();
        let saved = ws.save_attachment("assets/img", "a.png", b"hello").unwrap();
        assert_eq!(saved.path, "assets/img/a.png");
        assert_eq!(saved.size, 5);
        assert!(!saved.renamed);
        assert_eq!(
            fs::read(root.path().join("assets/img/a.png")).unwrap(),
            b"hello"
        );
        assert_eq!(leftovers(&root.path().join("assets/img")), 0);
    }

    #[test]
    fn empty_dir_means_workspace_root() {
        let (root, mut ws) = open();
        let saved = ws.save_attachment("", "a.txt", b"x").unwrap();
        assert_eq!(saved.path, "a.txt");
        assert!(root.path().join("a.txt").is_file());
    }

    #[test]
    fn the_copy_fallback_never_replaces_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let temp = dir.path().join("temp");
        let target = dir.path().join("target.txt");
        fs::write(&temp, b"new").unwrap();
        fs::write(&target, b"keep").unwrap();
        let error = publish_new(&temp, &target).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&target).unwrap(), b"keep");
        assert!(
            temp.exists(),
            "the temp file is left for the caller to clean up"
        );
        fs::remove_file(&target).unwrap();
        publish_new(&temp, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert!(!temp.exists());
    }

    #[test]
    fn rejects_bad_directories() {
        let (root, mut ws) = open();
        let absolute = root.path().display().to_string();
        for dir in [
            absolute.as_str(),
            "..",
            "a/../b",
            "../x",
            ".git",
            "a/.GIT/b",
            ".span",
            "a/.Span/b",
            "node_modules",
            "bad\0dir",
            "a\\b",
        ] {
            assert!(ws.save_attachment(dir, "f.txt", b"x").is_err(), "{dir:?}");
        }
        assert!(
            !root.path().join("a").exists()
                || fs::read_dir(root.path().join("a"))
                    .unwrap()
                    .next()
                    .is_none()
        );
    }

    #[test]
    fn rejects_bad_file_names() {
        let (root, mut ws) = open();
        let long = "a".repeat(256);
        for name in [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "../x",
            "/abs",
            "n\0ul",
            "tab\tname",
            "new\nline",
            "con",
            "NUL.txt",
            "com1.png",
            "LPT9",
            "aux.tar.gz",
            "trail.",
            "trail ",
            "a:b",
            "a?b",
            ".git",
            ".SPAN",
            long.as_str(),
        ] {
            assert!(
                ws.save_attachment("assets", name, b"x").is_err(),
                "{name:?}"
            );
        }
        assert!(!root.path().join("assets").join("a").exists());
    }

    #[test]
    fn accepts_lookalike_names() {
        let (_root, mut ws) = open();
        for name in ["console.txt", "com10.txt", ".gitignore", "a b.png"] {
            ws.save_attachment("assets", name, b"x").unwrap();
        }
    }

    #[test]
    fn rejects_oversize_and_accepts_exact_cap() {
        let (root, mut ws) = open();
        let too_big = vec![0u8; MAX_ATTACHMENT_BYTES + 1];
        assert!(ws.save_attachment("assets", "big.bin", &too_big).is_err());
        assert!(!root.path().join("assets").exists());
        let exact = vec![0u8; MAX_ATTACHMENT_BYTES];
        let saved = ws.save_attachment("assets", "big.bin", &exact).unwrap();
        assert_eq!(saved.size as usize, MAX_ATTACHMENT_BYTES);
    }

    #[test]
    fn collisions_get_numbered_names_and_never_overwrite() {
        let (root, mut ws) = open();
        let first = ws.save_attachment("assets", "a.png", b"one").unwrap();
        let second = ws.save_attachment("assets", "a.png", b"two").unwrap();
        let third = ws.save_attachment("assets", "a.png", b"three").unwrap();
        assert!(!first.renamed);
        assert!(second.renamed && third.renamed);
        assert_eq!(second.path, "assets/a (1).png");
        assert_eq!(third.path, "assets/a (2).png");
        assert_eq!(fs::read(root.path().join("assets/a.png")).unwrap(), b"one");
        assert_eq!(
            fs::read(root.path().join("assets/a (1).png")).unwrap(),
            b"two"
        );
        let bare = ws.save_attachment("assets", "notes", b"1").unwrap();
        let bare2 = ws.save_attachment("assets", "notes", b"2").unwrap();
        assert_eq!(
            (bare.path.as_str(), bare2.path.as_str()),
            ("assets/notes", "assets/notes (1)")
        );
    }

    #[test]
    fn open_buffer_for_missing_file_counts_as_taken() {
        let (root, mut ws) = open();
        ws.open_buffer("assets-note.md").unwrap();
        let saved = ws.save_attachment("", "assets-note.md", b"x").unwrap();
        assert!(saved.renamed);
        assert_eq!(saved.path, "assets-note (1).md");
        assert!(!root.path().join("assets-note.md").exists());
    }

    #[test]
    fn write_is_atomic_and_leaves_no_temp_files() {
        let (root, mut ws) = open();
        ws.save_attachment("assets", "a.bin", b"data").unwrap();
        ws.save_attachment("assets", "a.bin", b"data").unwrap();
        assert_eq!(leftovers(&root.path().join("assets")), 0);
        let names: Vec<_> = fs::read_dir(root.path().join("assets"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");
    }

    #[test]
    fn failed_save_leaves_no_temp_file() {
        let (root, mut ws) = open();
        fs::write(root.path().join("assets"), b"i am a file").unwrap();
        assert!(ws.save_attachment("assets", "a.txt", b"x").is_err());
        assert_eq!(
            fs::read(root.path().join("assets")).unwrap(),
            b"i am a file"
        );
        assert_eq!(leftovers(root.path()), 0);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_directory_cannot_escape_root() {
        let (root, mut ws) = open();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
        for dir in ["link", "link/sub"] {
            assert!(matches!(
                ws.save_attachment(dir, "a.txt", b"x"),
                Err(CoreError::OutsideWorkspace(_))
            ));
        }
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_inside_root_is_followed_but_file_symlink_not_overwritten() {
        let (root, mut ws) = open();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("victim.txt");
        fs::write(&target, b"keep").unwrap();
        fs::create_dir(root.path().join("assets")).unwrap();
        std::os::unix::fs::symlink(&target, root.path().join("assets/a.txt")).unwrap();
        let saved = ws.save_attachment("assets", "a.txt", b"new").unwrap();
        assert_eq!(saved.path, "assets/a (1).txt");
        assert_eq!(fs::read(&target).unwrap(), b"keep");
    }
}
