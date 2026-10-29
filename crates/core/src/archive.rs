//! Bounded ZIP inspection and extraction for uploaded archive bytes.
//!
//! This module deliberately never uses `ZipArchive::extract`. Every entry is
//! validated and copied through a workspace-rooted capability directory.

use crate::{CancellationToken, CoreError, CoreWorkspace, Result};
use cap_fs_ext::DirExt;
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;
use zip::ZipArchive;

pub const MAX_ARCHIVE_INPUT_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_ARCHIVE_ENTRIES: usize = 10_000;
pub const MAX_ARCHIVE_FILE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_ARCHIVE_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_ARCHIVE_PATH_BYTES: usize = 4096;
pub const MAX_ARCHIVE_EXPANSION_RATIO: u64 = 200;
const RATIO_CHECK_MIN_BYTES: u64 = 1024 * 1024;
const IO_CHUNK_BYTES: usize = 64 * 1024;
static NEXT_BUNDLE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub path: String,
    pub dir: bool,
    pub size: u64,
    pub packed: u64,
    pub modified: Option<u64>,
    pub encrypted: bool,
    pub unsafe_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveListing {
    pub format: String,
    pub method: String,
    pub entries: Vec<ArchiveEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveExtractOptions {
    /// Exact paths from the listing. `None` means all safe files.
    pub paths: Option<Vec<String>>,
    pub keep_structure: bool,
    pub skip_hidden: bool,
}

impl Default for ArchiveExtractOptions {
    fn default() -> Self {
        Self {
            paths: None,
            keep_structure: true,
            skip_hidden: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePlan {
    /// One new folder, relative to the workspace root.
    pub destination: String,
    pub files: u32,
    pub bytes: u64,
    pub skipped_unsafe: Vec<String>,
    /// Exact archive paths selected for extraction.
    pub selected: Vec<String>,
    pub keep_structure: bool,
    pub skip_hidden: bool,
    #[serde(skip)]
    bundle_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveProgress {
    pub done: u32,
    pub total: u32,
    /// Bytes successfully written so far.
    pub bytes: u64,
    pub current: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveResult {
    pub extracted: u32,
    pub skipped: Vec<String>,
    pub destination: String,
    pub cancelled: bool,
    /// An extraction error may follow already completed files. Those files are
    /// retained in the fresh destination and this field explains the partial result.
    pub error: Option<String>,
}

/// Immutable ZIP bytes owned by the application. It holds no arbitrary path or
/// workspace authority, so callers can cache it independently of a window.
#[derive(Debug, Clone)]
pub struct ZipBundle {
    bytes: Arc<Vec<u8>>,
    id: u64,
}

#[derive(Debug, Clone)]
struct InspectedEntry {
    view: ArchiveEntry,
    safe_path: Option<String>,
    collision_path: Option<String>,
}

impl ZipBundle {
    pub fn new(bytes: Arc<Vec<u8>>) -> Result<Self> {
        if bytes.len() as u64 > MAX_ARCHIVE_INPUT_BYTES {
            return Err(archive_error("archive exceeds the 64 MiB input limit"));
        }
        let bundle = Self {
            bytes,
            id: NEXT_BUNDLE_ID.fetch_add(1, Ordering::Relaxed),
        };
        bundle.inspect()?;
        Ok(bundle)
    }

    pub fn listing(&self) -> Result<ArchiveListing> {
        let entries = self.inspect()?.into_iter().map(|item| item.view).collect();
        Ok(ArchiveListing {
            format: "zip".into(),
            method: "zip".into(),
            entries,
        })
    }

    /// Reads one safe regular file, consuming it fully so ZIP CRC validation is
    /// performed by the reader. The declared and actual output remain bounded.
    pub fn read_entry(&self, path: &str) -> Result<Vec<u8>> {
        let entries = self.inspect()?;
        let index = entries
            .iter()
            .position(|item| item.view.path == path)
            .ok_or_else(|| archive_error("entry was not found"))?;
        let item = &entries[index];
        if item.view.dir || item.safe_path.is_none() {
            return Err(archive_error("entry is unsafe or is not a regular file"));
        }
        let mut archive = self.archive()?;
        let mut file = archive
            .by_index(index)
            .map_err(|error| archive_error(format!("cannot open entry: {error}")))?;
        let mut output = Vec::with_capacity(item.view.size.min(MAX_ARCHIVE_FILE_BYTES) as usize);
        let mut chunk = [0u8; IO_CHUNK_BYTES];
        loop {
            let count = file.read(&mut chunk).map_err(|error| {
                archive_error(format!("entry read or CRC check failed: {error}"))
            })?;
            if count == 0 {
                break;
            }
            let next_len = output.len() as u64 + count as u64;
            if next_len > item.view.size {
                return Err(archive_error("entry output exceeds its declared size"));
            }
            if next_len > MAX_ARCHIVE_FILE_BYTES {
                return Err(archive_error("entry exceeds the 64 MiB output limit"));
            }
            output.extend_from_slice(&chunk[..count]);
        }
        if output.len() as u64 != item.view.size {
            return Err(archive_error("entry output size did not match its header"));
        }
        Ok(output)
    }

    pub fn plan(
        &self,
        workspace: &CoreWorkspace,
        expected_root: &str,
        options: ArchiveExtractOptions,
    ) -> Result<ArchivePlan> {
        check_workspace_root(workspace, expected_root)?;
        if options.paths.as_ref().is_some_and(|paths| {
            paths.len() > MAX_ARCHIVE_ENTRIES
                || paths.iter().any(|path| path.len() > MAX_ARCHIVE_PATH_BYTES)
        }) {
            return Err(archive_error(
                "selection exceeds the path count or path length limit",
            ));
        }
        let entries = self.inspect()?;
        let selected_roots: Option<HashSet<&str>> = options.paths.as_ref().map(|paths| {
            paths
                .iter()
                .map(|path| path.trim_end_matches('/'))
                .collect()
        });
        if let Some(paths) = &options.paths {
            let known: HashSet<&str> = entries.iter().map(|item| item.view.path.as_str()).collect();
            if paths.iter().any(|path| !known.contains(path.as_str())) {
                return Err(archive_error(
                    "selection contains a path not in this archive",
                ));
            }
        }

        let mut selected = Vec::new();
        let mut skipped_unsafe = Vec::new();
        let mut bytes = 0u64;
        let mut outputs = HashSet::new();
        for item in &entries {
            if item.view.dir {
                continue;
            }
            let requested = selected_roots.as_ref().map_or(true, |roots| {
                roots.iter().any(|root| {
                    item.view.path == *root || item.view.path.starts_with(&format!("{root}/"))
                })
            });
            if !requested {
                continue;
            }
            if options.skip_hidden
                && is_hidden(item.safe_path.as_deref().unwrap_or(&item.view.path))
            {
                skipped_unsafe.push(item.view.path.clone());
                continue;
            }
            let Some(safe_path) = &item.safe_path else {
                skipped_unsafe.push(item.view.path.clone());
                continue;
            };
            let output = if options.keep_structure {
                safe_path.clone()
            } else {
                safe_path.rsplit('/').next().unwrap_or(safe_path).to_owned()
            };
            if !outputs.insert(collision_key(&output)) {
                return Err(archive_error("selected files collide in the output layout"));
            }
            bytes = bytes
                .checked_add(item.view.size)
                .ok_or_else(|| archive_error("selected output size overflow"))?;
            selected.push(item.view.path.clone());
        }
        if bytes > MAX_ARCHIVE_TOTAL_BYTES {
            return Err(archive_error(
                "selected files exceed the 256 MiB total limit",
            ));
        }
        if selected.is_empty() {
            return Err(archive_error("no safe files selected for extraction"));
        }
        let destination = choose_destination(workspace)?;
        Ok(ArchivePlan {
            destination,
            files: selected.len() as u32,
            bytes,
            skipped_unsafe,
            selected,
            keep_structure: options.keep_structure,
            skip_hidden: options.skip_hidden,
            bundle_id: self.id,
        })
    }

    /// Extracts into a newly-created folder under the canonical workspace root.
    /// Existing entries are never replaced. Any partial file is removed on
    /// cancellation or error, while completed files and the destination remain.
    pub fn extract(
        &self,
        workspace: &CoreWorkspace,
        expected_root: &str,
        plan: &ArchivePlan,
        cancellation: &CancellationToken,
        mut on_progress: impl FnMut(ArchiveProgress),
    ) -> Result<ArchiveResult> {
        check_workspace_root(workspace, expected_root)?;
        if plan.bundle_id != self.id {
            return Err(archive_error("plan belongs to a different archive"));
        }
        if plan.selected.is_empty() {
            return Err(archive_error("no safe files selected for extraction"));
        }
        validate_destination(&plan.destination)?;
        let entries = self.inspect()?;
        let by_path: HashMap<&str, (usize, &InspectedEntry)> = entries
            .iter()
            .enumerate()
            .map(|(index, item)| (item.view.path.as_str(), (index, item)))
            .collect();
        let mut recomputed_bytes = 0u64;
        let mut outputs = HashSet::new();
        for path in &plan.selected {
            let (_, item) = by_path
                .get(path.as_str())
                .copied()
                .ok_or_else(|| archive_error("plan contains a path not in this archive"))?;
            let Some(safe_path) = &item.safe_path else {
                return Err(archive_error("plan includes an unsafe entry"));
            };
            if item.view.dir || (plan.skip_hidden && is_hidden(safe_path)) {
                return Err(archive_error("plan includes a directory or hidden entry"));
            }
            let output = output_path(safe_path, plan.keep_structure);
            if !outputs.insert(collision_key(&output)) {
                return Err(archive_error("plan contains colliding output paths"));
            }
            recomputed_bytes = recomputed_bytes
                .checked_add(item.view.size)
                .ok_or_else(|| archive_error("plan output size overflow"))?;
        }
        if plan.files as usize != plan.selected.len()
            || plan.bytes != recomputed_bytes
            || recomputed_bytes > MAX_ARCHIVE_TOTAL_BYTES
        {
            return Err(archive_error(
                "plan totals do not match the selected entries",
            ));
        }

        let mut result = ArchiveResult {
            extracted: 0,
            skipped: plan.skipped_unsafe.clone(),
            destination: plan.destination.clone(),
            cancelled: false,
            error: None,
        };
        if cancellation.is_cancelled() {
            result.cancelled = true;
            return Ok(result);
        }

        let root_path = &workspace.root;
        let root_dir = open_workspace_root_nofollow(workspace, expected_root)?;
        if cancellation.is_cancelled() {
            result.cancelled = true;
            return Ok(result);
        }
        // `create_dir` is atomic with respect to a competing creator. It fails
        // instead of merging into or replacing an existing directory.
        root_dir
            .create_dir(&plan.destination)
            .map_err(|error| crate::io_error("Create archive destination", root_path, error))?;
        if cancellation.is_cancelled() {
            result.cancelled = true;
            if let Err(error) = root_dir.remove_dir(&plan.destination) {
                result.error = Some(format!("Cancellation cleanup failed: {error}"));
            }
            return Ok(result);
        }
        let destination = root_dir
            .open_dir_nofollow(&plan.destination)
            .map_err(|error| crate::io_error("Open archive destination", root_path, error))?;

        let mut archive = self.archive()?;
        let total = plan.files;
        let mut bytes_done = 0u64;
        for path in &plan.selected {
            if cancellation.is_cancelled() {
                result.cancelled = true;
                break;
            }
            let (index, item) = by_path[path.as_str()];
            let safe_path = item
                .safe_path
                .as_deref()
                .ok_or_else(|| archive_error("unsafe plan path"))?;
            let output = output_path(safe_path, plan.keep_structure);
            let (parent, file_name) = match create_parent_dirs(&destination, &output) {
                Ok(value) => value,
                Err(error) => {
                    result.error = Some(error.to_string());
                    break;
                }
            };
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            let mut target = match parent.open_with(&file_name, &options) {
                Ok(file) => file,
                Err(error) => {
                    result.error = Some(format!("Create {path}: {error}"));
                    break;
                }
            };
            let mut source = match archive.by_index(index) {
                Ok(file) if !file.encrypted() => file,
                Ok(_) => {
                    drop(target);
                    if let Err(error) = parent.remove_file(&file_name) {
                        result.error =
                            Some(format!("Remove incomplete encrypted entry {path}: {error}"));
                        break;
                    }
                    result.skipped.push(path.clone());
                    continue;
                }
                Err(error) => {
                    drop(target);
                    let cleanup = parent
                        .remove_file(&file_name)
                        .err()
                        .map(|cleanup| {
                            format!("; incomplete output could not be removed: {cleanup}")
                        })
                        .unwrap_or_default();
                    result.error = Some(format!("Open {path}: {error}{cleanup}"));
                    break;
                }
            };
            let mut current_bytes = 0u64;
            let mut chunk = [0u8; IO_CHUNK_BYTES];
            let mut failed = None;
            loop {
                if cancellation.is_cancelled() {
                    failed = Some("cancelled".to_owned());
                    break;
                }
                let count = match source.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(count) => count,
                    Err(error) => {
                        failed = Some(format!("read or CRC check failed: {error}"));
                        break;
                    }
                };
                current_bytes += count as u64;
                if current_bytes > item.view.size || current_bytes > MAX_ARCHIVE_FILE_BYTES {
                    failed = Some("entry output exceeded its declared or allowed size".into());
                    break;
                }
                if let Err(error) = target.write_all(&chunk[..count]) {
                    failed = Some(format!("write failed: {error}"));
                    break;
                }
                on_progress(ArchiveProgress {
                    done: result.extracted,
                    total,
                    bytes: bytes_done + current_bytes,
                    current: path.clone(),
                });
            }
            if failed.is_none() && current_bytes != item.view.size {
                failed = Some("entry output size did not match its header".into());
            }
            if failed.is_none() {
                if let Err(error) = target.flush() {
                    failed = Some(format!("flush failed: {error}"));
                }
            }
            drop(source);
            drop(target);
            if let Some(reason) = failed {
                let cleanup = parent
                    .remove_file(&file_name)
                    .err()
                    .map(|error| format!("; incomplete output could not be removed: {error}"));
                if reason == "cancelled" {
                    result.cancelled = true;
                    if let Some(cleanup) = cleanup {
                        result.error = Some(format!("Cancellation cleanup failed{cleanup}"));
                    }
                } else {
                    result.error = Some(format!(
                        "Extract {path}: {reason}{}",
                        cleanup.unwrap_or_default()
                    ));
                }
                break;
            }
            result.extracted += 1;
            bytes_done += current_bytes;
            on_progress(ArchiveProgress {
                done: result.extracted,
                total,
                bytes: bytes_done,
                current: path.clone(),
            });
        }
        Ok(result)
    }

    fn archive(&self) -> Result<ZipArchive<Cursor<&[u8]>>> {
        ZipArchive::new(Cursor::new(self.bytes.as_slice()))
            .map_err(|error| archive_error(format!("invalid ZIP archive: {error}")))
    }

    fn inspect(&self) -> Result<Vec<InspectedEntry>> {
        let mut archive = self.archive()?;
        let count = archive.len();
        if count > MAX_ARCHIVE_ENTRIES {
            return Err(archive_error("archive exceeds the 10,000 entry limit"));
        }
        let mut entries = Vec::with_capacity(count);
        for index in 0..count {
            let file = archive
                .by_index(index)
                .map_err(|error| archive_error(format!("invalid ZIP entry: {error}")))?;
            let raw_path = file.name();
            let path = truncate_path(raw_path);
            let dir = file.is_dir();
            let encrypted = file.encrypted();
            let size = file.size();
            let packed = file.compressed_size();
            let special = file.unix_mode().is_some_and(|mode| {
                let kind = mode & 0o170000;
                kind != 0 && kind != 0o100000 && kind != 0o040000
            });
            let (safe_path, mut reason) = if raw_path.len() > MAX_ARCHIVE_PATH_BYTES {
                (None, Some("path exceeds the 4,096 byte limit".into()))
            } else {
                validate_entry_name(raw_path)
            };
            let collision_path = safe_path.clone();
            if reason.is_none() && special {
                reason = Some("special or link entry".into());
            }
            if reason.is_none() && encrypted {
                reason = Some("encrypted entry".into());
            }
            if reason.is_none() && !dir && size > MAX_ARCHIVE_FILE_BYTES {
                reason = Some("entry exceeds the 64 MiB output limit".into());
            }
            if reason.is_none()
                && size >= RATIO_CHECK_MIN_BYTES
                && (packed == 0 || size > packed.saturating_mul(MAX_ARCHIVE_EXPANSION_RATIO))
            {
                reason = Some("entry exceeds the expansion ratio limit".into());
            }
            entries.push(InspectedEntry {
                view: ArchiveEntry {
                    path,
                    dir,
                    size,
                    packed,
                    modified: None,
                    encrypted,
                    unsafe_reason: reason,
                },
                safe_path: if reason.is_none() { safe_path } else { None },
                collision_path,
            });
        }
        let total: u64 = entries
            .iter()
            .filter(|entry| !entry.view.dir && entry.view.unsafe_reason.is_none())
            .map(|entry| entry.view.size)
            .sum();
        if total > MAX_ARCHIVE_TOTAL_BYTES {
            for entry in &mut entries {
                if !entry.view.dir && entry.view.unsafe_reason.is_none() {
                    entry.view.unsafe_reason =
                        Some("archive exceeds the 256 MiB total output limit".into());
                    entry.safe_path = None;
                }
            }
        }
        mark_collisions(&mut entries);
        Ok(entries)
    }
}

fn mark_collisions(entries: &mut [InspectedEntry]) {
    let mut exact: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if let Some(path) = &entry.collision_path {
            exact.entry(collision_key(path)).or_default().push(index);
        }
    }
    for indexes in exact.values().filter(|indexes| indexes.len() > 1) {
        for &index in indexes {
            set_unsafe(
                &mut entries[index],
                "case-insensitive or normalized path collision",
            );
        }
    }
    let paths: Vec<(usize, String, bool)> = entries
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            item.collision_path
                .as_ref()
                .map(|path| (index, collision_key(path), item.view.dir))
        })
        .collect();
    for (i, (left_index, left, left_dir)) in paths.iter().enumerate() {
        for (right_index, right, right_dir) in paths.iter().skip(i + 1) {
            let left_is_prefix =
                right.starts_with(left) && right.as_bytes().get(left.len()) == Some(&b'/');
            let right_is_prefix =
                left.starts_with(right) && left.as_bytes().get(right.len()) == Some(&b'/');
            if left_is_prefix && !left_dir {
                set_unsafe(&mut entries[*left_index], "file-directory prefix collision");
                set_unsafe(
                    &mut entries[*right_index],
                    "file-directory prefix collision",
                );
            } else if right_is_prefix && !right_dir {
                set_unsafe(
                    &mut entries[*right_index],
                    "file-directory prefix collision",
                );
                set_unsafe(&mut entries[*left_index], "file-directory prefix collision");
            }
        }
    }
}

fn set_unsafe(entry: &mut InspectedEntry, reason: &str) {
    if entry.view.unsafe_reason.is_none() {
        entry.view.unsafe_reason = Some(reason.into());
    }
    entry.safe_path = None;
}

fn validate_entry_name(name: &str) -> (Option<String>, Option<String>) {
    let unsafe_name = |reason: &str| (None, Some(reason.to_owned()));
    if name.is_empty() || name.contains('\0') || name.contains('\\') {
        return unsafe_name("empty path, NUL, or backslash in name");
    }
    if name.starts_with('/') || name.starts_with("//") {
        return unsafe_name("absolute path");
    }
    if name.len() >= 2 && name.as_bytes()[1] == b':' {
        return unsafe_name("drive-qualified path");
    }
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    if trimmed.is_empty() {
        return unsafe_name("empty path");
    }
    for component in trimmed.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return unsafe_name("empty or parent path component");
        }
        if component.contains(':') {
            return unsafe_name("alternate data stream path");
        }
        if component.chars().any(char::is_control) {
            return unsafe_name("control character in path");
        }
        if component.ends_with(' ') || component.ends_with('.') {
            return unsafe_name("trailing space or dot in path component");
        }
        if is_windows_reserved(component) {
            return unsafe_name("Windows reserved device name");
        }
    }
    (Some(trimmed.to_owned()), None)
}

