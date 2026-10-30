//! Explicit user file operations. Agent writes continue to use reviewed buffer proposals.
use crate::{
    io_error, BufferSnapshot, CancellationToken, CoreError, CoreWorkspace, FileEntry, Result,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static COPY_ID: AtomicU64 = AtomicU64::new(1);
const MAX_COPY_ENTRIES: usize = 10_000;
const MAX_COPY_BYTES: u64 = 64 * 1024 * 1024;
/// Most entries (files and folders) one import may copy.
pub const MAX_IMPORT_ENTRIES: usize = 10_000;
/// Most bytes one import may copy.
pub const MAX_IMPORT_BYTES: u64 = 1024 * 1024 * 1024;
/// Deepest folder nesting an import follows.
const MAX_IMPORT_DEPTH: usize = 64;
/// Progress is reported after at most this many copied bytes.
const IMPORT_PROGRESS_STEP: u64 = 1024 * 1024;

/// What happens when an imported item's name is already taken in the destination folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictPolicy {
    /// Add " copy", " copy 2", ... to the new item's name. Nothing is replaced.
    #[default]
    KeepBoth,
    /// Move the existing item to the system Trash, then put the copy in its place.
    Replace,
    /// Leave the existing item and do not copy this one.
    Skip,
}

/// One item to copy into the workspace: an absolute source path and its clash policy.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportItem {
    pub source: String,
    pub policy: ConflictPolicy,
}

/// Limits of one import. The defaults are [`MAX_IMPORT_ENTRIES`] and [`MAX_IMPORT_BYTES`].
#[derive(Debug, Clone, Copy)]
pub struct ImportLimits {
    pub max_entries: usize,
    pub max_bytes: u64,
}
impl Default for ImportLimits {
    fn default() -> Self {
        Self {
            max_entries: MAX_IMPORT_ENTRIES,
            max_bytes: MAX_IMPORT_BYTES,
        }
    }
}

/// Copied and total entries and bytes of a running import.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub entries: u32,
    pub total_entries: u32,
    pub bytes: u64,
    pub total_bytes: u64,
}

/// Result of an import. Items copied before a cancellation or a failure stay and are listed in `created`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// Workspace relative paths of the new top level items, replacements included.
    pub created: Vec<String>,
    /// Workspace relative paths whose previous item was moved to the system Trash.
    pub replaced: Vec<String>,
    /// Names left out by the Skip policy.
    pub skipped: Vec<String>,
    /// Symbolic links and special files that were not copied.
    pub skipped_links: u32,
    pub entries: u32,
    pub bytes: u64,
    pub cancelled: bool,
    /// Why the import stopped early, when an item failed.
    pub error: Option<String>,
}

