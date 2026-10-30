//! Binary safe reads for the editor. A file that is not UTF-8 text never reaches a buffer:
//! reads report [`CoreError::NotText`] and the frontend shows the file viewer instead.
use crate::{io_error, CoreError, CoreWorkspace, Result};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

/// Bytes inspected for a NUL byte, the same window git and the UI viewer use.
pub const BINARY_SNIFF_BYTES: usize = 8 * 1024;
/// The single user facing sentence for a file that cannot open as text.
pub const NOT_TEXT_MESSAGE: &str = "This file isn't text, so it can't be opened in the editor.";
/// Hard ceiling for [`CoreWorkspace::read_file_bytes`], whatever the caller asks for.
pub const MAX_VIEWER_READ_BYTES: u64 = 128 * 1024 * 1024;

/// Extensions that are binary containers or media whatever their first bytes look like.
/// SVG and other XML based formats are text and stay out of this list.
const BINARY_EXTENSIONS: &[&str] = &[
    "docx", "docm", "dotx", "xlsx", "xlsm", "xltx", "pptx", "pptm", "potx", "doc", "xls", "ppt",
    "odt", "ods", "odp", "numbers", "pages", "pdf", "epub", "zip", "gz", "tgz", "bz2", "xz", "zst",
    "7z", "rar", "tar", "jar", "war", "apk", "ipa", "dmg", "iso", "pkg", "deb", "rpm", "png",
    "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "tif", "tiff", "heic", "avif", "psd",
    "sketch", "fig", "mp3", "m4a", "wav", "flac", "ogg", "oga", "opus", "aac", "mp4", "m4v", "mov",
    "mkv", "webm", "avi", "woff", "woff2", "ttf", "otf", "eot", "exe", "dll", "so", "dylib", "o",
    "a", "lib", "class", "wasm", "pyc", "sqlite", "sqlite3", "db", "bin",
];

/// What a file holds, as far as the editor is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FileContentKind {
    Text,
    Binary,
    Missing,
    Directory,
}

/// Name, size and kind of a workspace file, read without opening a buffer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileProbe {
    /// Workspace relative path.
    pub path: String,
    pub name: String,
    pub size: u64,
    pub kind: FileContentKind,
}

/// True for an extension that is never editable text (case insensitive).
pub fn has_binary_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            let ext = ext.to_ascii_lowercase();
            BINARY_EXTENSIONS.contains(&ext.as_str())
        })
}

/// A NUL byte in the first [`BINARY_SNIFF_BYTES`] marks binary content. UTF-16 text also has
/// NUL bytes: the editor only edits UTF-8, so it is treated as binary and shown in the viewer.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0)
}

/// True when a prefix of a file is not UTF-8. An incomplete sequence at the very end is a
/// cut, not an error, because the prefix may split one character.
fn prefix_not_utf8(bytes: &[u8]) -> bool {
    match std::str::from_utf8(bytes) {
        Ok(_) => false,
        Err(error) => error.error_len().is_some(),
    }
}

fn not_text(path: &Path, detail: impl Into<String>) -> CoreError {
    CoreError::NotText {
        path: path.display().to_string(),
        detail: detail.into(),
    }
}

/// Reads a whole file as UTF-8 text, or reports [`CoreError::NotText`] for binary content.
/// A leading UTF-8 BOM is kept, as `read_to_string` did.
pub(crate) fn read_text(operation: &'static str, path: &Path) -> Result<String> {
    if has_binary_extension(path) {
        return Err(not_text(path, "binary file extension"));
    }
    let bytes = fs::read(path).map_err(|error| io_error(operation, path, error))?;
    if looks_binary(&bytes) {
        return Err(not_text(path, "NUL byte in the first 8 KiB"));
    }
    String::from_utf8(bytes).map_err(|error| not_text(path, error.utf8_error().to_string()))
}