fn truncate_path(path: &str) -> String {
    if path.len() <= MAX_ARCHIVE_PATH_BYTES {
        return path.to_owned();
    }
    let mut end = MAX_ARCHIVE_PATH_BYTES;
    while !path.is_char_boundary(end) {
        end -= 1;
    }
    path[..end].to_owned()
}

fn is_windows_reserved(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or(component)
        .trim_end_matches([' ', '.']);
    let upper = stem.to_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            upper
                .strip_prefix(prefix)
                .is_some_and(|suffix| matches!(suffix, "1"..="9" | "¹" | "²" | "³"))
        })
}

fn collision_key(path: &str) -> String {
    let normalized: String = path.nfkc().collect();
    let folded: String = normalized.case_fold().collect();
    folded.nfc().collect()
}

fn is_hidden(path: &str) -> bool {
    path.split('/').any(|component| component.starts_with('.'))
}

fn output_path(path: &str, keep_structure: bool) -> String {
    if keep_structure {
        path.to_owned()
    } else {
        path.rsplit('/').next().unwrap_or(path).to_owned()
    }
}

fn create_parent_dirs<'a>(destination: &'a Dir, relative: &str) -> std::io::Result<(Dir, String)> {
    let mut components = relative.split('/').peekable();
    let mut directory = destination.try_clone()?;
    while let Some(component) = components.next() {
        if components.peek().is_none() {
            return Ok((directory, component.to_owned()));
        }
        match directory.open_dir_nofollow(component) {
            Ok(child) => directory = child,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                directory.create_dir(component)?;
                directory = directory.open_dir_nofollow(component)?;
            }
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        "empty output path",
    ))
}

