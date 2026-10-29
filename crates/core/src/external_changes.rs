//! Reconcile disk changes without discarding unsaved editor content.
use crate::{
    buffer::{signature, Buffer},
    io_error, BufferSnapshot, CoreError, CoreWorkspace, Result,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{fs, io::ErrorKind};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalFileCheck {
    pub path: String,
    pub expected_revision: u64,
    /// False while the renderer has an edit not yet acknowledged by core.
    pub allow_reload: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalDiskSnapshot {
    pub token: String,
    pub exists: bool,
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExternalFileKind {
    Unchanged,
    Reloaded,
    Conflict,
    Deleted,
    Stale,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalFileState {
    pub path: String,
    pub revision: u64,
    pub kind: ExternalFileKind,
    pub snapshot: Option<BufferSnapshot>,
    pub disk: Option<ExternalDiskSnapshot>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ExternalFileResolution {
    Reload,
    Overwrite,
}

pub(crate) fn disk_token(bytes: Option<&[u8]>) -> String {
    bytes.map_or_else(
        || "missing".into(),
        |bytes| format!("{}:{:016x}", bytes.len(), signature(bytes)),
    )
}

impl CoreWorkspace {
    /// Explicitly discard a retained editor buffer without reading or writing
    /// an unavailable disk file. Preserve a revision tombstone for later opens.
    pub fn abandon_external_file(&mut self, path: &str, expected_revision: u64) -> Result<()> {
        let requested = std::path::Path::new(path);
        if requested.is_absolute()
            || requested
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err(CoreError::OutsideWorkspace(path.into()));
        }
        // This operation only releases a tracked key. Do not follow a newly
        // replaced symlink or touch the current disk target.
        let relative = path.replace('\\', "/");
        let Some(buffer) = self.buffers.get(&relative) else {
            if expected_revision
                .checked_add(1)
                .is_some_and(|next| self.abandoned_revisions.get(&relative) == Some(&next))
            {
                return Ok(());
            }
            return Err(CoreError::BufferNotOpen(relative));
        };
        buffer.check_revision(expected_revision)?;
        let next = expected_revision
            .checked_add(1)
            .ok_or_else(|| CoreError::InvalidEdit("revision counter exhausted".into()))?;
        self.abandoned_revisions.insert(relative.clone(), next);
        self.buffers.remove(&relative);
        self.proposals
            .retain(|_, proposal| proposal.path != relative);
        Ok(())
    }
    pub fn check_external_files(
        &mut self,
        checks: &[ExternalFileCheck],
    ) -> Result<Vec<ExternalFileState>> {
        if checks.len() > 256 {
            return Err(CoreError::InvalidEdit(
                "External checks are limited to 256 files per request".into(),
            ));
        }
        Ok(checks
            .iter()
            .map(|check| {
                let mut state = ExternalFileState {
                    path: check.path.clone(),
                    revision: check.expected_revision,
                    kind: ExternalFileKind::Unchanged,
                    snapshot: None,
                    disk: None,
                    error: None,
                };
                if let Err(error) = self.check_external_file(check, &mut state) {
                    state.kind = ExternalFileKind::Unavailable;
                    state.error = Some(error.to_string());
                }
                state
            })
            .collect())
    }

    fn check_external_file(
        &mut self,
        check: &ExternalFileCheck,
        state: &mut ExternalFileState,
    ) -> Result<()> {
        let resolved = self.resolve(&check.path)?;
        let relative = self.relative(&resolved)?;
        let buffer = self
            .buffers
            .get(&relative)
            .ok_or_else(|| CoreError::BufferNotOpen(relative.clone()))?;
        if buffer.revision != check.expected_revision {
            state.kind = ExternalFileKind::Stale;
            return Ok(());
        }
        let bytes = match fs::read(&resolved) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => return Err(io_error("Check externally changed file", &resolved, error)),
        };
        let current_signature = bytes.as_ref().map(|bytes| signature(bytes));
        if current_signature == buffer.disk_signature {
            return Ok(());
        }
        let mut text = bytes
            .as_deref()
            .map(|bytes| String::from_utf8_lossy(&bytes[..bytes.len().min(65_536)]))
            .unwrap_or_default()
            .into_owned();
        let truncated =
            bytes.as_ref().is_some_and(|bytes| bytes.len() > 65_536) || text.len() > 65_536;
        if truncated {
            let mut end = 65_536;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }
        state.disk = Some(ExternalDiskSnapshot {
            token: disk_token(bytes.as_deref()),
            exists: bytes.is_some(),
            text,
            truncated,
        });
        if let Some(bytes) = bytes.as_deref() {
            if std::str::from_utf8(bytes).is_err() {
                state.error = Some("The disk file is not UTF-8. The preview replaces invalid bytes; reload is unavailable. Your retained editor text can explicitly overwrite the reviewed file.".into());
            } else if check.allow_reload && buffer.revision == buffer.saved_revision {
                let text = String::from_utf8(bytes.to_vec()).expect("UTF-8 checked above");
                let revision = buffer
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| CoreError::InvalidEdit("revision counter exhausted".into()))?;
                let mut next = Buffer::new(text, true);
                next.revision = revision;
                next.saved_revision = revision;
                let snapshot = next.snapshot(&relative);
                self.buffers.insert(relative, next);
                state.kind = ExternalFileKind::Reloaded;
                state.snapshot = Some(snapshot);
                return Ok(());
            }
        }
        state.kind = if bytes.is_some() {
            ExternalFileKind::Conflict
        } else {
            ExternalFileKind::Deleted
        };
        Ok(())
    }

    pub fn resolve_external_file(
        &mut self,
        path: &str,
        expected_revision: u64,
        reviewed_disk_token: &str,
        resolution: ExternalFileResolution,
    ) -> Result<BufferSnapshot> {
        let resolved = self.resolve(path)?;
        let relative = self.relative(&resolved)?;
        self.buffers
            .get(&relative)
            .ok_or_else(|| CoreError::BufferNotOpen(relative.clone()))?
            .check_revision(expected_revision)?;
        let bytes = match fs::read(&resolved) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => {
                return Err(io_error(
                    "Review external file resolution",
                    &resolved,
                    error,
                ))
            }
        };
        if disk_token(bytes.as_deref()) != reviewed_disk_token {
            return Err(CoreError::SaveConflict(relative));
        }
        match resolution {
            ExternalFileResolution::Overwrite => {
                self.save_buffer_reviewed(path, expected_revision, reviewed_disk_token)
            }
            ExternalFileResolution::Reload => {
                let bytes = bytes.ok_or_else(|| {
                    CoreError::InvalidEdit(
                        "The file was deleted. Keep the retained text or explicitly recreate it."
                            .into(),
                    )
                })?;
                let text = String::from_utf8(bytes).map_err(|_| {
                    CoreError::InvalidEdit(
                        "The external file is not UTF-8. Your draft was preserved.".into(),
                    )
                })?;
                let revision = expected_revision
                    .checked_add(1)
                    .ok_or_else(|| CoreError::InvalidEdit("revision counter exhausted".into()))?;
                let mut next = Buffer::new(text, true);
                next.revision = revision;
                next.saved_revision = revision;
                let snapshot = next.snapshot(&relative);
                self.buffers.insert(relative, next);
                Ok(snapshot)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TextEdit;
    fn fixture() -> (tempfile::TempDir, CoreWorkspace) {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("file.txt"), "original").unwrap();
        let mut workspace = CoreWorkspace::open(directory.path()).unwrap();
        workspace.open_buffer("file.txt").unwrap();
        (directory, workspace)
    }
    fn check(workspace: &mut CoreWorkspace, allow_reload: bool) -> ExternalFileState {
        let revision = workspace.buffer_snapshot("file.txt").unwrap().revision;
        workspace
            .check_external_files(&[ExternalFileCheck {
                path: "file.txt".into(),
                expected_revision: revision,
                allow_reload,
            }])
            .unwrap()
            .remove(0)
    }
    #[test]
    fn clean_external_change_reloads_but_dirty_or_pending_edits_are_preserved() {
        let (directory, mut workspace) = fixture();
        fs::write(directory.path().join("file.txt"), "external").unwrap();
        let state = check(&mut workspace, true);
        assert_eq!(state.kind, ExternalFileKind::Reloaded);
        assert_eq!(state.snapshot.unwrap().text, "external");
        let revision = workspace.buffer_snapshot("file.txt").unwrap().revision;
        workspace
            .edit_buffer(
                "file.txt",
                revision,
                vec![TextEdit {
                    from: 0,
                    to: 0,
                    insert: "draft ".into(),
                }],
            )
            .unwrap();
        fs::write(directory.path().join("file.txt"), "new disk").unwrap();
        assert_eq!(check(&mut workspace, true).kind, ExternalFileKind::Conflict);
        assert_eq!(
            workspace.buffer_snapshot("file.txt").unwrap().text,
            "draft external"
        );
        let (_pending_directory, mut pending) = fixture();
        fs::write(pending.root.join("file.txt"), "new disk").unwrap();
        assert_eq!(check(&mut pending, false).kind, ExternalFileKind::Conflict);
    }
    #[test]
    fn reviewed_overwrite_rejects_new_disk_content_and_stale_editor_revisions() {
        let (directory, mut workspace) = fixture();
        fs::write(directory.path().join("file.txt"), "outside").unwrap();
        let token = check(&mut workspace, false).disk.unwrap().token;
        fs::write(directory.path().join("file.txt"), "newer").unwrap();
        assert!(workspace
            .resolve_external_file("file.txt", 0, &token, ExternalFileResolution::Overwrite)
            .is_err());
        assert_eq!(
            fs::read_to_string(directory.path().join("file.txt")).unwrap(),
            "newer"
        );
        let token = check(&mut workspace, false).disk.unwrap().token;
        let saved = workspace
            .resolve_external_file("file.txt", 0, &token, ExternalFileResolution::Overwrite)
            .unwrap();
        assert_eq!(saved.text, "original");
        assert_eq!(
            fs::read_to_string(directory.path().join("file.txt")).unwrap(),
            "original"
        );
        assert!(workspace
            .resolve_external_file("file.txt", 99, &token, ExternalFileResolution::Reload)
            .is_err());
    }
    #[test]
    fn deleted_files_and_stale_checks_never_drop_the_retained_buffer() {
        let (directory, mut workspace) = fixture();
        fs::remove_file(directory.path().join("file.txt")).unwrap();
        assert_eq!(check(&mut workspace, true).kind, ExternalFileKind::Deleted);
        let state = workspace
            .check_external_files(&[ExternalFileCheck {
                path: "file.txt".into(),
                expected_revision: 99,
                allow_reload: true,
            }])
            .unwrap()
            .remove(0);
        assert_eq!(state.kind, ExternalFileKind::Stale);
        assert_eq!(
            workspace.buffer_snapshot("file.txt").unwrap().text,
            "original"
        );
        let saved = workspace
            .resolve_external_file("file.txt", 0, "missing", ExternalFileResolution::Overwrite)
            .unwrap();
        assert_eq!(saved.text, "original");
    }
    #[test]
    fn invalid_utf8_keeps_a_review_token_for_explicit_overwrite() {
        let (directory, mut workspace) = fixture();
        fs::write(directory.path().join("file.txt"), [0xff, 0xfe, 0x00]).unwrap();
        let change = check(&mut workspace, true);
        assert_eq!(change.kind, ExternalFileKind::Conflict);
        assert!(change.error.as_deref().unwrap().contains("not UTF-8"));
        let disk = change.disk.unwrap();
        assert!(workspace
            .resolve_external_file("file.txt", 0, &disk.token, ExternalFileResolution::Reload)
            .is_err());
        assert_eq!(
            workspace.buffer_snapshot("file.txt").unwrap().text,
            "original"
        );
        workspace
            .resolve_external_file(
                "file.txt",
                0,
                &disk.token,
                ExternalFileResolution::Overwrite,
            )
            .unwrap();
        assert_eq!(
            fs::read_to_string(directory.path().join("file.txt")).unwrap(),
            "original"
        );
    }
    #[test]
    fn explicit_abandon_never_reads_or_writes_disk_and_preserves_revision_order() {
        let (directory, mut workspace) = fixture();
        fs::write(directory.path().join("file.txt"), [0xff]).unwrap();
        assert!(workspace.abandon_external_file("file.txt", 99).is_err());
        workspace.abandon_external_file("file.txt", 0).unwrap();
        workspace.abandon_external_file("file.txt", 0).unwrap();
        assert_eq!(fs::read(directory.path().join("file.txt")).unwrap(), [0xff]);
        assert!(workspace.open_buffer("file.txt").is_err());
        fs::write(directory.path().join("file.txt"), "available").unwrap();
        let reopened = workspace.open_buffer("file.txt").unwrap();
        assert_eq!(reopened.text, "available");
        assert!(reopened.revision > 0);
    }
    #[cfg(unix)]
    #[test]
    fn abandoning_an_escaping_replacement_symlink_only_releases_the_tracked_buffer() {
        let (directory, mut workspace) = fixture();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("private.txt");
        fs::write(&target, "outside private").unwrap();
        fs::remove_file(directory.path().join("file.txt")).unwrap();
        std::os::unix::fs::symlink(&target, directory.path().join("file.txt")).unwrap();
        let change = workspace
            .check_external_files(&[ExternalFileCheck {
                path: "file.txt".into(),
                expected_revision: 0,
                allow_reload: true,
            }])
            .unwrap()
            .remove(0);
        assert_eq!(change.kind, ExternalFileKind::Unavailable);
        workspace.abandon_external_file("file.txt", 0).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "outside private");
        assert!(workspace
            .abandon_external_file("../private.txt", 0)
            .is_err());
    }
}
