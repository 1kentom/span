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
    pub(crate) abandoned_revisions: HashMap<String, u64>,
    pub(crate) proposals: HashMap<String, EditProposal>,
    next_proposal: u64,
    user_settings: Option<PathBuf>,
    settings_buffers: HashMap<crate::SettingsScope, Buffer>,
    settings_only: bool,
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
        let user_settings =
            user_settings_path(std::env::var_os("HOME"), std::env::var_os("USERPROFILE")).ok();
        Ok(Self {
            root,
            buffers: HashMap::new(),
            abandoned_revisions: HashMap::new(),
            proposals: HashMap::new(),
            next_proposal: 1,
            user_settings,
            settings_buffers: HashMap::new(),
            settings_only: false,
        })
    }

    /// Explicit user settings location also makes profiles and tests independent of HOME.
    pub fn with_user_settings(mut self, path: Option<PathBuf>) -> Self {
        self.user_settings = path;
        self
    }

    /// Trusted user preferences only. This context cannot resolve general filesystem paths.
    pub fn for_user_settings() -> Result<Self> {
        let user = user_settings_path(std::env::var_os("HOME"), std::env::var_os("USERPROFILE"))?;
        Ok(Self {
            root: PathBuf::new(),
            buffers: HashMap::new(),
            abandoned_revisions: HashMap::new(),
            proposals: HashMap::new(),
            next_proposal: 1,
            user_settings: Some(user),
            settings_buffers: HashMap::new(),
            settings_only: true,
        })
    }

    /// Cheap immutable rope snapshots let workers scan without holding the editor mutex.
    pub fn search_snapshot(&self) -> crate::search::WorkspaceSearch {
        crate::search::WorkspaceSearch {
            workspace: Self {
                root: self.root.clone(),
                buffers: self.buffers.clone(),
                abandoned_revisions: self.abandoned_revisions.clone(),
                proposals: HashMap::new(),
                next_proposal: 1,
                user_settings: None,
                settings_buffers: HashMap::new(),
                settings_only: self.settings_only,
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
        if self.settings_only || path.starts_with("settings://") {
            return Err(CoreError::OutsideWorkspace(path.to_owned()));
        }
        reject_non_file_path(path)?;
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
            let mut buffer = Buffer::new(text, exists);
            if let Some(revision) = self.abandoned_revisions.remove(&relative) {
                buffer.revision = revision;
                buffer.saved_revision = revision;
            }
            self.buffers.insert(relative.clone(), buffer);
        }
        self.snapshot(&relative)
    }

    /// Reads the current text of a file without opening a buffer: an open buffer is
    /// reported as it is (unsaved edits included), anything else is read from disk and
    /// not retained. For previews, which must have no side effects.
    pub fn peek_buffer(&self, path: &str) -> Result<BufferSnapshot> {
        let resolved = self.resolve(path)?;
        let relative = self.relative(&resolved)?;
        if let Some(buffer) = self.buffers.get(&relative) {
            return Ok(buffer.snapshot(&relative));
        }
        let exists = resolved.exists();
        let text = if exists {
            fs::read_to_string(&resolved).map_err(|e| io_error("Read file", &resolved, e))?
        } else {
            String::new()
        };
        Ok(Buffer::new(text, exists).snapshot(&relative))
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
        self.save_buffer_with_review(path, expected_revision, None)
    }
    pub(crate) fn save_buffer_reviewed(
        &mut self,
        path: &str,
        expected_revision: u64,
        disk_token: &str,
    ) -> Result<BufferSnapshot> {
        self.save_buffer_with_review(path, expected_revision, Some(disk_token))
    }
    fn save_buffer_with_review(
        &mut self,
        path: &str,
        expected_revision: u64,
        reviewed: Option<&str>,
    ) -> Result<BufferSnapshot> {
        let resolved = self.resolve(path)?;
        let relative = self.relative(&resolved)?;
        let settings_user = (relative == ".span/settings.jsonc")
            .then(|| self.get_settings_jsonc_for_scope(crate::SettingsScope::User))
            .transpose()?;
        let buffer = self
            .buffers
            .get_mut(&relative)
            .ok_or_else(|| CoreError::BufferNotOpen(path.into()))?;
        buffer.check_revision(expected_revision)?;
        let disk_bytes = match fs::read(&resolved) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(io_error("Check file before save", &resolved, e)),
        };
        let disk_signature = disk_bytes.as_ref().map(|bytes| signature(bytes));
        if reviewed.map_or_else(
            || disk_signature != buffer.disk_signature,
            |token| crate::external_changes::disk_token(disk_bytes.as_deref()) != token,
        ) {
            return Err(CoreError::SaveConflict(relative));
        }
        let text = buffer.rope.to_string();
        if let Some(user) = settings_user {
            crate::settings::load_with_texts(&user, &text)?;
        }
        atomic_write(&resolved, text.as_bytes())?;
        buffer.disk_signature = Some(signature(text.as_bytes()));
        buffer.mark_saved();
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
        let mut validation = buffer.clone();
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

    fn settings_buffer_snapshot(&self, scope: crate::SettingsScope) -> Result<BufferSnapshot> {
        let mut snapshot = self
            .settings_buffers
            .get(&scope)
            .ok_or_else(|| CoreError::BufferNotOpen(scope.buffer_path().into()))?
            .snapshot(scope.buffer_path());
        snapshot.language = "jsonc".into();
        Ok(snapshot)
    }

    /// Separate trusted UI route. These virtual IDs never enter the agent or filesystem resolver.
    pub fn open_settings_buffer(&mut self, scope: crate::SettingsScope) -> Result<BufferSnapshot> {
        let path = self.settings_path(scope)?;
        let text = self.get_settings_jsonc_for_scope(scope)?;
        let exists = path.exists();
        let disk_signature = exists.then(|| signature(text.as_bytes()));
        let current = self.settings_buffers.get(&scope);
        let refresh = current.is_none_or(|buffer| {
            buffer.revision == buffer.saved_revision && buffer.disk_signature != disk_signature
        });
        if refresh {
            let revision = current
                .map(|buffer| {
                    buffer
                        .revision
                        .checked_add(1)
                        .ok_or_else(|| CoreError::InvalidEdit("revision counter exhausted".into()))
                })
                .transpose()?
                .unwrap_or(0);
            let mut buffer = Buffer::new(text, exists);
            buffer.revision = revision;
            buffer.saved_revision = revision;
            self.settings_buffers.insert(scope, buffer);
        }
        self.settings_buffer_snapshot(scope)
    }

    pub fn edit_settings_buffer(
        &mut self,
        scope: crate::SettingsScope,
        expected_revision: u64,
        changes: Vec<TextEdit>,
    ) -> Result<BufferRevision> {
        let buffer = self
            .settings_buffers
            .get_mut(&scope)
            .ok_or_else(|| CoreError::BufferNotOpen(scope.buffer_path().into()))?;
        buffer.apply(expected_revision, &changes)?;
        Ok(BufferRevision {
            path: scope.buffer_path().into(),
            revision: buffer.revision,
            saved_revision: buffer.saved_revision,
        })
    }

    pub fn save_settings_buffer(
        &mut self,
        scope: crate::SettingsScope,
        expected_revision: u64,
    ) -> Result<BufferSnapshot> {
        let buffer = self
            .settings_buffers
            .get(&scope)
            .ok_or_else(|| CoreError::BufferNotOpen(scope.buffer_path().into()))?;
        buffer.check_revision(expected_revision)?;
        let path = self.settings_path(scope)?;
        let disk_signature = match fs::read(&path) {
            Ok(bytes) => Some(signature(&bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(io_error("Check settings before save", &path, error)),
        };
        if disk_signature != buffer.disk_signature {
            return Err(CoreError::SaveConflict(scope.buffer_path().into()));
        }
        let text = buffer.rope.to_string();
        self.update_settings_jsonc_for_scope(scope, &text)?;
        let buffer = self
            .settings_buffers
            .get_mut(&scope)
            .ok_or_else(|| CoreError::BufferNotOpen(scope.buffer_path().into()))?;
        buffer.disk_signature = Some(signature(text.as_bytes()));
        buffer.mark_saved();
        self.settings_buffer_snapshot(scope)
    }

    pub fn discard_settings_buffer(
        &mut self,
        scope: crate::SettingsScope,
    ) -> Result<BufferSnapshot> {
        let current = self
            .settings_buffers
            .get(&scope)
            .ok_or_else(|| CoreError::BufferNotOpen(scope.buffer_path().into()))?;
        let revision = current
            .revision
            .checked_add(1)
            .ok_or_else(|| CoreError::InvalidEdit("revision counter exhausted".into()))?;
        let text = self.get_settings_jsonc_for_scope(scope)?;
        let mut buffer = Buffer::new(text, self.settings_path(scope)?.exists());
        buffer.revision = revision;
        buffer.saved_revision = revision;
        self.settings_buffers.insert(scope, buffer);
        self.settings_buffer_snapshot(scope)
    }

    pub fn get_settings(&self) -> Result<Settings> {
        if self.settings_only {
            return crate::settings::load_with_texts(
                &self.get_settings_jsonc_for_scope(crate::SettingsScope::User)?,
                "{}",
            );
        }
        let path = if self.root.join(".span").exists() {
            self.resolve(".span/settings.jsonc")?
        } else {
            self.root.join(".span/settings.jsonc")
        };
        crate::settings::load(self.user_settings.as_deref(), &path)
    }

    pub fn get_settings_for_scope(&self, scope: crate::SettingsScope) -> Result<Settings> {
        if self.settings_only && scope == crate::SettingsScope::Workspace {
            return Err(CoreError::Settings(
                "Open a folder before using workspace settings".into(),
            ));
        }
        match scope {
            crate::SettingsScope::User => {
                crate::settings::load_with_texts(&self.get_settings_jsonc_for_scope(scope)?, "{}")
            }
            crate::SettingsScope::Workspace => self.get_settings(),
        }
    }

    fn settings_path(&self, scope: crate::SettingsScope) -> Result<PathBuf> {
        match scope {
            crate::SettingsScope::Workspace if self.settings_only => Err(CoreError::Settings(
                "Open a folder before using workspace settings".into(),
            )),
            crate::SettingsScope::User => self.user_settings.clone().ok_or_else(|| {
                CoreError::Settings("User settings are unavailable for this profile".into())
            }),
            crate::SettingsScope::Workspace if self.root.join(".span").exists() => {
                self.resolve(".span/settings.jsonc")
            }
            crate::SettingsScope::Workspace => Ok(self.root.join(".span/settings.jsonc")),
        }
    }

    pub fn get_settings_jsonc(&self) -> Result<String> {
        self.get_settings_jsonc_for_scope(crate::SettingsScope::Workspace)
    }

    pub fn get_settings_jsonc_for_scope(&self, scope: crate::SettingsScope) -> Result<String> {
        if scope == crate::SettingsScope::User && self.user_settings.is_none() {
            return Ok("{\n}\n".into());
        }
        let path = self.settings_path(scope)?;
        match fs::read_to_string(&path) {
            Ok(text) => Ok(text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("{\n}\n".into()),
            Err(error) => Err(io_error("Read settings", &path, error)),
        }
    }

    pub fn get_settings_keys_for_scope(&self, scope: crate::SettingsScope) -> Result<Vec<String>> {
        let raw = crate::settings::parse(&self.get_settings_jsonc_for_scope(scope)?)?;
        let mut keys: Vec<_> = raw
            .as_object()
            .expect("settings object")
            .keys()
            .filter_map(|key| crate::settings::canonical_key(key))
            .collect();
        keys.sort();
        keys.dedup();
        Ok(keys)
    }

    pub fn update_settings_jsonc(&self, text: &str) -> Result<Settings> {
        self.update_settings_jsonc_for_scope(crate::SettingsScope::Workspace, text)
    }

    pub fn update_settings_jsonc_for_scope(
        &self,
        scope: crate::SettingsScope,
        text: &str,
    ) -> Result<Settings> {
        // Validate the edited scope independently so a narrower override cannot hide invalid data.
        crate::settings::load_with_texts(text, "{}")?;
        crate::settings::reject_new_unknown_nested(
            &self.get_settings_jsonc_for_scope(scope)?,
            text,
        )?;
        if scope == crate::SettingsScope::Workspace {
            // Workspace files may not choose executables or trigger downloads. A key the
            // file already holds is ignored on read, so it does not block other writes.
            let previous = self.get_settings_jsonc_for_scope(scope)?;
            crate::settings::reject_changed_user_only(&previous, text)?;
        }
        let user = if scope == crate::SettingsScope::User {
            text.to_owned()
        } else {
            self.get_settings_jsonc_for_scope(crate::SettingsScope::User)?
        };
        let workspace = if self.settings_only {
            "{}".into()
        } else if scope == crate::SettingsScope::Workspace {
            text.to_owned()
        } else {
            self.get_settings_jsonc()?
        };
        let merged = crate::settings::load_with_texts(&user, &workspace)?;
        let path = self.settings_path(scope)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| io_error("Create settings directory", parent, error))?;
        }
        // Resolve again after directory creation to retain the workspace path boundary checks.
        let path = self.settings_path(scope)?;
        atomic_write(&path, text.as_bytes())?;
        Ok(merged)
    }

    pub fn update_setting(
        &self,
        scope: crate::SettingsScope,
        key: &str,
        value_json: Option<&str>,
    ) -> Result<Settings> {
        let text = self.get_settings_jsonc_for_scope(scope)?;
        let patched = crate::settings::patch_in_scope(scope, &text, key, value_json)?;
        self.update_settings_jsonc_for_scope(scope, &patched)
    }

    pub fn update_settings(&self, settings: Settings) -> Result<Settings> {
        settings.validate()?;
        // User-only keys would be ignored on read, so they are not written
        // into the workspace file either.
        let before = serde_json::to_value(self.get_settings()?)
            .map(crate::settings::without_user_only)
            .map_err(|error| CoreError::Settings(error.to_string()))?;
        let after = serde_json::to_value(settings)
            .map(crate::settings::without_user_only)
            .map_err(|error| CoreError::Settings(error.to_string()))?;
        let mut text = self.get_settings_jsonc()?;
        // A user-only key already present in the workspace file is rewritten
        // out as well, so a typed save never keeps one there.
        let raw = crate::settings::parse(&text)?;
        let raw_allowed = crate::settings::without_user_only(raw.clone());
        for (key, value) in after.as_object().expect("settings object") {
            // `without_user_only` also drops the languageServers user-only keys, so
            // neither kind of user-only key is written into the workspace file.
            if before.get(key) != Some(value) || raw.get(key) != raw_allowed.get(key) {
                // Keys a newer build stored in a nested object survive the rewrite.
                let mut value = value.clone();
                crate::settings::keep_unknown_nested(&raw_allowed, key, &mut value);
                text = crate::settings::patch(&text, key, Some(&value.to_string()))?;
            }
        }
        self.update_settings_jsonc(&text)
    }
}

/// True for text that starts with a URI scheme of two or more characters, which keeps
/// Windows drive letters (`C:` followed by a backslash) out of it. Only a scheme followed by `/`
/// or a well known library scheme counts, so a file named `notes:v2.txt` stays openable.
fn has_uri_scheme(path: &str) -> bool {
    let Some((scheme, rest)) = path.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    let shaped = scheme.len() >= 2
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    let known = [
        "jdt", "jar", "file", "zip", "http", "https", "untitled", "data",
    ]
    .iter()
    .any(|known| scheme.eq_ignore_ascii_case(known));
    shaped && (rest.starts_with('/') || known)
}

/// Library sources (`jdt://contents/...`, `jar:file:...`) are not files of the project. They
/// must never be joined onto the workspace root, so they are refused before any path work.
fn reject_non_file_path(path: &str) -> Result<()> {
    if path.contains('\0') {
        return Err(CoreError::InvalidPath);
    }
    if path.contains("://") || has_uri_scheme(path) {
        return Err(CoreError::LibrarySource(path.to_owned()));
    }
    Ok(())
}

/// Writes `bytes` to a temp file beside `path`, flushes it and renames it over `path`.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
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

fn user_settings_path(
    home: Option<std::ffi::OsString>,
    user_profile: Option<std::ffi::OsString>,
) -> Result<PathBuf> {
    home.filter(|path| !path.is_empty())
        .or_else(|| user_profile.filter(|path| !path.is_empty()))
        .map(PathBuf::from)
        .map(|path| path.join(".config/span/settings.jsonc"))
        .ok_or_else(|| CoreError::Settings("User profile directory is unavailable".into()))
}

#[cfg(test)]
mod profile_tests {
    use super::*;
    #[test]
    fn userprofile_is_used_when_windows_does_not_provide_home() {
        let profile = PathBuf::from("profile-fixture");
        assert_eq!(
            user_settings_path(None, Some(profile.clone().into_os_string())).unwrap(),
            profile.join(".config/span/settings.jsonc")
        );
        assert_eq!(
            user_settings_path(Some("".into()), Some(profile.clone().into_os_string())).unwrap(),
            profile.join(".config/span/settings.jsonc")
        );
        assert_eq!(
            user_settings_path(Some("home-fixture".into()), Some(profile.into_os_string()))
                .unwrap(),
            PathBuf::from("home-fixture").join(".config/span/settings.jsonc")
        );
        assert!(user_settings_path(None, None).is_err());
    }
}