fn check_workspace_root(workspace: &CoreWorkspace, expected_root: &str) -> Result<()> {
    let metadata = std::fs::symlink_metadata(&workspace.root).map_err(|error| {
        crate::io_error("Validate workspace root entry", &workspace.root, error)
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CoreError::OutsideWorkspace(expected_root.to_owned()));
    }
    let canonical = workspace
        .root
        .canonicalize()
        .map_err(|error| crate::io_error("Validate workspace root", &workspace.root, error))?;
    let expected = Path::new(expected_root).canonicalize().map_err(|error| {
        crate::io_error(
            "Validate expected workspace root",
            Path::new(expected_root),
            error,
        )
    })?;
    if canonical != workspace.root || expected != workspace.root {
        return Err(CoreError::OutsideWorkspace(expected_root.to_owned()));
    }
    Ok(())
}

fn open_workspace_root_nofollow(workspace: &CoreWorkspace, expected_root: &str) -> Result<Dir> {
    check_workspace_root(workspace, expected_root)?;
    let root_path = &workspace.root;
    let parent_path = root_path
        .parent()
        .ok_or_else(|| CoreError::OutsideWorkspace(expected_root.to_owned()))?;
    let leaf = root_path
        .file_name()
        .ok_or_else(|| CoreError::OutsideWorkspace(expected_root.to_owned()))?;
    let parent = Dir::open_ambient_dir(parent_path, ambient_authority())
        .map_err(|error| crate::io_error("Open workspace parent capability", parent_path, error))?;
    let root = parent.open_dir_nofollow(leaf).map_err(|error| {
        crate::io_error(
            "Open workspace root without following links",
            root_path,
            error,
        )
    })?;
    // Revalidate the path after obtaining the capability. The no-follow open
    // rejects a replacement symlink at the root leaf itself.
    check_workspace_root(workspace, expected_root)?;
    Ok(root)
}