impl CoreWorkspace {
    pub fn new_file(&mut self, path: &str) -> Result<BufferSnapshot> {
        let resolved = self.operation_path(path)?;
        let relative = self.relative(&resolved)?;
        if self.buffers.contains_key(&relative) {
            return Err(CoreError::InvalidEdit(format!(
                "Close the existing buffer before creating {relative}"
            )));
        }
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&resolved)
            .map_err(|error| io_error("Create file", &resolved, error))?;
        file.sync_all()
            .map_err(|error| io_error("Flush new file", &resolved, error))?;
        self.open_buffer(&relative)
    }

    pub fn new_directory(&mut self, path: &str) -> Result<FileEntry> {
        let resolved = self.operation_path(path)?;
        fs::create_dir(&resolved).map_err(|error| io_error("Create folder", &resolved, error))?;
        self.operation_entry(&resolved)
    }

    pub fn rename_path(&mut self, from: &str, to: &str) -> Result<FileEntry> {
        let source = self.existing_operation_path(from)?;
        let destination = self.operation_path(to)?;
        if source == destination {
            return self.operation_entry(&source);
        }
        self.ensure_operation_idle(&source)?;
        self.ensure_operation_idle(&destination)?;
        if destination.starts_with(&source) {
            return Err(CoreError::InvalidEdit(
                "A folder cannot be moved inside itself".into(),
            ));
        }
        let source_relative = self.relative(&source)?;
        let destination_relative = self.relative(&destination)?;
        let mut repaths = Vec::new();
        for (path, buffer) in &self.buffers {
            if let Ok(suffix) = Path::new(path).strip_prefix(&source_relative) {
                let revision = buffer
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| CoreError::InvalidEdit("Buffer revision exhausted".into()))?;
                // `join("")` would append a trailing separator to a renamed file.
                let new_path = if suffix.as_os_str().is_empty() {
                    destination_relative.clone()
                } else {
                    Path::new(&destination_relative)
                        .join(suffix)
                        .to_string_lossy()
                        .replace('\\', "/")
                };
                if self.buffers.contains_key(&new_path) {
                    return Err(CoreError::InvalidEdit(format!(
                        "A buffer is already open at {new_path}"
                    )));
                }
                repaths.push((path.clone(), new_path, revision));
            }
        }
        rename_no_replace(&source, &destination)
            .map_err(|error| io_error("Rename without overwriting", &destination, error))?;
        for (old, new, revision) in repaths {
            if let Some(mut buffer) = self.buffers.remove(&old) {
                buffer.revision = revision;
                buffer.saved_revision = revision;
                self.buffers.insert(new, buffer);
            }
        }
        self.operation_entry(&destination)
    }

    pub fn duplicate_path(&mut self, from: &str, to: &str) -> Result<FileEntry> {
        self.duplicate_path_cancellable(from, to, &CancellationToken::default())
    }

    pub fn duplicate_path_cancellable(
        &mut self,
        from: &str,
        to: &str,
        cancellation: &CancellationToken,
    ) -> Result<FileEntry> {
        let source = self.existing_operation_path(from)?;
        let destination = self.operation_path(to)?;
        self.ensure_operation_idle(&source)?;
        self.ensure_operation_idle(&destination)?;
        if destination.starts_with(&source) {
            return Err(CoreError::InvalidEdit(
                "A folder cannot be duplicated inside itself".into(),
            ));
        }
        if destination.symlink_metadata().is_ok() {
            return Err(io_error(
                "Duplicate without overwriting",
                &destination,
                std::io::Error::from(std::io::ErrorKind::AlreadyExists),
            ));
        }
        let parent = destination
            .parent()
            .ok_or_else(|| CoreError::OutsideWorkspace(to.into()))?;
        let staging = parent.join(format!(
            ".span-copy-{}-{}",
            std::process::id(),
            COPY_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let is_directory = source.is_dir();
        let mut budget = CopyBudget {
            entries: 0,
            bytes: 0,
            cancellation,
            owns_staging: false,
        };
        let result = (|| {
            self.copy_entry(&source, &staging, &mut budget, 0)?;
            rename_no_replace(&staging, &destination).map_err(|error| {
                io_error("Publish duplicate without overwriting", &destination, error)
            })?;
            self.operation_entry(&destination)
        })();
        if result.is_err() && budget.owns_staging {
            // Only the operation's newly created staging entry is eligible for cleanup.
            if is_directory {
                let _ = fs::remove_dir_all(&staging);
            } else {
                let _ = fs::remove_file(&staging);
            }
        }
        result
    }

    /// Called only after the UI's explicit Move to Trash confirmation.
    pub fn trash_path(&mut self, path: &str) -> Result<Vec<String>> {
        self.trash_path_with(path, |resolved| {
            trash::delete(resolved).map_err(|error| {
                CoreError::InvalidEdit(format!(
                    "Move {} to system Trash: {error}",
                    resolved.display()
                ))
            })
        })
    }

    fn trash_path_with(
        &mut self,
        path: &str,
        trash: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<Vec<String>> {
        let resolved = self.existing_operation_path(path)?;
        self.ensure_operation_idle(&resolved)?;
        let relative = self.relative(&resolved)?;
        let removed: Vec<String> = self
            .buffers
            .keys()
            .filter(|path| Path::new(path).starts_with(&relative))
            .cloned()
            .collect();
        trash(&resolved)?;
        for path in &removed {
            self.buffers.remove(path);
        }
        Ok(removed)
    }

    /// Copies items from outside Span (a native drop or the OS clipboard) into a workspace folder.
    ///
    /// The desktop layer passes only paths recorded from the latest drop or clipboard read. Nothing is ever
    /// overwritten without the caller's explicit `Replace`, which moves the existing item to the system Trash.
    pub fn import_paths(
        &mut self,
        target_dir: &str,
        items: &[ImportItem],
        limits: ImportLimits,
        cancellation: &CancellationToken,
        progress: &mut dyn FnMut(ImportProgress),
    ) -> Result<ImportReport> {
        self.import_paths_with(
            target_dir,
            items,
            limits,
            cancellation,
            progress,
            &mut |resolved| {
                trash::delete(resolved).map_err(|error| {
                    CoreError::InvalidEdit(format!(
                        "Move {} to system Trash: {error}",
                        resolved.display()
                    ))
                })
            },
        )
    }

    fn import_paths_with(
        &mut self,
        target_dir: &str,
        items: &[ImportItem],
        limits: ImportLimits,
        cancellation: &CancellationToken,
        progress: &mut dyn FnMut(ImportProgress),
        trash: &mut dyn FnMut(&Path) -> Result<()>,
    ) -> Result<ImportReport> {
        let target = self.import_target(target_dir)?;
        let mut sources = Vec::with_capacity(items.len());
        for item in items {
            let source = import_source(&item.source)?;
            if target.starts_with(&source) {
                return Err(CoreError::InvalidEdit(format!(
                    "A folder cannot be copied inside itself: {}",
                    display_name(&source)
                )));
            }
            sources.push((source, item.policy));
        }
        // Count everything first so a copy over the limits fails before it writes anything.
        let mut totals = ImportProgress::default();
        for (source, _) in &sources {
            scan_import(source, &limits, &mut totals, 0)?;
        }
        let mut budget = ImportBudget {
            progress: ImportProgress {
                total_entries: totals.total_entries,
                total_bytes: totals.total_bytes,
                ..ImportProgress::default()
            },
            limits,
            cancellation,
            skipped_links: 0,
            reported_at: 0,
        };
        progress(budget.progress.clone());
        let mut report = ImportReport::default();
        for (source, policy) in sources {
            if cancellation.is_cancelled() {
                report.cancelled = true;
                break;
            }
            let name = source
                .file_name()
                .ok_or_else(|| CoreError::InvalidEdit("A copied item has no name".into()))?
                .to_string_lossy()
                .into_owned();
            match self.import_one(
                &source,
                &target,
                &name,
                policy,
                &mut budget,
                progress,
                trash,
            ) {
                Ok(ImportOutcome::Created(path)) => report.created.push(path),
                Ok(ImportOutcome::Replaced(path)) => {
                    report.replaced.push(path.clone());
                    report.created.push(path);
                }
                Ok(ImportOutcome::Skipped) => report.skipped.push(name),
                Err(_) if cancellation.is_cancelled() => {
                    report.cancelled = true;
                    break;
                }
                Err(error) => {
                    report.error = Some(error.to_string());
                    break;
                }
            }
        }
        report.skipped_links = budget.skipped_links;
        report.entries = budget.progress.entries;
        report.bytes = budget.progress.bytes;
        progress(budget.progress.clone());
        Ok(report)
    }

    /// Writes `bytes` to a new workspace file, refusing an existing path. Used to paste clipboard text or images.
    pub fn write_new_file(&mut self, path: &str, bytes: &[u8]) -> Result<FileEntry> {
        if bytes.len() as u64 > MAX_COPY_BYTES {
            return Err(CoreError::InvalidEdit(
                "The pasted content exceeds the 64 MiB limit".into(),
            ));
        }
        let resolved = self.operation_path(path)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&resolved)
            .map_err(|error| io_error("Create pasted file", &resolved, error))?;
        let written = file.write_all(bytes).and_then(|_| file.sync_all());
        if let Err(error) = written {
            drop(file);
            let _ = fs::remove_file(&resolved);
            return Err(io_error("Write pasted file", &resolved, error));
        }
        self.operation_entry(&resolved)
    }

    /// Absolute path of an existing workspace file or folder (the root included), for reveal and the OS clipboard.
    pub fn existing_path(&self, path: &str) -> Result<PathBuf> {
        let resolved = self.resolve(path)?;
        fs::metadata(&resolved).map_err(|error| io_error("Inspect path", &resolved, error))?;
        Ok(resolved)
    }

    fn import_target(&self, target_dir: &str) -> Result<PathBuf> {
        let target = if target_dir.is_empty() {
            self.root.clone()
        } else {
            let requested = if Path::new(target_dir).is_absolute() {
                PathBuf::from(target_dir)
            } else {
                self.root.join(target_dir)
            };
            if requested
                .symlink_metadata()
                .is_ok_and(|metadata| metadata.file_type().is_symlink())
            {
                return Err(CoreError::InvalidEdit(
                    "Items cannot be copied into a symbolic link".into(),
                ));
            }
            // `resolve` canonicalises and refuses anything that lands outside the workspace.
            self.resolve(target_dir)?
        };
        let metadata = fs::metadata(&target)
            .map_err(|error| io_error("Inspect copy destination", &target, error))?;
        if !metadata.is_dir() {
            return Err(CoreError::InvalidEdit(
                "Items can only be copied into a folder".into(),
            ));
        }
        if self
            .relative(&target)?
            .split('/')
            .any(|part| part == ".git")
        {
            return Err(CoreError::InvalidEdit(
                "Items cannot be copied into the .git folder".into(),
            ));
        }
        Ok(target)
    }

    #[allow(clippy::too_many_arguments)]
    fn import_one(
        &mut self,
        source: &Path,
        target: &Path,
        name: &str,
        policy: ConflictPolicy,
        budget: &mut ImportBudget<'_>,
        progress: &mut dyn FnMut(ImportProgress),
        trash: &mut dyn FnMut(&Path) -> Result<()>,
    ) -> Result<ImportOutcome> {
        let wanted = target.join(name);
        let clash = wanted.symlink_metadata().is_ok();
        // Pasting an item into its own folder can only make a copy: Replace would trash the source.
        let same_item = clash && fs::canonicalize(&wanted).is_ok_and(|path| path == source);
        let policy = if same_item {
            ConflictPolicy::KeepBoth
        } else {
            policy
        };
        if clash && policy == ConflictPolicy::Skip {
            return Ok(ImportOutcome::Skipped);
        }
        let directory = source.is_dir();
        let staging = target.join(format!(
            ".span-import-{}-{}",
            std::process::id(),
            COPY_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let copied = import_entry(source, &staging, budget, progress, 0);
        let remove_staging = |staging: &Path| {
            if directory {
                let _ = fs::remove_dir_all(staging);
            } else {
                let _ = fs::remove_file(staging);
            }
        };
        if let Err(error) = copied {
            if staging.symlink_metadata().is_ok() {
                remove_staging(&staging);
            }
            return Err(error);
        }
        let outcome = self.publish_import(
            &staging, target, &wanted, name, clash, policy, directory, trash,
        );
        if outcome.is_err() && staging.symlink_metadata().is_ok() {
            remove_staging(&staging);
        }
        outcome
    }

    #[allow(clippy::too_many_arguments)]
    fn publish_import(
        &mut self,
        staging: &Path,
        target: &Path,
        wanted: &Path,
        name: &str,
        clash: bool,
        policy: ConflictPolicy,
        directory: bool,
        trash: &mut dyn FnMut(&Path) -> Result<()>,
    ) -> Result<ImportOutcome> {
        if clash && policy == ConflictPolicy::Replace {
            let relative = self.relative(wanted)?;
            self.trash_path_with(&relative, |path| trash(path))?;
            rename_no_replace(staging, wanted)
                .map_err(|error| io_error("Publish copy without overwriting", wanted, error))?;
            return Ok(ImportOutcome::Replaced(self.relative(wanted)?));
        }
        let mut candidate = name.to_owned();
        for _ in 0..1000 {
            let destination = target.join(&candidate);
            if destination.symlink_metadata().is_ok() {
                candidate = copy_name(&candidate, directory);
                continue;
            }
            match rename_no_replace(staging, &destination) {
                Ok(()) => return Ok(ImportOutcome::Created(self.relative(&destination)?)),
                // Something appeared under that name since the check: keep both, never overwrite.
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    candidate = copy_name(&candidate, directory);
                }
                Err(error) => {
                    return Err(io_error(
                        "Publish copy without overwriting",
                        &destination,
                        error,
                    ))
                }
            }
        }
        Err(CoreError::InvalidEdit(
            "No free name was found for the copy".into(),
        ))
    }

    fn operation_path(&self, path: &str) -> Result<PathBuf> {
        let resolved = self.resolve(path)?;
        if resolved == self.root {
            return Err(CoreError::InvalidEdit(
                "The workspace root cannot be changed by a file operation".into(),
            ));
        }
        let requested = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            self.root.join(path)
        };
        // Inspect the original final component so a clicked link never mutates its resolved target.
        if requested
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(CoreError::InvalidEdit(
                "File operations on symbolic links are not supported".into(),
            ));
        }
        Ok(resolved)
    }
    fn existing_operation_path(&self, path: &str) -> Result<PathBuf> {
        let resolved = self.operation_path(path)?;
        fs::metadata(&resolved)
            .map_err(|error| io_error("Inspect file operation source", &resolved, error))?;
        Ok(resolved)
    }
    fn ensure_operation_idle(&self, path: &Path) -> Result<()> {
        let relative = self.relative(path)?;
        for (path, buffer) in &self.buffers {
            if Path::new(path).starts_with(&relative)
                && (buffer.revision != buffer.saved_revision || buffer.disk_signature.is_none())
            {
                return Err(CoreError::InvalidEdit(format!(
                    "Save or discard unsaved changes in {path} before changing its path"
                )));
            }
        }
        if self
            .proposals
            .values()
            .any(|proposal| Path::new(&proposal.path).starts_with(&relative))
        {
            return Err(CoreError::InvalidEdit(
                "Resolve pending agent edits before changing this path".into(),
            ));
        }
        Ok(())
    }
    fn operation_entry(&self, path: &Path) -> Result<FileEntry> {
        let metadata =
            fs::metadata(path).map_err(|error| io_error("Inspect changed path", path, error))?;
        let name = path
            .file_name()
            .ok_or_else(|| CoreError::InvalidEdit("Missing file name".into()))?
            .to_string_lossy()
            .into_owned();
        let ignored = path.parent().is_some_and(|parent| {
            !span_file_index::unignored_children(&self.root, parent).contains(path)
        });
        Ok(FileEntry {
            path: self.relative(path)?,
            name,
            is_dir: metadata.is_dir(),
            ignored,
            background_excluded: span_file_index::background_excluded(
                path,
                metadata.is_dir(),
                ignored,
            ),
        })
    }
    fn copy_entry(
        &self,
        source: &Path,
        destination: &Path,
        budget: &mut CopyBudget<'_>,
        depth: usize,
    ) -> Result<()> {
        budget.check()?;
        if depth > 64 {
            return Err(CoreError::InvalidEdit(
                "Duplicate exceeds the 64 level folder limit".into(),
            ));
        }
        budget.entries += 1;
        if budget.entries > MAX_COPY_ENTRIES {
            return Err(CoreError::InvalidEdit(
                "Duplicate exceeds the 10,000 entry limit".into(),
            ));
        }
        let metadata = source
            .symlink_metadata()
            .map_err(|error| io_error("Inspect duplicate source", source, error))?;
        if metadata.file_type().is_symlink() {
            return Err(CoreError::InvalidEdit(format!(
                "Duplicate does not follow symbolic links: {}",
                source.display()
            )));
        }
        self.resolve(&source.to_string_lossy())?;
        if metadata.is_dir() {
            fs::create_dir(destination)
                .map_err(|error| io_error("Create duplicate folder", destination, error))?;
            if budget.entries == 1 {
                budget.owns_staging = true;
            }
            for entry in fs::read_dir(source)
                .map_err(|error| io_error("Read duplicate folder", source, error))?
            {
                let entry =
                    entry.map_err(|error| io_error("Read duplicate entry", source, error))?;
                self.copy_entry(
                    &entry.path(),
                    &destination.join(entry.file_name()),
                    budget,
                    depth + 1,
                )?;
            }
            fs::set_permissions(destination, metadata.permissions())
                .map_err(|error| io_error("Preserve folder permissions", destination, error))?;
        } else if metadata.is_file() {
            let mut input = open_copy_source(source)
                .map_err(|error| io_error("Read duplicate source", source, error))?;
            let mut output = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(destination)
                .map_err(|error| io_error("Create duplicate file", destination, error))?;
            if budget.entries == 1 {
                budget.owns_staging = true;
            }
            let mut chunk = [0_u8; 16 * 1024];
            loop {
                budget.check()?;
                let count = input
                    .read(&mut chunk)
                    .map_err(|error| io_error("Read duplicate content", source, error))?;
                if count == 0 {
                    break;
                }
                budget.bytes += count as u64;
                if budget.bytes > MAX_COPY_BYTES {
                    return Err(CoreError::InvalidEdit(
                        "Duplicate exceeds the 64 MiB limit".into(),
                    ));
                }
                output
                    .write_all(&chunk[..count])
                    .map_err(|error| io_error("Write duplicate content", destination, error))?;
            }
            output
                .set_permissions(metadata.permissions())
                .map_err(|error| io_error("Preserve file permissions", destination, error))?;
            output
                .sync_all()
                .map_err(|error| io_error("Flush duplicate", destination, error))?;
        } else {
            return Err(CoreError::InvalidEdit(
                "Only regular files and folders can be duplicated".into(),
            ));
        }
        Ok(())
    }
}
struct CopyBudget<'a> {
    entries: usize,
    bytes: u64,
    cancellation: &'a CancellationToken,
    owns_staging: bool,
}
impl CopyBudget<'_> {
    fn check(&self) -> Result<()> {
        if self.cancellation.is_cancelled() {
            Err(CoreError::InvalidEdit("Duplicate was cancelled".into()))
        } else {
            Ok(())
        }
    }
}
enum ImportOutcome {
    Created(String),
    Replaced(String),
    Skipped,
}