impl CoreWorkspace {
    /// Classifies a workspace file from its extension and first bytes, without reading the rest
    /// and without opening a buffer. A file whose later bytes are not UTF-8 is still refused by
    /// `open_buffer` with [`CoreError::NotText`].
    pub fn probe_file(&self, path: &str) -> Result<FileProbe> {
        let resolved = self.resolve(path)?;
        let relative = self.relative(&resolved)?;
        let name = resolved
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let meta = match fs::metadata(&resolved) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(FileProbe {
                    path: relative,
                    name,
                    size: 0,
                    kind: FileContentKind::Missing,
                })
            }
            Err(error) => return Err(io_error("Inspect file", &resolved, error)),
        };
        if meta.is_dir() {
            return Ok(FileProbe {
                path: relative,
                name,
                size: 0,
                kind: FileContentKind::Directory,
            });
        }
        let kind = if has_binary_extension(&resolved) {
            FileContentKind::Binary
        } else {
            let mut head = Vec::with_capacity(BINARY_SNIFF_BYTES);
            File::open(&resolved)
                .and_then(|file| file.take(BINARY_SNIFF_BYTES as u64).read_to_end(&mut head))
                .map_err(|error| io_error("Inspect file", &resolved, error))?;
            if looks_binary(&head) || prefix_not_utf8(&head) {
                FileContentKind::Binary
            } else {
                FileContentKind::Text
            }
        };
        Ok(FileProbe {
            path: relative,
            name,
            size: meta.len(),
            kind,
        })
    }

    /// Reads up to `max_bytes` of a workspace file as raw bytes for the file viewer. Refuses a
    /// larger file instead of truncating it, so a document viewer never sees half a container.
    pub fn read_file_bytes(&self, path: &str, max_bytes: u64) -> Result<Vec<u8>> {
        let resolved = self.resolve(path)?;
        let limit = max_bytes.min(MAX_VIEWER_READ_BYTES);
        let file =
            File::open(&resolved).map_err(|error| io_error("Open file", &resolved, error))?;
        let meta = file
            .metadata()
            .map_err(|error| io_error("Inspect file", &resolved, error))?;
        if !meta.is_file() {
            return Err(CoreError::InvalidEdit("Only files can be read".into()));
        }
        if meta.len() > limit {
            return Err(CoreError::InvalidEdit(format!(
                "File is larger than the {limit} byte viewer limit"
            )));
        }
        // The size can change between the check and the read: bound the read itself.
        let mut bytes = Vec::new();
        file.take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| io_error("Read file", &resolved, error))?;
        if bytes.len() as u64 > limit {
            return Err(CoreError::InvalidEdit(format!(
                "File is larger than the {limit} byte viewer limit"
            )));
        }
        Ok(bytes)
    }
}

impl CoreWorkspace {
    /// The canonical path of an existing workspace file, and why opening it with the system
    /// default app is refused (programs, scripts, executables), using the same table as uploads.
    pub fn external_open_target(&self, path: &str) -> Result<(PathBuf, Option<String>)> {
        let resolved = self.existing_file(path)?;
        let name = resolved
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut head = Vec::with_capacity(512);
        File::open(&resolved)
            .and_then(|file| file.take(512).read_to_end(&mut head))
            .map_err(|error| io_error("Inspect file", &resolved, error))?;
        let refusal =
            crate::uploads::open_refusal(&name, &head, crate::uploads::is_executable(&resolved))
                .map(|reason| {
                    reason.replace(
                        "Use Save to workspace and review it there instead.",
                        "Review it in the editor or a terminal instead.",
                    )
                });
        Ok((resolved, refusal))
    }

    /// The canonical path of an existing workspace file (not a folder), for reveal actions.
    pub fn existing_file(&self, path: &str) -> Result<PathBuf> {
        let resolved = self.resolve(path)?;
        let meta =
            fs::metadata(&resolved).map_err(|error| io_error("Inspect file", &resolved, error))?;
        if !meta.is_file() {
            return Err(CoreError::InvalidEdit(
                "Only files can be opened here".into(),
            ));
        }
        Ok(resolved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal stored (uncompressed) zip with one `word/document.xml` entry: the shape of a
    /// .docx, built in the test so no binary fixture is committed.
    fn docx_like_bytes() -> Vec<u8> {
        let name = b"word/document.xml";
        let body = b"<w:document>hello</w:document>";
        let mut out = Vec::new();
        out.extend_from_slice(b"PK\x03\x04");
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&0u16.to_le_bytes()); // stored
        out.extend_from_slice(&0u32.to_le_bytes()); // time and date
        out.extend_from_slice(&0u32.to_le_bytes()); // crc, not checked here
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name);
        out.extend_from_slice(body);
        out
    }

    fn workspace_with(files: &[(&str, &[u8])]) -> (tempfile::TempDir, CoreWorkspace) {
        let dir = tempfile::tempdir().unwrap();
        for (name, bytes) in files {
            fs::write(dir.path().join(name), bytes).unwrap();
        }
        let workspace = CoreWorkspace::open(dir.path())
            .unwrap()
            .with_user_settings(None);
        (dir, workspace)
    }

