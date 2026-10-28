use crate::buffer::{signature, Buffer};
use crate::{
    io_error, BufferRevision, BufferSnapshot, CoreError, EditProposal, ProposalHunk, Result,
    Settings, TextEdit,
};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub root: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

/// Place behind the desktop's mutex. No disk or text state belongs in the renderer.
pub struct CoreWorkspace {
    pub(crate) root: PathBuf,
    pub(crate) buffers: HashMap<String, Buffer>,
    proposals: HashMap<String, EditProposal>,
    next_proposal: u64,
    user_settings: Option<PathBuf>,
}

impl CoreWorkspace {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let root = path
            .canonicalize()
            .map_err(|e| io_error("Open workspace", path, e))?;
        if !root.is_dir() {
            return Err(CoreError::InvalidEdit(format!(
                "Workspace is not a directory: {}",
                root.display()
            )));
        }
        let user_settings = std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|p| p.join(".config/span/settings.jsonc"));
        Ok(Self {
            root,
            buffers: HashMap::new(),
            proposals: HashMap::new(),
            next_proposal: 1,
            user_settings,
        })
    }

    /// Explicit user settings location also makes profiles and tests independent of HOME.
    pub fn with_user_settings(mut self, path: Option<PathBuf>) -> Self {
        self.user_settings = path;
        self
    }

    /// Cheap immutable rope snapshots let workers scan without holding the editor mutex.
    pub fn search_snapshot(&self) -> crate::search::WorkspaceSearch {
        crate::search::WorkspaceSearch {
            workspace: Self {
                root: self.root.clone(),
                buffers: self.buffers.clone(),
                proposals: HashMap::new(),
                next_proposal: 1,
                user_settings: None,
            },
        }
    }

    pub fn workspace(&self) -> Workspace {
        Workspace {
            root: self.root.display().to_string(),
            name: self
                .root
                .file_name()
                .map_or_else(String::new, |name| name.to_string_lossy().into_owned()),
        }
    }

    /// Resolve existing paths and new files by their canonical parent. Symlinks cannot escape root.
    pub(crate) fn resolve(&self, path: &str) -> Result<PathBuf> {
        let requested = Path::new(path);
        if requested
            .components()
            .any(|c| matches!(c, Component::ParentDir))
        {
            return Err(CoreError::OutsideWorkspace(path.to_owned()));
        }
        let joined = if requested.is_absolute() {
            requested.to_owned()
        } else {
            self.root.join(requested)
        };
        let resolved = if joined.exists() || joined.symlink_metadata().is_ok() {
            joined
                .canonicalize()
                .map_err(|e| io_error("Resolve path", &joined, e))?
        } else {
            let parent = joined
                .parent()
                .ok_or_else(|| CoreError::OutsideWorkspace(path.into()))?;
            let parent = parent
                .canonicalize()
                .map_err(|e| io_error("Resolve parent", parent, e))?;
            let name = joined
                .file_name()
                .ok_or_else(|| CoreError::OutsideWorkspace(path.into()))?;
            parent.join(name)
        };
        if !resolved.starts_with(&self.root) {
            return Err(CoreError::OutsideWorkspace(path.into()));
        }
        Ok(resolved)
    }

    pub(crate) fn relative(&self, path: &Path) -> Result<String> {
        path.strip_prefix(&self.root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .map_err(|_| CoreError::OutsideWorkspace(path.display().to_string()))
    }

    pub fn list_directory(&self, path: &str) -> Result<Vec<FileEntry>> {
        let directory = self.resolve(path)?;
        self.walk(&directory, Some(1))
    }

    pub fn list_files(&self) -> Result<Vec<FileEntry>> {
        Ok(self
            .walk(&self.root, None)?
            .into_iter()
            .filter(|f| !f.is_dir)
            .collect())
    }

    pub(crate) fn scan_directory(&self, path: &Path) -> Result<PathBuf> {
        let resolved = self.resolve(&path.to_string_lossy())?;
        let metadata = fs::metadata(&resolved)
            .map_err(|error| io_error("Read directory", &resolved, error))?;
        if !metadata.is_dir() {
            return Err(CoreError::InvalidEdit(format!(
                "Not a directory: {}",
                resolved.display()
            )));
        }
        // An unreadable or removed scan root is an actionable error, unlike a stale child entry.
        fs::read_dir(&resolved).map_err(|error| io_error("Read directory", &resolved, error))?;
        Ok(resolved)
    }

    pub(crate) fn scan_entry(&self, path: &Path) -> Option<(PathBuf, fs::Metadata)> {
        // Entries may disappear or become dangling links after the walker observed them.
        // Canonicalization is still mandatory before exposing any entry or reading its content.
        let resolved = path.canonicalize().ok()?;
        if !resolved.starts_with(&self.root) {
            return None;
        }
        let metadata = fs::metadata(&resolved).ok()?;
        Some((resolved, metadata))
    }

    fn walk(&self, root: &Path, depth: Option<usize>) -> Result<Vec<FileEntry>> {
        let root = self.scan_directory(root)?;
        let mut entries = Vec::new();
        // require_git(false) applies .gitignore in folders without a .git directory too.
        let walker = WalkBuilder::new(&root)
            .hidden(false)
            .git_ignore(true)
            .git_exclude(true)
            .require_git(false)
            .follow_links(false)
            .max_depth(depth)
            .filter_entry(visible_scan_entry)
            .build();
        for entry in walker {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) if error.depth() == Some(0) => {
                    return Err(CoreError::Search(format!(
                        "Walk {}: {error}",
                        root.display()
                    )));
                }
                Err(_) => continue,
            };
            if entry.depth() == 0 || entry.file_name() == ".git" {
                continue;
            }
            let Some((_, metadata)) = self.scan_entry(entry.path()) else {
                continue;
            };
            let is_dir = metadata.is_dir();
            entries.push(FileEntry {
                path: self.relative(entry.path())?,
                name: entry.file_name().to_string_lossy().into_owned(),
                is_dir,
            });
        }
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.path.to_lowercase().cmp(&b.path.to_lowercase()))
        });
        Ok(entries)
    }

    pub fn open_buffer(&mut self, path: &str) -> Result<BufferSnapshot> {
        let resolved = self.resolve(path)?;
        let relative = self.relative(&resolved)?;
        if !self.buffers.contains_key(&relative) {
            let exists = resolved.exists();
            let text = if exists {
                fs::read_to_string(&resolved).map_err(|e| io_error("Read file", &resolved, e))?
            } else {
                String::new()
            };
            self.buffers
                .insert(relative.clone(), Buffer::new(text, exists));
        }
        self.snapshot(&relative)
    }

    pub fn buffer_snapshot(&self, path: &str) -> Result<BufferSnapshot> {
        let relative = self.relative(&self.resolve(path)?)?;
        self.snapshot(&relative)
    }

    pub fn buffer_snapshot_bounded(&self, path: &str, max_bytes: usize) -> Result<BufferSnapshot> {
        let relative = self.relative(&self.resolve(path)?)?;
        let buffer = self
            .buffers
            .get(&relative)
            .ok_or_else(|| CoreError::BufferNotOpen(path.into()))?;
        if buffer.rope.len_bytes() > max_bytes {
            return Err(CoreError::InvalidEdit(format!(
                "Syntax snapshot exceeds {max_bytes} byte limit"
            )));
        }
        Ok(buffer.snapshot(&relative))
    }

    fn snapshot(&self, path: &str) -> Result<BufferSnapshot> {
        self.buffers
            .get(path)
            .map(|b| b.snapshot(path))
            .ok_or_else(|| CoreError::BufferNotOpen(path.into()))
    }

    pub fn edit_buffer(
        &mut self,
        path: &str,
        expected_revision: u64,
        changes: Vec<TextEdit>,
    ) -> Result<BufferSnapshot> {
        let revision = self.edit_buffer_delta(path, expected_revision, changes)?;
        self.snapshot(&revision.path)
    }

    pub fn edit_buffer_delta(
        &mut self,
        path: &str,
        expected_revision: u64,
        changes: Vec<TextEdit>,
    ) -> Result<BufferRevision> {
        let relative = self.relative(&self.resolve(path)?)?;
        let buffer = self
            .buffers
            .get_mut(&relative)
            .ok_or_else(|| CoreError::BufferNotOpen(path.into()))?;
        buffer.apply(expected_revision, &changes)?;
        Ok(BufferRevision {
            path: relative,
            revision: buffer.revision,
            saved_revision: buffer.saved_revision,
        })
    }

    /// Reload is explicit and advances the revision so in-flight edits cannot overwrite it.
    pub fn discard_buffer(&mut self, path: &str) -> Result<BufferSnapshot> {
        let resolved = self.resolve(path)?;
        let relative = self.relative(&resolved)?;
        let current = self
            .buffers
            .get(&relative)
            .ok_or_else(|| CoreError::BufferNotOpen(path.into()))?;
        let revision = current
            .revision
            .checked_add(1)
            .ok_or_else(|| CoreError::InvalidEdit("revision counter exhausted".into()))?;
        let exists = resolved.exists();
        let text = if exists {
            fs::read_to_string(&resolved).map_err(|e| io_error("Reload file", &resolved, e))?
        } else {
            String::new()
        };
        let mut buffer = Buffer::new(text, exists);
        buffer.revision = revision;
        buffer.saved_revision = revision;
        self.buffers.insert(relative.clone(), buffer);
        self.snapshot(&relative)
    }

    pub fn save_buffer(&mut self, path: &str, expected_revision: u64) -> Result<BufferSnapshot> {
        let resolved = self.resolve(path)?;
        let relative = self.relative(&resolved)?;
        let buffer = self
            .buffers
            .get_mut(&relative)
            .ok_or_else(|| CoreError::BufferNotOpen(path.into()))?;
        buffer.check_revision(expected_revision)?;
        let disk_signature = match fs::read(&resolved) {
            Ok(bytes) => Some(signature(&bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(io_error("Check file before save", &resolved, e)),
        };
        if disk_signature != buffer.disk_signature {
            return Err(CoreError::SaveConflict(relative));
        }
        let text = buffer.rope.to_string();
        atomic_write(&resolved, text.as_bytes())?;
        buffer.disk_signature = Some(signature(text.as_bytes()));
        buffer.saved_revision = buffer.revision;
        self.snapshot(&relative)
    }

    pub fn agent_read(&mut self, path: &str) -> Result<BufferSnapshot> {
        self.open_buffer(path)
    }

    pub fn stage_proposal(
        &mut self,
        path: &str,
        expected_revision: u64,
        text: String,
    ) -> Result<EditProposal> {
        let current = self.open_buffer(path)?;
        if current.revision != expected_revision {
            return Err(CoreError::StaleRevision {
                expected: expected_revision,
                actual: current.revision,
            });
        }
        let edits = crate::proposal_diff::line_edits(&current.text, &text)?;
        self.stage_edit_proposal(path, expected_revision, edits)
    }

    pub fn stage_edit_proposal(
        &mut self,
        path: &str,
        expected_revision: u64,
        edits: Vec<TextEdit>,
    ) -> Result<EditProposal> {
        let snapshot = self.open_buffer(path)?;
        let buffer = self
            .buffers
            .get(&snapshot.path)
            .ok_or_else(|| CoreError::BufferNotOpen(path.into()))?;
        buffer.check_revision(expected_revision)?;
        // Validate transaction on a cheap rope clone before publishing a review.
        let mut validation = Buffer {
            rope: buffer.rope.clone(),
            revision: buffer.revision,
            saved_revision: buffer.saved_revision,
            disk_signature: buffer.disk_signature,
        };
        validation.apply(expected_revision, &edits)?;
        let id = format!("proposal-{}", self.next_proposal);
        self.next_proposal += 1;
        let mut hunks = Vec::new();
        for (index, edit) in edits.into_iter().enumerate() {
            let from = buffer.rope.utf16_cu_to_char(edit.from as usize);
            let to = buffer.rope.utf16_cu_to_char(edit.to as usize);
            hunks.push(ProposalHunk {
                id: format!("{id}-{index}"),
                from: edit.from,
                to: edit.to,
                before: buffer.rope.slice(from..to).to_string(),
                after: edit.insert,
            });
        }
        let proposal = EditProposal {
            id: id.clone(),
            path: snapshot.path,
            base_revision: expected_revision,
            hunks,
        };
        self.proposals.insert(id, proposal.clone());
        Ok(proposal)
    }

    pub fn resolve_proposal(
        &mut self,
        id: &str,
        accept: bool,
        expected_revision: u64,
    ) -> Result<BufferSnapshot> {
        let proposal = self
            .proposals
            .get(id)
            .ok_or_else(|| CoreError::UnknownProposal(id.into()))?;
        let accepted: Vec<String> = if accept {
            proposal.hunks.iter().map(|hunk| hunk.id.clone()).collect()
        } else {
            Vec::new()
        };
        self.resolve_proposal_hunks(id, &accepted, expected_revision)
    }

    /// Resolve a review atomically: selected hunks are accepted, all others rejected.
    pub fn resolve_proposal_hunks(
        &mut self,
        id: &str,
        accepted_hunk_ids: &[String],
        expected_revision: u64,
    ) -> Result<BufferSnapshot> {
        let proposal = self
            .proposals
            .get(id)
            .cloned()
            .ok_or_else(|| CoreError::UnknownProposal(id.into()))?;
        for accepted in accepted_hunk_ids {
            if !proposal.hunks.iter().any(|hunk| &hunk.id == accepted) {
                return Err(CoreError::InvalidEdit(format!(
                    "Unknown hunk {accepted} in {id}"
                )));
            }
        }
        let current = self.buffer_snapshot(&proposal.path)?;
        if !accepted_hunk_ids.is_empty() && current.revision != expected_revision {
            return Err(CoreError::StaleRevision {
                expected: expected_revision,
                actual: current.revision,
            });
        }
        let changes: Vec<TextEdit> = proposal
            .hunks
            .iter()
            .filter(|hunk| accepted_hunk_ids.contains(&hunk.id))
            .map(|hunk| TextEdit {
                from: hunk.from,
                to: hunk.to,
                insert: hunk.after.clone(),
            })
            .collect();
        let snapshot = if changes.is_empty() {
            current
        } else {
            self.edit_buffer(&proposal.path, proposal.base_revision, changes)?
        };
        self.proposals.remove(id);
        Ok(snapshot)
    }

    pub fn get_settings(&self) -> Result<Settings> {
        let path = if self.root.join(".span").exists() {
            self.resolve(".span/settings.jsonc")?
        } else {
            self.root.join(".span/settings.jsonc")
        };
        crate::settings::load(self.user_settings.as_deref(), &path)
    }

    pub fn update_settings_jsonc(&self, text: &str) -> Result<Settings> {
        let merged =
            crate::settings::load_with_workspace_text(self.user_settings.as_deref(), text)?;
        let directory = self.root.join(".span");
        if !directory.exists() {
            fs::create_dir(&directory)
                .map_err(|e| io_error("Create settings directory", &directory, e))?;
        }
        let path = self.resolve(".span/settings.jsonc")?;
        atomic_write(&path, text.as_bytes())?;
        Ok(merged)
    }

    pub fn update_settings(&self, settings: Settings) -> Result<Settings> {
        settings.validate()?;
        let directory = self.root.join(".span");
        if !directory.exists() {
            fs::create_dir(&directory)
                .map_err(|e| io_error("Create settings directory", &directory, e))?;
        }
        let path = self.resolve(".span/settings.jsonc")?;
        let text = serde_json::to_string_pretty(&settings)
            .map_err(|e| CoreError::Settings(e.to_string()))?;
        atomic_write(&path, text.as_bytes())?;
        self.get_settings()
    }
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| CoreError::OutsideWorkspace(path.display().to_string()))?;
    let name = path
        .file_name()
        .ok_or_else(|| CoreError::OutsideWorkspace(path.display().to_string()))?;
    let temp = parent.join(format!(
        ".{}.span-{}-{}",
        name.to_string_lossy(),
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| io_error("Create atomic save", &temp, e))?;
        if let Ok(metadata) = fs::metadata(path) {
            file.set_permissions(metadata.permissions())
                .map_err(|e| io_error("Preserve permissions", &temp, e))?;
        }
        file.write_all(bytes)
            .map_err(|e| io_error("Write atomic save", &temp, e))?;
        file.sync_all()
            .map_err(|e| io_error("Flush atomic save", &temp, e))?;
        drop(file);
        fs::rename(&temp, path).map_err(|e| io_error("Replace saved file", path, e))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Dependency directories are excluded by default, while a regular file with that name remains visible.
pub(crate) fn visible_scan_entry(entry: &ignore::DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    if entry.file_name() == ".git" {
        return false;
    }
    !(entry.file_name() == "node_modules"
        && entry
            .file_type()
            .is_some_and(|kind| kind.is_dir() || kind.is_symlink()))
}

#[cfg(test)]
mod scan_tests {
    use super::CoreWorkspace;
    use std::fs;

    #[test]
    fn stale_child_entry_is_skipped_after_observation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("removed-directory");
        fs::create_dir(&path).unwrap();
        let observed = fs::read_dir(root.path()).unwrap().next().unwrap().unwrap();
        let workspace = CoreWorkspace::open(root.path()).unwrap();
        fs::remove_dir(path).unwrap();
        assert!(workspace.scan_entry(&observed.path()).is_none());
    }
}