struct ImportBudget<'a> {
    progress: ImportProgress,
    limits: ImportLimits,
    cancellation: &'a CancellationToken,
    skipped_links: u32,
    reported_at: u64,
}
impl ImportBudget<'_> {
    fn check(&self) -> Result<()> {
        if self.cancellation.is_cancelled() {
            Err(CoreError::InvalidEdit("The copy was cancelled".into()))
        } else {
            Ok(())
        }
    }
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The canonical source path, refusing relative paths and anything inside a `.git` folder.
fn import_source(path: &str) -> Result<PathBuf> {
    let requested = Path::new(path);
    if path.contains('\0') || !requested.is_absolute() {
        return Err(CoreError::InvalidEdit(
            "Only absolute paths can be copied into the project".into(),
        ));
    }
    let canonical = fs::canonicalize(requested)
        .map_err(|error| io_error("Inspect copied item", requested, error))?;
    if canonical
        .components()
        .any(|part| part.as_os_str() == std::ffi::OsStr::new(".git"))
    {
        return Err(CoreError::InvalidEdit(
            "Items inside a .git folder cannot be copied".into(),
        ));
    }
    if canonical.file_name().is_none() {
        return Err(CoreError::InvalidEdit(
            "A drive or file system root cannot be copied".into(),
        ));
    }
    Ok(canonical)
}