    fn assert_not_text(error: CoreError) {
        assert!(matches!(error, CoreError::NotText { .. }), "{error:?}");
        assert_eq!(error.to_string(), NOT_TEXT_MESSAGE);
    }

    #[test]
    fn binary_files_are_refused_as_not_text_with_a_readable_message() {
        let docx = docx_like_bytes();
        // Valid zip bytes under a neutral name: detected by content, not extension.
        let (_dir, mut workspace) = workspace_with(&[
            ("report.docx", docx.as_slice()),
            ("archive.data", docx.as_slice()),
            ("latin1.txt", b"caf\xe9 au lait\n".as_slice()),
        ]);
        for path in ["report.docx", "archive.data", "latin1.txt"] {
            assert_not_text(workspace.open_buffer(path).unwrap_err());
            assert_not_text(workspace.peek_buffer(path).unwrap_err());
        }
        // A refused file leaves no buffer behind.
        assert!(matches!(
            workspace.buffer_snapshot("report.docx").unwrap_err(),
            CoreError::BufferNotOpen(_)
        ));
    }

    #[test]
    fn probe_reports_a_typed_binary_kind_with_name_and_size() {
        let docx = docx_like_bytes();
        let (_dir, workspace) = workspace_with(&[
            ("report.docx", docx.as_slice()),
            ("archive.data", docx.as_slice()),
            ("utf16.txt", b"\xff\xfeh\x00i\x00".as_slice()),
            ("notes.txt", b"plain\n".as_slice()),
            ("bom.txt", b"\xef\xbb\xbfwith bom\n".as_slice()),
            ("empty.txt", b"".as_slice()),
        ]);
        let probe = workspace.probe_file("report.docx").unwrap();
        assert_eq!(
            probe,
            FileProbe {
                path: "report.docx".into(),
                name: "report.docx".into(),
                size: docx.len() as u64,
                kind: FileContentKind::Binary,
            }
        );
        let kind = |path: &str| workspace.probe_file(path).unwrap().kind;
        assert_eq!(kind("archive.data"), FileContentKind::Binary);
        assert_eq!(kind("utf16.txt"), FileContentKind::Binary);
        assert_eq!(kind("notes.txt"), FileContentKind::Text);
        assert_eq!(kind("bom.txt"), FileContentKind::Text);
        assert_eq!(kind("empty.txt"), FileContentKind::Text);
        assert_eq!(kind("missing.txt"), FileContentKind::Missing);
    }

    #[test]
    fn text_empty_and_bom_files_still_open_as_before() {
        let (_dir, mut workspace) = workspace_with(&[
            ("notes.txt", b"plain\n".as_slice()),
            ("bom.txt", b"\xef\xbb\xbfwith bom\n".as_slice()),
            ("empty.txt", b"".as_slice()),
        ]);
        assert_eq!(workspace.open_buffer("notes.txt").unwrap().text, "plain\n");
        assert_eq!(
            workspace.open_buffer("bom.txt").unwrap().text,
            "\u{feff}with bom\n"
        );
        assert_eq!(workspace.open_buffer("empty.txt").unwrap().text, "");
        assert_eq!(workspace.open_buffer("new.txt").unwrap().text, "");
    }

    #[test]
    fn invalid_data_io_errors_map_to_not_text() {
        let error = io_error(
            "Read file",
            Path::new("report.docx"),
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "stream did not contain valid UTF-8",
            ),
        );
        assert_not_text(error);
    }

    #[test]
    fn external_open_refuses_scripts_but_allows_documents() {
        let docx = docx_like_bytes();
        let (_dir, workspace) = workspace_with(&[
            ("report.docx", docx.as_slice()),
            ("run.data", b"#!/bin/sh\necho hi\n".as_slice()),
        ]);
        let (path, refusal) = workspace.external_open_target("report.docx").unwrap();
        assert!(path.ends_with("report.docx"));
        assert_eq!(refusal, None);
        assert!(workspace
            .external_open_target("run.data")
            .unwrap()
            .1
            .is_some());
        assert!(workspace.external_open_target("missing.docx").is_err());
    }

    #[test]
    fn viewer_bytes_are_raw_and_bounded() {
        let docx = docx_like_bytes();
        let (_dir, workspace) = workspace_with(&[("report.docx", docx.as_slice())]);
        assert_eq!(
            workspace.read_file_bytes("report.docx", 1 << 20).unwrap(),
            docx
        );
        assert!(workspace.read_file_bytes("report.docx", 8).is_err());
        assert!(workspace
            .read_file_bytes("../outside.docx", 1 << 20)
            .is_err());
    }
}