fn choose_destination(workspace: &CoreWorkspace) -> Result<String> {
    for suffix in 1..=10_000u32 {
        let name = if suffix == 1 {
            "archive-extracted".to_owned()
        } else {
            format!("archive-extracted-{suffix}")
        };
        let path = workspace.root.join(&name);
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(name),
            Ok(_) => continue,
            Err(error) => return Err(crate::io_error("Choose archive destination", &path, error)),
        }
    }
    Err(archive_error(
        "no unused extraction folder name is available",
    ))
}

fn validate_destination(destination: &str) -> Result<()> {
    let mut components = Path::new(destination).components();
    if destination.contains('/')
        || destination.contains('\\')
        || destination.contains(':')
        || components
            .next()
            .map_or(true, |component| !matches!(component, Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(archive_error(
            "destination is not a single safe folder name",
        ));
    }
    let (safe, reason) = validate_entry_name(destination);
    if safe.is_none() || reason.is_some() {
        return Err(archive_error("destination folder name is unsafe"));
    }
    Ok(())
}

fn archive_error(message: impl Into<String>) -> CoreError {
    CoreError::Upload(format!("Archive: {}", message.into()))
}

#[cfg(test)]
mod tests {
    use super::{ArchiveExtractOptions, ZipBundle, MAX_ARCHIVE_PATH_BYTES};
    use crate::{CancellationToken, CoreWorkspace};
    use std::fs;
    use std::sync::Arc;

    #[test]
    fn extracts_a_valid_stored_zip_into_a_fresh_workspace_folder() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_path = temp.path().join("workspace");
        fs::create_dir(&workspace_path).unwrap();
        let workspace = CoreWorkspace::open(&workspace_path).unwrap();
        let expected_root = workspace.workspace().root;
        let bundle = ZipBundle::new(Arc::new(stored_zip("notes/hello.txt", b"hello zip"))).unwrap();
        let plan = bundle
            .plan(&workspace, &expected_root, ArchiveExtractOptions::default())
            .unwrap();

        let result = bundle
            .extract(
                &workspace,
                &expected_root,
                &plan,
                &CancellationToken::default(),
                |_| {},
            )
            .unwrap();

        assert_eq!(result.extracted, 1);
        assert_eq!(result.error, None);
        assert_eq!(
            fs::read(
                workspace_path
                    .join(&plan.destination)
                    .join("notes/hello.txt")
            )
            .unwrap(),
            b"hello zip"
        );
    }

    #[test]
    fn pre_cancelled_extraction_does_not_change_the_workspace_tree() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_path = temp.path().join("workspace");
        fs::create_dir(&workspace_path).unwrap();
        let workspace = CoreWorkspace::open(&workspace_path).unwrap();
        let expected_root = workspace.workspace().root;
        let bundle = ZipBundle::new(Arc::new(stored_zip("hello.txt", b"hello"))).unwrap();
        let plan = bundle
            .plan(&workspace, &expected_root, ArchiveExtractOptions::default())
            .unwrap();
        let cancellation = CancellationToken::default();
        cancellation.cancel();

        let result = bundle
            .extract(&workspace, &expected_root, &plan, &cancellation, |_| {})
            .unwrap();

        assert!(result.cancelled);
        assert_eq!(result.error, None);
        assert!(!workspace_path.join(&plan.destination).exists());
        assert_eq!(fs::read_dir(&workspace_path).unwrap().count(), 0);
    }

    #[test]
    fn planning_rejects_a_selection_with_no_safe_files() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_path = temp.path().join("workspace");
        fs::create_dir(&workspace_path).unwrap();
        let workspace = CoreWorkspace::open(&workspace_path).unwrap();
        let expected_root = workspace.workspace().root;
        let bundle = ZipBundle::new(Arc::new(stored_zip(".hidden.txt", b"hidden"))).unwrap();
        let options = ArchiveExtractOptions {
            paths: None,
            keep_structure: true,
            skip_hidden: true,
        };

        assert!(bundle.plan(&workspace, &expected_root, options).is_err());
        assert_eq!(fs::read_dir(&workspace_path).unwrap().count(), 0);
    }

    #[test]
    fn entry_read_rejects_output_larger_than_the_declared_size() {
        let bundle = ZipBundle::new(Arc::new(stored_zip_with_declared_size(
            "lying.txt",
            b"actual output",
            2,
        )))
        .unwrap();

        assert!(bundle.read_entry("lying.txt").is_err());
    }

    #[test]
    fn listing_bounds_archive_path_names() {
        let long_name = "x".repeat(MAX_ARCHIVE_PATH_BYTES + 1024);
        let bundle = ZipBundle::new(Arc::new(stored_zip(&long_name, b""))).unwrap();

        let listing = bundle.listing().unwrap();

        assert_eq!(listing.entries[0].path.len(), MAX_ARCHIVE_PATH_BYTES);
        assert!(listing.entries[0].unsafe_reason.is_some());
    }

    #[test]
    fn planning_rejects_oversized_selection_paths() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_path = temp.path().join("workspace");
        fs::create_dir(&workspace_path).unwrap();
        let workspace = CoreWorkspace::open(&workspace_path).unwrap();
        let expected_root = workspace.workspace().root;
        let bundle = ZipBundle::new(Arc::new(stored_zip("hello.txt", b"hello"))).unwrap();
        let options = ArchiveExtractOptions {
            paths: Some(vec!["x".repeat(MAX_ARCHIVE_PATH_BYTES + 1)]),
            keep_structure: true,
            skip_hidden: false,
        };

        assert!(bundle.plan(&workspace, &expected_root, options).is_err());
        assert_eq!(fs::read_dir(&workspace_path).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_when_workspace_root_path_is_replaced_by_a_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_path = temp.path().join("workspace");
        let moved_path = temp.path().join("moved-workspace");
        fs::create_dir(&workspace_path).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let workspace = CoreWorkspace::open(&workspace_path).unwrap();
        let expected_root = workspace.workspace().root;
        let bundle = ZipBundle::new(Arc::new(stored_zip("hello.txt", b"hello"))).unwrap();
        let plan = bundle
            .plan(&workspace, &expected_root, ArchiveExtractOptions::default())
            .unwrap();

        fs::rename(&workspace_path, &moved_path).unwrap();
        std::os::unix::fs::symlink(outside.path(), &workspace_path).unwrap();

        assert!(bundle
            .extract(
                &workspace,
                &expected_root,
                &plan,
                &CancellationToken::default(),
                |_| {},
            )
            .is_err());
        assert!(!outside.path().join(&plan.destination).exists());
    }

    fn stored_zip(name: &str, contents: &[u8]) -> Vec<u8> {
        stored_zip_with_declared_size(name, contents, contents.len() as u32)
    }

    fn stored_zip_with_declared_size(
        name: &str,
        contents: &[u8],
        declared_uncompressed_size: u32,
    ) -> Vec<u8> {
        let name = name.as_bytes();
        let compressed_size = contents.len() as u32;
        let crc = crc32(contents);
        let mut zip = Vec::new();

        push_u32(&mut zip, 0x0403_4b50);
        push_u16(&mut zip, 20);
        push_u16(&mut zip, 0);
        push_u16(&mut zip, 0);
        push_u16(&mut zip, 0);
        push_u16(&mut zip, 0);
        push_u32(&mut zip, crc);
        push_u32(&mut zip, compressed_size);
        push_u32(&mut zip, declared_uncompressed_size);
        push_u16(&mut zip, name.len() as u16);
        push_u16(&mut zip, 0);
        zip.extend_from_slice(name);
        zip.extend_from_slice(contents);
        let central_offset = zip.len() as u32;

        push_u32(&mut zip, 0x0201_4b50);
        push_u16(&mut zip, 20);
        push_u16(&mut zip, 20);
        push_u16(&mut zip, 0);
        push_u16(&mut zip, 0);
        push_u16(&mut zip, 0);
        push_u16(&mut zip, 0);
        push_u32(&mut zip, crc);
        push_u32(&mut zip, compressed_size);
        push_u32(&mut zip, declared_uncompressed_size);
        push_u16(&mut zip, name.len() as u16);
        push_u16(&mut zip, 0);
        push_u16(&mut zip, 0);
        push_u16(&mut zip, 0);
        push_u16(&mut zip, 0);
        push_u32(&mut zip, 0);
        push_u32(&mut zip, 0);
        zip.extend_from_slice(name);
        let central_size = zip.len() as u32 - central_offset;

        push_u32(&mut zip, 0x0605_4b50);
        push_u16(&mut zip, 0);
        push_u16(&mut zip, 0);
        push_u16(&mut zip, 1);
        push_u16(&mut zip, 1);
        push_u32(&mut zip, central_size);
        push_u32(&mut zip, central_offset);
        push_u16(&mut zip, 0);
        zip
    }

    fn push_u16(bytes: &mut Vec<u8>, value: u16) {
        bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn push_u32(bytes: &mut Vec<u8>, value: u32) {
        bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = !0u32;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb8_8320 & (0u32.wrapping_sub(crc & 1)));
            }
        }
        !crc
    }
}