fn limit_error(limits: &ImportLimits, entries: bool) -> CoreError {
    CoreError::InvalidEdit(if entries {
        format!(
            "The copy has more than {} files and folders, the limit for one copy",
            limits.max_entries
        )
    } else {
        format!(
            "The copy is larger than {} MiB, the limit for one copy",
            limits.max_bytes / (1024 * 1024)
        )
    })
}

/// Counts what an import would copy, failing early over the limits. Links are not followed.
fn scan_import(
    path: &Path,
    limits: &ImportLimits,
    totals: &mut ImportProgress,
    depth: usize,
) -> Result<()> {
    if depth > MAX_IMPORT_DEPTH {
        return Err(CoreError::InvalidEdit(format!(
            "The copy is nested deeper than {MAX_IMPORT_DEPTH} folders"
        )));
    }
    let metadata = path
        .symlink_metadata()
        .map_err(|error| io_error("Inspect copied item", path, error))?;
    if !metadata.is_dir() && !metadata.is_file() {
        return Ok(());
    }
    totals.total_entries = totals.total_entries.saturating_add(1);
    if totals.total_entries as usize > limits.max_entries {
        return Err(limit_error(limits, true));
    }
    if metadata.is_file() {
        totals.total_bytes = totals.total_bytes.saturating_add(metadata.len());
        if totals.total_bytes > limits.max_bytes {
            return Err(limit_error(limits, false));
        }
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(|error| io_error("Read copied folder", path, error))? {
        let entry = entry.map_err(|error| io_error("Read copied folder", path, error))?;
        scan_import(&entry.path(), limits, totals, depth + 1)?;
    }
    Ok(())
}

/// Copies one entry without following links. Symbolic links and special files are skipped and counted, so a link
/// can never pull content from outside the dropped tree (or from the workspace itself) into the copy.
fn import_entry(
    source: &Path,
    destination: &Path,
    budget: &mut ImportBudget<'_>,
    progress: &mut dyn FnMut(ImportProgress),
    depth: usize,
) -> Result<()> {
    budget.check()?;
    if depth > MAX_IMPORT_DEPTH {
        return Err(CoreError::InvalidEdit(format!(
            "The copy is nested deeper than {MAX_IMPORT_DEPTH} folders"
        )));
    }
    // The top level source is canonical, so only nested links reach this check.
    let metadata = if depth == 0 {
        fs::metadata(source)
    } else {
        source.symlink_metadata()
    }
    .map_err(|error| io_error("Inspect copied item", source, error))?;
    if metadata.file_type().is_symlink() || !(metadata.is_dir() || metadata.is_file()) {
        budget.skipped_links = budget.skipped_links.saturating_add(1);
        return Ok(());
    }
    budget.progress.entries = budget.progress.entries.saturating_add(1);
    if budget.progress.entries as usize > budget.limits.max_entries {
        return Err(limit_error(&budget.limits, true));
    }
    if metadata.is_dir() {
        fs::create_dir(destination)
            .map_err(|error| io_error("Create copied folder", destination, error))?;
        progress(budget.progress.clone());
        for entry in
            fs::read_dir(source).map_err(|error| io_error("Read copied folder", source, error))?
        {
            let entry = entry.map_err(|error| io_error("Read copied folder", source, error))?;
            import_entry(
                &entry.path(),
                &destination.join(entry.file_name()),
                budget,
                progress,
                depth + 1,
            )?;
        }
        // Folders get default permissions: a read-only source folder must not lock the copy.
        return Ok(());
    }
    let mut input =
        open_copy_source(source).map_err(|error| io_error("Read copied file", source, error))?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|error| io_error("Create copied file", destination, error))?;
    let mut chunk = vec![0_u8; 64 * 1024];
    loop {
        budget.check()?;
        let count = input
            .read(&mut chunk)
            .map_err(|error| io_error("Read copied file", source, error))?;
        if count == 0 {
            break;
        }
        budget.progress.bytes = budget.progress.bytes.saturating_add(count as u64);
        // The file can grow after the scan: the limit holds for what is actually read.
        if budget.progress.bytes > budget.limits.max_bytes {
            return Err(limit_error(&budget.limits, false));
        }
        output
            .write_all(&chunk[..count])
            .map_err(|error| io_error("Write copied file", destination, error))?;
        if budget.progress.bytes - budget.reported_at >= IMPORT_PROGRESS_STEP {
            budget.reported_at = budget.progress.bytes;
            progress(budget.progress.clone());
        }
    }
    output
        .set_permissions(metadata.permissions())
        .map_err(|error| io_error("Preserve file permissions", destination, error))?;
    output
        .sync_all()
        .map_err(|error| io_error("Flush copied file", destination, error))?;
    Ok(())
}

/// "name copy.ext", then "name copy 2.ext", and so on. Folders and dotfiles keep their whole name as the stem.
pub fn copy_name(name: &str, directory: bool) -> String {
    let (stem, extension) = match name.rfind('.') {
        Some(dot) if !directory && dot > 0 => name.split_at(dot),
        _ => (name, ""),
    };
    if let Some((base, number)) = stem.rsplit_once(" copy ") {
        if let Ok(number) = number.parse::<u32>() {
            return format!("{base} copy {}{extension}", number.saturating_add(1));
        }
    }
    if let Some(base) = stem.strip_suffix(" copy") {
        return format!("{base} copy 2{extension}");
    }
    format!("{stem} copy{extension}")
}
fn open_copy_source(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(
            (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    Ok(file)
}
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        from,
        rustix::fs::CWD,
        to,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(Into::into)
}
#[cfg(windows)]
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    let mut from: Vec<u16> = from.as_os_str().encode_wide().collect();
    let mut to: Vec<u16> = to.as_os_str().encode_wide().collect();
    if from.contains(&0) || to.contains(&0) {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    from.push(0);
    to.push(0);
    // MoveFileW explicitly fails if a destination exists. Both buffers are terminated and live across the call.
    if unsafe { windows_sys::Win32::Storage::FileSystem::MoveFileW(from.as_ptr(), to.as_ptr()) }
        == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn rename_no_replace(_: &Path, _: &Path) -> std::io::Result<()> {
    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "Uses the actual macOS Trash for a uniquely named temporary fixture, then restores it"]
    fn system_trash_round_trip_restores_only_its_owned_temporary_fixture() {
        let directory = tempfile::tempdir().unwrap();
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let name = format!("span-owned-trash-test-{}-{unique}.txt", std::process::id());
        let original = directory.path().join(&name);
        let trash_file = PathBuf::from(std::env::var_os("HOME").unwrap())
            .join(".Trash")
            .join(&name);
        assert!(!trash_file.exists());
        fs::write(&original, "Only this temporary test fixture may be moved").unwrap();
        let mut core = CoreWorkspace::open(directory.path()).unwrap();
        core.open_buffer(&name).unwrap();
        assert_eq!(core.trash_path(&name).unwrap(), vec![name.clone()]);
        assert!(!original.exists());
        assert_eq!(
            fs::read_to_string(&trash_file).unwrap(),
            "Only this temporary test fixture may be moved"
        );
        fs::rename(&trash_file, &original).unwrap();
        assert_eq!(
            core.open_buffer(&name).unwrap().text,
            "Only this temporary test fixture may be moved"
        );
    }

    #[test]
    fn trash_bridge_is_recoverable_and_only_evicts_after_success() {
        let directory = tempfile::tempdir().unwrap();
        let recovery = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("owned-test.txt"), "recover me").unwrap();
        let mut core = CoreWorkspace::open(directory.path()).unwrap();
        core.open_buffer("owned-test.txt").unwrap();
        assert!(core
            .trash_path_with("owned-test.txt", |_| Err(CoreError::InvalidEdit(
                "Trash unavailable".into()
            )))
            .is_err());
        assert_eq!(
            core.agent_read("owned-test.txt").unwrap().text,
            "recover me"
        );
        let recovered = recovery.path().join("owned-test.txt");
        let removed = core
            .trash_path_with("owned-test.txt", |source| {
                fs::rename(source, &recovered)
                    .map_err(|error| io_error("Test recoverable trash", source, error))
            })
            .unwrap();
        assert_eq!(removed, vec!["owned-test.txt"]);
        assert_eq!(fs::read_to_string(&recovered).unwrap(), "recover me");
        fs::rename(recovered, directory.path().join("owned-test.txt")).unwrap();
        assert_eq!(
            core.open_buffer("owned-test.txt").unwrap().text,
            "recover me"
        );
    }
    fn import_item(path: &Path, policy: ConflictPolicy) -> ImportItem {
        ImportItem {
            source: path.to_string_lossy().into_owned(),
            policy,
        }
    }

    fn run_import(
        core: &mut CoreWorkspace,
        target: &str,
        items: &[ImportItem],
        limits: ImportLimits,
    ) -> Result<ImportReport> {
        let recovery = tempfile::tempdir().unwrap();
        let mut counter = 0;
        core.import_paths_with(
            target,
            items,
            limits,
            &CancellationToken::default(),
            &mut |_| {},
            &mut |path| {
                counter += 1;
                fs::rename(path, recovery.path().join(format!("trashed-{counter}")))
                    .map_err(|error| io_error("Test trash", path, error))
            },
        )
    }

    fn fixture() -> (tempfile::TempDir, tempfile::TempDir, CoreWorkspace) {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(workspace.path().join("src")).unwrap();
        let core = CoreWorkspace::open(workspace.path()).unwrap();
        (workspace, outside, core)
    }

    #[test]
    fn import_copies_files_and_folders_into_a_workspace_folder() {
        let (workspace, outside, mut core) = fixture();
        fs::write(outside.path().join("notes.txt"), "outside notes").unwrap();
        fs::create_dir_all(outside.path().join("assets/icons")).unwrap();
        fs::write(outside.path().join("assets/icons/a.svg"), "<svg/>").unwrap();
        let items = [
            import_item(&outside.path().join("notes.txt"), ConflictPolicy::KeepBoth),
            import_item(&outside.path().join("assets"), ConflictPolicy::KeepBoth),
        ];
        let report = run_import(&mut core, "src", &items, ImportLimits::default()).unwrap();
        assert_eq!(report.created, vec!["src/notes.txt", "src/assets"]);
        assert_eq!(report.entries, 4);
        assert!(report.error.is_none() && !report.cancelled);
        assert_eq!(
            fs::read_to_string(workspace.path().join("src/notes.txt")).unwrap(),
            "outside notes"
        );
        assert_eq!(
            fs::read_to_string(workspace.path().join("src/assets/icons/a.svg")).unwrap(),
            "<svg/>"
        );
        // The sources are copied, never moved.
        assert!(outside.path().join("notes.txt").exists());
        let root_report = run_import(&mut core, "", &items[..1], ImportLimits::default()).unwrap();
        assert_eq!(root_report.created, vec!["notes.txt"]);
    }

    #[test]
    fn import_keeps_both_by_default_and_never_overwrites() {
        let (workspace, outside, mut core) = fixture();
        fs::write(workspace.path().join("src/a.txt"), "existing").unwrap();
        fs::write(outside.path().join("a.txt"), "new").unwrap();
        let item = [import_item(
            &outside.path().join("a.txt"),
            ConflictPolicy::default(),
        )];
        assert_eq!(
            run_import(&mut core, "src", &item, ImportLimits::default())
                .unwrap()
                .created,
            vec!["src/a copy.txt"]
        );
        assert_eq!(
            run_import(&mut core, "src", &item, ImportLimits::default())
                .unwrap()
                .created,
            vec!["src/a copy 2.txt"]
        );
        assert_eq!(
            fs::read_to_string(workspace.path().join("src/a.txt")).unwrap(),
            "existing"
        );
        assert_eq!(
            fs::read_to_string(workspace.path().join("src/a copy 2.txt")).unwrap(),
            "new"
        );
    }

    #[test]
    fn import_skip_and_replace_policies() {
        let (workspace, outside, mut core) = fixture();
        fs::write(workspace.path().join("src/a.txt"), "existing").unwrap();
        fs::write(outside.path().join("a.txt"), "new").unwrap();
        let skip = [import_item(
            &outside.path().join("a.txt"),
            ConflictPolicy::Skip,
        )];
        let report = run_import(&mut core, "src", &skip, ImportLimits::default()).unwrap();
        assert!(report.created.is_empty());
        assert_eq!(report.skipped, vec!["a.txt"]);
        assert_eq!(
            fs::read_to_string(workspace.path().join("src/a.txt")).unwrap(),
            "existing"
        );
        let replace = [import_item(
            &outside.path().join("a.txt"),
            ConflictPolicy::Replace,
        )];
        let report = run_import(&mut core, "src", &replace, ImportLimits::default()).unwrap();
        assert_eq!(report.replaced, vec!["src/a.txt"]);
        assert_eq!(
            fs::read_to_string(workspace.path().join("src/a.txt")).unwrap(),
            "new"
        );
        // Replace refuses to discard unsaved edits of the existing file.
        let revision = core.open_buffer("src/a.txt").unwrap().revision;
        core.edit_buffer(
            "src/a.txt",
            revision,
            vec![crate::TextEdit {
                from: 0,
                to: 0,
                insert: "unsaved ".into(),
            }],
        )
        .unwrap();
        let report = run_import(&mut core, "src", &replace, ImportLimits::default()).unwrap();
        assert!(report.error.is_some());
        assert!(report.created.is_empty());
        let leftovers: Vec<_> = fs::read_dir(workspace.path().join("src"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec!["a.txt"], "staging copies are cleaned up");
    }

    #[test]
    fn import_into_the_items_own_folder_makes_a_copy_even_with_replace() {
        let (workspace, _outside, mut core) = fixture();
        let source = workspace.path().join("src/a.txt");
        fs::write(&source, "mine").unwrap();
        let item = [import_item(&source, ConflictPolicy::Replace)];
        let report = run_import(&mut core, "src", &item, ImportLimits::default()).unwrap();
        assert_eq!(report.created, vec!["src/a copy.txt"]);
        assert!(report.replaced.is_empty());
        assert_eq!(fs::read_to_string(&source).unwrap(), "mine");
    }

    #[test]
    fn import_target_must_be_a_folder_inside_the_workspace() {
        let (workspace, outside, mut core) = fixture();
        fs::write(outside.path().join("a.txt"), "new").unwrap();
        fs::write(workspace.path().join("file.txt"), "x").unwrap();
        fs::create_dir(workspace.path().join(".git")).unwrap();
        let item = [import_item(
            &outside.path().join("a.txt"),
            ConflictPolicy::KeepBoth,
        )];
        for target in [
            "../escape",
            outside.path().to_str().unwrap(),
            "file.txt",
            "missing",
            ".git",
        ] {
            assert!(
                run_import(&mut core, target, &item, ImportLimits::default()).is_err(),
                "{target} must be refused"
            );
        }
        assert!(!outside.path().join("a copy.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn import_refuses_a_symlinked_target_and_skips_links_inside_sources() {
        let (workspace, outside, mut core) = fixture();
        let secret = tempfile::tempdir().unwrap();
        fs::write(secret.path().join("secret.txt"), "never copied").unwrap();
        std::os::unix::fs::symlink(outside.path(), workspace.path().join("escape")).unwrap();
        fs::create_dir(outside.path().join("bundle")).unwrap();
        fs::write(outside.path().join("bundle/kept.txt"), "kept").unwrap();
        std::os::unix::fs::symlink(
            secret.path().join("secret.txt"),
            outside.path().join("bundle/link.txt"),
        )
        .unwrap();
        std::os::unix::fs::symlink(workspace.path(), outside.path().join("bundle/project"))
            .unwrap();
        let item = [import_item(
            &outside.path().join("bundle"),
            ConflictPolicy::KeepBoth,
        )];
        assert!(run_import(&mut core, "escape", &item, ImportLimits::default()).is_err());
        let report = run_import(&mut core, "src", &item, ImportLimits::default()).unwrap();
        assert_eq!(report.created, vec!["src/bundle"]);
        assert_eq!(report.skipped_links, 2);
        assert!(workspace.path().join("src/bundle/kept.txt").exists());
        assert!(workspace
            .path()
            .join("src/bundle/link.txt")
            .symlink_metadata()
            .is_err());
        assert!(workspace
            .path()
            .join("src/bundle/project")
            .symlink_metadata()
            .is_err());
    }

    #[test]
    fn import_refuses_copy_loops_git_internals_and_relative_sources() {
        let (workspace, outside, mut core) = fixture();
        fs::create_dir_all(workspace.path().join("src/inner")).unwrap();
        fs::create_dir_all(outside.path().join(".git")).unwrap();
        fs::write(outside.path().join(".git/config"), "x").unwrap();
        for (source, target) in [
            (workspace.path().to_path_buf(), "src"),
            (workspace.path().join("src"), "src"),
            (workspace.path().join("src"), "src/inner"),
            (outside.path().join(".git/config"), "src"),
            (outside.path().join(".git"), "src"),
            (PathBuf::from("relative.txt"), "src"),
        ] {
            let item = [import_item(&source, ConflictPolicy::KeepBoth)];
            assert!(
                run_import(&mut core, target, &item, ImportLimits::default()).is_err(),
                "{} into {target} must be refused",
                source.display()
            );
        }
        // Copying a project folder next to itself is not a loop.
        let item = [import_item(
            &workspace.path().join("src/inner"),
            ConflictPolicy::KeepBoth,
        )];
        assert_eq!(
            run_import(&mut core, "src", &item, ImportLimits::default())
                .unwrap()
                .created,
            vec!["src/inner copy"]
        );
    }

    #[test]
    fn import_limits_fail_before_anything_is_written() {
        let (workspace, outside, mut core) = fixture();
        fs::create_dir(outside.path().join("many")).unwrap();
        for index in 0..20 {
            fs::write(
                outside.path().join(format!("many/{index}.txt")),
                vec![b'x'; 1024],
            )
            .unwrap();
        }
        let item = [import_item(
            &outside.path().join("many"),
            ConflictPolicy::KeepBoth,
        )];
        let entries = ImportLimits {
            max_entries: 10,
            max_bytes: u64::MAX,
        };
        assert!(run_import(&mut core, "src", &item, entries)
            .unwrap_err()
            .to_string()
            .contains("more than 10"));
        let bytes = ImportLimits {
            max_entries: 100,
            max_bytes: 4 * 1024,
        };
        assert!(run_import(&mut core, "src", &item, bytes)
            .unwrap_err()
            .to_string()
            .contains("larger than"));
        assert_eq!(
            fs::read_dir(workspace.path().join("src")).unwrap().count(),
            0
        );
        let enough = ImportLimits {
            max_entries: 21,
            max_bytes: 20 * 1024,
        };
        assert_eq!(
            run_import(&mut core, "src", &item, enough).unwrap().entries,
            21
        );
    }

    #[test]
    fn import_reports_progress_and_honours_cancellation() {
        let (workspace, outside, mut core) = fixture();
        fs::write(outside.path().join("big.bin"), vec![0_u8; 3 * 1024 * 1024]).unwrap();
        let item = [import_item(
            &outside.path().join("big.bin"),
            ConflictPolicy::KeepBoth,
        )];
        let mut updates = Vec::new();
        let report = core
            .import_paths_with(
                "src",
                &item,
                ImportLimits::default(),
                &CancellationToken::default(),
                &mut |update| updates.push(update),
                &mut |_| Ok(()),
            )
            .unwrap();
        assert_eq!(report.bytes, 3 * 1024 * 1024);
        assert!(updates.len() >= 3);
        assert_eq!(updates.last().unwrap().total_bytes, 3 * 1024 * 1024);
        let cancelled = CancellationToken::default();
        cancelled.cancel();
        let report = core
            .import_paths_with(
                "src",
                &item,
                ImportLimits::default(),
                &cancelled,
                &mut |_| {},
                &mut |_| Ok(()),
            )
            .unwrap();
        assert!(report.cancelled && report.created.is_empty());
        assert_eq!(
            fs::read_dir(workspace.path().join("src")).unwrap().count(),
            1
        );
    }

    #[test]
    fn copy_names_follow_the_finder_pattern() {
        assert_eq!(copy_name("a.txt", false), "a copy.txt");
        assert_eq!(copy_name("a copy.txt", false), "a copy 2.txt");
        assert_eq!(copy_name("a copy 2.txt", false), "a copy 3.txt");
        assert_eq!(copy_name(".env", false), ".env copy");
        assert_eq!(copy_name("folder.d", true), "folder.d copy");
        assert_eq!(
            copy_name("Pasted image.png", false),
            "Pasted image copy.png"
        );
    }

    #[test]
    fn write_new_file_never_replaces_an_existing_file() {
        let (workspace, _outside, mut core) = fixture();
        let entry = core
            .write_new_file("src/Pasted text.txt", b"hello")
            .unwrap();
        assert_eq!(entry.path, "src/Pasted text.txt");
        assert!(core
            .write_new_file("src/Pasted text.txt", b"other")
            .is_err());
        assert_eq!(
            fs::read_to_string(workspace.path().join("src/Pasted text.txt")).unwrap(),
            "hello"
        );
        assert!(core.write_new_file("../outside.txt", b"x").is_err());
    }
}
