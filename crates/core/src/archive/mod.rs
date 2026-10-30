//! Archive viewer backend (ADR 0016): bounded listing, single entry preview and
//! user initiated extraction of ZIP family and tar archives.
//!
//! Nothing here ever uses an archive library's own extract helper. Listing reads
//! only metadata (the ZIP central directory, tar headers). Extraction writes
//! through a cap-std directory capability into a fresh staging folder inside
//! the destination, then publishes it with the same no-replace clash policy as
//! an Explorer import. Links, devices, unsafe names and colliding names are
//! never written. None of this is reachable from agent tools or MCP.
mod names;
#[cfg(test)]
mod tests;

use crate::fs_ops::{open_copy_source, ImportOutcome};
use crate::{CancellationToken, ConflictPolicy, CoreError, CoreWorkspace, Result};
use cap_fs_ext::DirExt;
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
pub use names::{MAX_ARCHIVE_COMPONENT_BYTES, MAX_ARCHIVE_DEPTH, MAX_ARCHIVE_PATH_BYTES};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Most entries listed. A longer archive is listed up to here and cannot be extracted.
pub const MAX_ARCHIVE_ENTRIES: usize = 50_000;
/// Default cap on the bytes one extraction writes (a user setting can change it).
pub const DEFAULT_ARCHIVE_EXTRACT_BYTES: u64 = 1024 * 1024 * 1024;
/// Largest single file an extraction writes.
pub const MAX_ARCHIVE_FILE_BYTES: u64 = 512 * 1024 * 1024;
/// Highest accepted expansion ratio (uncompressed to compressed) above the floor.
pub const MAX_ARCHIVE_RATIO: u64 = 200;
/// Entries smaller than this are never refused for their ratio.
pub const ARCHIVE_RATIO_FLOOR: u64 = 1024 * 1024;
/// Most bytes one entry preview reads.
pub const MAX_ARCHIVE_PREVIEW_BYTES: u64 = 1024 * 1024;
/// Most bytes read (decompressed) while walking a tar stream.
const MAX_TAR_SCAN_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;
const PROGRESS_STEP: u64 = 1024 * 1024;
static STAGING_ID: AtomicU64 = AtomicU64::new(1);

/// Bounds of one archive operation. Declared sizes are reported, never trusted:
/// every byte actually read or written is counted against these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchiveLimits {
    pub max_entries: usize,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    pub max_ratio: u64,
    pub ratio_floor: u64,
    pub max_scan_bytes: u64,
}
impl Default for ArchiveLimits {
    fn default() -> Self {
        Self {
            max_entries: MAX_ARCHIVE_ENTRIES,
            max_total_bytes: DEFAULT_ARCHIVE_EXTRACT_BYTES,
            max_file_bytes: MAX_ARCHIVE_FILE_BYTES,
            max_ratio: MAX_ARCHIVE_RATIO,
            ratio_floor: ARCHIVE_RATIO_FLOOR,
            max_scan_bytes: MAX_TAR_SCAN_BYTES,
        }
    }
}
impl ArchiveLimits {
    /// The defaults with a different total extraction cap (the user setting).
    pub fn with_total_bytes(max_total_bytes: u64) -> Self {
        Self {
            max_total_bytes: max_total_bytes.max(1),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveEntryKind {
    File,
    Directory,
    Symlink,
    HardLink,
    Special,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    /// Stored name, truncated for display at 1,024 bytes.
    pub path: String,
    pub dir: bool,
    pub kind: ArchiveEntryKind,
    /// Declared uncompressed size. Reported, not trusted.
    pub size: u64,
    /// Compressed size (equal to `size` for tar).
    pub packed: u64,
    /// Milliseconds since the epoch, when the archive records it.
    pub modified: Option<u64>,
    pub encrypted: bool,
    pub executable: bool,
    /// Why this entry is never previewed or extracted.
    pub unsafe_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveListing {
    /// "ZIP", "TAR" or "TAR.GZ".
    pub format: String,
    /// Compression methods seen, for ZIP.
    pub method: Option<String>,
    pub entries: Vec<ArchiveEntry>,
    /// More than the entry cap: only the first entries are listed.
    pub truncated: bool,
    /// Sum of the declared sizes of listed files. Reported, not trusted.
    pub declared_size: u64,
    /// Size of the archive file itself.
    pub archive_size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ArchivePreviewKind {
    Text,
    Image,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveEntryPreview {
    pub kind: ArchivePreviewKind,
    pub bytes: Vec<u8>,
    /// Text cut at the preview cap.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveExtractOptions {
    /// Exact listing paths (files or folders). `None` means every safe file.
    pub paths: Option<Vec<String>>,
    pub keep_structure: bool,
    pub skip_hidden: bool,
    /// Keep the executable bit of entries that had it. Off by default.
    pub keep_executable: bool,
}
impl Default for ArchiveExtractOptions {
    fn default() -> Self {
        Self {
            paths: None,
            keep_structure: true,
            skip_hidden: false,
            keep_executable: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveSkip {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePlan {
    /// Workspace relative path the new folder would get without a clash.
    pub destination: String,
    pub files: u32,
    pub bytes: u64,
    /// The destination name when it is already taken.
    pub conflicts: Vec<String>,
    pub skipped: Vec<ArchiveSkip>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveExtractProgress {
    pub entries: u32,
    pub total_entries: u32,
    pub bytes: u64,
    pub total_bytes: u64,
    pub current: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveExtractReport {
    /// Workspace relative path of the new folder. Nothing is created on
    /// cancellation or failure.
    pub created: Option<String>,
    /// Set when Replace moved an existing item to the system Trash.
    pub replaced: Option<String>,
    /// The Skip policy left an existing folder alone.
    pub skipped_existing: bool,
    pub skipped: Vec<ArchiveSkip>,
    pub entries: u32,
    pub bytes: u64,
    pub cancelled: bool,
    pub error: Option<String>,
}

fn archive_error(message: impl Into<String>) -> CoreError {
    CoreError::Archive(message.into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Zip,
    Tar,
    TarGz,
}
impl Format {
    fn label(self) -> &'static str {
        match self {
            Format::Zip => "ZIP",
            Format::Tar => "TAR",
            Format::TarGz => "TAR.GZ",
        }
    }
}

/// An opened archive file. The file is opened once without following a final
/// symbolic link; every operation re-reads its metadata from that handle.
pub struct ArchiveSource {
    file: File,
    format: Format,
    size: u64,
    name: String,
}

struct Inspected {
    entries: Vec<ArchiveEntry>,
    /// Safe relative output path per entry, `None` when refused.
    safe: Vec<Option<String>>,
    truncated: bool,
    methods: Vec<String>,
}

impl ArchiveSource {
    pub fn open(path: &Path) -> Result<Self> {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        Self::open_named(path, &name)
    }

    /// Opens `path` using `name` (an upload's display name) for the format
    /// fallback and the default folder name.
    pub fn open_named(path: &Path, name: &str) -> Result<Self> {
        let name = name.to_owned();
        let file =
            open_copy_source(path).map_err(|error| crate::io_error("Open archive", path, error))?;
        let metadata = file
            .metadata()
            .map_err(|error| crate::io_error("Inspect archive", path, error))?;
        if !metadata.is_file() {
            return Err(archive_error(
                "Only regular files can be opened as archives",
            ));
        }
        let mut head = [0u8; 512];
        let mut read = 0;
        let mut reader = &file;
        while read < head.len() {
            match reader.read(&mut head[read..]) {
                Ok(0) => break,
                Ok(count) => read += count,
                Err(error) => return Err(crate::io_error("Read archive", path, error)),
            }
        }
        let head = &head[..read];
        let lower = name.to_ascii_lowercase();
        let format = if head.starts_with(b"PK\x03\x04")
            || head.starts_with(b"PK\x05\x06")
            || head.starts_with(b"PK\x07\x08")
        {
            Format::Zip
        } else if head.starts_with(&[0x1f, 0x8b]) {
            Format::TarGz
        } else if (head.len() >= 262 && &head[257..262] == b"ustar") || lower.ends_with(".tar") {
            Format::Tar
        } else if is_zip_family(&lower) {
            // Self extracting or prefixed ZIP files keep their directory at the end.
            Format::Zip
        } else {
            return Err(archive_error(
                "This file is not a supported archive (ZIP, tar or tar.gz)",
            ));
        };
        Ok(Self {
            file,
            format,
            size: metadata.len(),
            name,
        })
    }

    /// Default folder name for "Extract here": the archive name without its extension.
    pub fn folder_name(&self) -> String {
        default_folder_name(&self.name)
    }

    fn rewind(&self) -> Result<BufReader<&File>> {
        let mut handle = &self.file;
        handle
            .seek(SeekFrom::Start(0))
            .map_err(|error| archive_error(format!("Cannot read the archive: {error}")))?;
        Ok(BufReader::with_capacity(CHUNK, handle))
    }

    fn zip(&self) -> Result<zip::ZipArchive<BufReader<&File>>> {
        zip::ZipArchive::new(self.rewind()?).map_err(|error| {
            archive_error(format!("This archive is damaged or incomplete: {error}"))
        })
    }

    fn tar(&self, limits: &ArchiveLimits) -> Result<tar::Archive<Bounded<Box<dyn Read + '_>>>> {
        let raw = self.rewind()?;
        let (stream, compressed): (Box<dyn Read + '_>, Option<u64>) = match self.format {
            Format::TarGz => (Box::new(flate2::read::GzDecoder::new(raw)), Some(self.size)),
            _ => (Box::new(raw), None),
        };
        Ok(tar::Archive::new(Bounded {
            inner: stream,
            read: 0,
            max: limits.max_scan_bytes,
            compressed,
            ratio: limits.max_ratio,
            floor: limits.ratio_floor,
        }))
    }

    pub fn list(&self, limits: &ArchiveLimits) -> Result<ArchiveListing> {
        let inspected = self.inspect(limits)?;
        let declared_size = inspected
            .entries
            .iter()
            .filter(|entry| !entry.dir)
            .fold(0u64, |sum, entry| sum.saturating_add(entry.size));
        Ok(ArchiveListing {
            format: self.format.label().into(),
            method: (!inspected.methods.is_empty()).then(|| inspected.methods.join(", ")),
            entries: inspected.entries,
            truncated: inspected.truncated,
            declared_size,
            archive_size: self.size,
        })
    }

    fn inspect(&self, limits: &ArchiveLimits) -> Result<Inspected> {
        let mut inspected = match self.format {
            Format::Zip => self.inspect_zip(limits)?,
            Format::Tar | Format::TarGz => self.inspect_tar(limits)?,
        };
        let items: Vec<(usize, &str, bool)> = inspected
            .safe
            .iter()
            .enumerate()
            .filter_map(|(index, safe)| {
                safe.as_deref()
                    .map(|path| (index, path, inspected.entries[index].dir))
            })
            .collect();
        let refused = names::collisions(&items);
        for index in refused {
            inspected.safe[index] = None;
            inspected.entries[index]
                .unsafe_reason
                .get_or_insert_with(|| {
                    "name collides with another entry after case folding or Unicode normalisation"
                        .into()
                });
        }
        Ok(inspected)
    }

    fn inspect_zip(&self, limits: &ArchiveLimits) -> Result<Inspected> {
        let archive = self.zip()?;
        let count = archive.len();
        let listed = count.min(limits.max_entries);
        let mut methods = Vec::new();
        let mut entries = Vec::with_capacity(listed);
        let mut safe = Vec::with_capacity(listed);
        for index in 0..listed {
            let file = archive.by_index_data(index).map_err(|error| {
                archive_error(format!("This archive is damaged or incomplete: {error}"))
            })?;
            let (raw, name_error) = match file.name() {
                Ok(name) => (name.into_owned(), None),
                Err(_) => (
                    String::from_utf8_lossy(file.name_raw()).into_owned(),
                    Some("name is not valid text"),
                ),
            };
            let mode = file.unix_mode();
            let kind = match mode.map(|mode| mode & 0o170000) {
                Some(0o120000) => ArchiveEntryKind::Symlink,
                Some(0o040000) => ArchiveEntryKind::Directory,
                Some(0) | Some(0o100000) | None => {
                    if file.is_dir() {
                        ArchiveEntryKind::Directory
                    } else {
                        ArchiveEntryKind::File
                    }
                }
                Some(_) => ArchiveEntryKind::Special,
            };
            let dir = kind == ArchiveEntryKind::Directory;
            let method = file.compression();
            let method_name = match method {
                zip::CompressionMethod::Stored => "Stored".to_owned(),
                zip::CompressionMethod::Deflated => "Deflate".to_owned(),
                other => format!("{other:?}"),
            };
            if !dir && !methods.contains(&method_name) {
                methods.push(method_name.clone());
            }
            let supported = matches!(
                method,
                zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated
            );
            let entry = ArchiveEntry {
                path: names::display_name(&raw),
                dir,
                kind,
                size: file.size(),
                packed: file.compressed_size(),
                modified: file.last_modified().and_then(|time| {
                    civil_ms(
                        time.year().into(),
                        time.month().into(),
                        time.day().into(),
                        time.hour().into(),
                        time.minute().into(),
                        time.second().into(),
                    )
                }),
                encrypted: file.encrypted(),
                executable: kind == ArchiveEntryKind::File
                    && mode.is_some_and(|mode| mode & 0o111 != 0),
                unsafe_reason: None,
            };
            let unsupported = (!dir && !supported)
                .then(|| format!("unsupported compression method ({method_name})"));
            let (entry, path) = judge(entry, &raw, name_error, unsupported, limits, true);
            entries.push(entry);
            safe.push(path);
        }
        Ok(Inspected {
            entries,
            safe,
            truncated: count > listed,
            methods,
        })
    }

    fn inspect_tar(&self, limits: &ArchiveLimits) -> Result<Inspected> {
        let mut archive = self.tar(limits)?;
        let mut entries = Vec::new();
        let mut safe = Vec::new();
        let mut truncated = false;
        for item in archive.entries().map_err(tar_error)? {
            let entry = item.map_err(tar_error)?;
            let Some(kind) = tar_kind(entry.header().entry_type()) else {
                continue;
            };
            if entries.len() >= limits.max_entries {
                truncated = true;
                break;
            }
            let bytes = entry.path_bytes();
            let (raw, name_error) = match std::str::from_utf8(&bytes) {
                Ok(name) => (name.to_owned(), None),
                Err(_) => (
                    String::from_utf8_lossy(&bytes).into_owned(),
                    Some("name is not valid text"),
                ),
            };
            let header = entry.header();
            let dir = kind == TarKind::Plain(ArchiveEntryKind::Directory);
            let size = entry.size();
            let view = ArchiveEntry {
                path: names::display_name(&raw),
                dir,
                kind: kind.view(),
                size: if dir { 0 } else { size },
                packed: if dir { 0 } else { size },
                modified: header
                    .mtime()
                    .ok()
                    .map(|seconds| seconds.saturating_mul(1000)),
                encrypted: false,
                executable: kind == TarKind::Plain(ArchiveEntryKind::File)
                    && header.mode().is_ok_and(|mode| mode & 0o111 != 0),
                unsafe_reason: None,
            };
            let other = match kind {
                TarKind::Sparse => Some("sparse file".to_owned()),
                TarKind::Unsupported => Some("unsupported tar entry type".to_owned()),
                TarKind::Plain(_) => None,
            };
            let (view, path) = judge(view, &raw, name_error, other, limits, false);
            entries.push(view);
            safe.push(path);
        }
        Ok(Inspected {
            entries,
            safe,
            truncated,
            methods: Vec::new(),
        })
    }

    /// Reads one text or image entry for preview, at most 1 MiB.
    pub fn read_entry(&self, path: &str, limits: &ArchiveLimits) -> Result<ArchiveEntryPreview> {
        let inspected = self.inspect(limits)?;
        let mut found = None;
        let mut refusal = None;
        for (index, entry) in inspected.entries.iter().enumerate() {
            if entry.path != path {
                continue;
            }
            if entry.dir {
                refusal.get_or_insert_with(|| "it is a folder".to_owned());
            } else if let Some(reason) = &entry.unsafe_reason {
                refusal.get_or_insert_with(|| reason.clone());
            } else if inspected.safe[index].is_some() {
                found = Some(index);
                break;
            }
        }
        let Some(index) = found else {
            return Err(archive_error(match refusal {
                Some(reason) => format!("{path} cannot be previewed: {reason}"),
                None => format!("{path} is not in this archive"),
            }));
        };
        let lower = path.to_ascii_lowercase();
        if is_archive_name(&lower) {
            return Err(archive_error(
                "Nested archives are listed as entries and are never opened",
            ));
        }
        let image = is_image_name(&lower);
        let declared = inspected.entries[index].size;
        if image && declared > MAX_ARCHIVE_PREVIEW_BYTES {
            return Err(archive_error("Images larger than 1 MiB are not previewed"));
        }
        let cap = MAX_ARCHIVE_PREVIEW_BYTES;
        let mut bytes = Vec::new();
        match self.format {
            Format::Zip => {
                let mut archive = self.zip()?;
                let file = archive
                    .by_index(index)
                    .map_err(|error| archive_error(format!("Cannot read {path}: {error}")))?;
                file.take(cap + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|error| archive_error(format!("Cannot read {path}: {error}")))?;
            }
            Format::Tar | Format::TarGz => {
                let mut archive = self.tar(limits)?;
                let mut position = 0;
                for item in archive.entries().map_err(tar_error)? {
                    let entry = item.map_err(tar_error)?;
                    if tar_kind(entry.header().entry_type()).is_none() {
                        continue;
                    }
                    if position == index {
                        entry
                            .take(cap + 1)
                            .read_to_end(&mut bytes)
                            .map_err(|error| {
                                archive_error(format!("Cannot read {path}: {error}"))
                            })?;
                        break;
                    }
                    position += 1;
                }
            }
        }
        let truncated = bytes.len() as u64 > cap;
        bytes.truncate(cap as usize);
        if image {
            if truncated {
                return Err(archive_error("Images larger than 1 MiB are not previewed"));
            }
            return Ok(ArchiveEntryPreview {
                kind: ArchivePreviewKind::Image,
                bytes,
                truncated: false,
            });
        }
        if !looks_like_text(&bytes, truncated) {
            return Err(archive_error("Only text and images can be previewed"));
        }
        Ok(ArchiveEntryPreview {
            kind: ArchivePreviewKind::Text,
            bytes,
            truncated,
        })
    }

    /// What an extraction of `options` would write into `target`.
    pub fn plan(
        &self,
        target: &ExtractTarget,
        options: &ArchiveExtractOptions,
        limits: &ArchiveLimits,
    ) -> Result<ArchivePlan> {
        let inspected = self.inspect(limits)?;
        let selection = select(&inspected, options, limits)?;
        Ok(ArchivePlan {
            destination: target.destination(),
            files: selection.files.len() as u32,
            bytes: selection.bytes,
            conflicts: if target.folder_taken() {
                vec![target.folder_name.clone()]
            } else {
                Vec::new()
            },
            skipped: selection.skipped,
        })
    }

    /// Writes the selection into a fresh staging folder inside `target`. On
    /// cancellation or any failure the staging folder is removed and nothing
    /// stays behind. Call [`CoreWorkspace::publish_archive_extract`] after a
    /// successful run.
    pub fn extract_to_staging(
        &self,
        target: &ExtractTarget,
        options: &ArchiveExtractOptions,
        limits: &ArchiveLimits,
        cancellation: &CancellationToken,
        progress: &mut dyn FnMut(ArchiveExtractProgress),
    ) -> Result<StagedExtract> {
        let inspected = self.inspect(limits)?;
        let selection = select(&inspected, options, limits)?;
        let target_dir = open_dir_nofollow(&target.target)
            .map_err(|error| crate::io_error("Open extraction folder", &target.target, error))?;
        // The capability is held from here; make sure it is still the checked folder.
        let still = std::fs::canonicalize(&target.target).ok();
        if still.as_deref() != Some(target.target.as_path()) {
            return Err(archive_error("The extraction folder changed; try again"));
        }
        let staging_name = format!(
            ".span-extract-{}-{}",
            std::process::id(),
            STAGING_ID.fetch_add(1, Ordering::Relaxed)
        );
        target_dir
            .create_dir(&staging_name)
            .map_err(|error| crate::io_error("Create staging folder", &target.target, error))?;
        let mut staged = StagedExtract {
            staging_name,
            skipped: selection.skipped.clone(),
            entries: 0,
            bytes: 0,
            cancelled: false,
            error: None,
        };
        let outcome = target_dir
            .open_dir_nofollow(&staged.staging_name)
            .map_err(|error| error.to_string())
            .and_then(|staging| {
                let mut writer = Writer {
                    staging: &staging,
                    limits,
                    keep_executable: options.keep_executable,
                    cancellation,
                    progress,
                    state: ArchiveExtractProgress {
                        total_entries: selection.files.len() as u32,
                        total_bytes: selection.bytes,
                        ..ArchiveExtractProgress::default()
                    },
                    reported_at: 0,
                };
                (writer.progress)(writer.state.clone());
                for dir in &selection.dirs {
                    writer.make_dirs(dir, true)?;
                }
                let result = self.write_selection(&selection, &mut writer);
                staged.entries = writer.state.entries;
                staged.bytes = writer.state.bytes;
                (writer.progress)(writer.state.clone());
                result
            });
        match outcome {
            Ok(()) => {}
            Err(reason) => {
                if cancellation.is_cancelled() {
                    staged.cancelled = true;
                } else {
                    staged.error = Some(reason);
                }
                if let Err(error) = target_dir.remove_dir_all(&staged.staging_name) {
                    let note = format!("The staging folder could not be removed: {error}");
                    staged.error = Some(match staged.error.take() {
                        Some(reason) => format!("{reason}. {note}"),
                        None => note,
                    });
                }
            }
        }
        Ok(staged)
    }

    fn write_selection(
        &self,
        selection: &Selection,
        writer: &mut Writer<'_>,
    ) -> std::result::Result<(), String> {
        match self.format {
            Format::Zip => {
                let mut archive = self.zip().map_err(|error| error.to_string())?;
                for (index, item) in &selection.files {
                    let file = archive
                        .by_index(*index)
                        .map_err(|error| format!("Cannot read {}: {error}", item.source))?;
                    writer.write_file(item, file)?;
                }
                Ok(())
            }
            Format::Tar | Format::TarGz => {
                let Some(last) = selection.files.keys().next_back().copied() else {
                    return Ok(());
                };
                let mut archive = self.tar(writer.limits).map_err(|error| error.to_string())?;
                let mut position = 0;
                for item in archive
                    .entries()
                    .map_err(|error| tar_error(error).to_string())?
                {
                    let entry = item.map_err(|error| tar_error(error).to_string())?;
                    if tar_kind(entry.header().entry_type()).is_none() {
                        continue;
                    }
                    if let Some(file) = selection.files.get(&position) {
                        writer.write_file(file, entry)?;
                    } else {
                        writer.check()?;
                    }
                    if position == last {
                        break;
                    }
                    position += 1;
                }
                if position < last {
                    return Err("The archive ended before every selected entry was read".into());
                }
                Ok(())
            }
        }
    }
}

/// A checked extraction destination: an existing workspace folder plus the
/// name of the new folder the archive goes into.
#[derive(Debug, Clone)]
pub struct ExtractTarget {
    root: PathBuf,
    target: PathBuf,
    folder_name: String,
}
impl ExtractTarget {
    fn destination(&self) -> String {
        let folder = self.target.join(&self.folder_name);
        folder
            .strip_prefix(&self.root)
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| self.folder_name.clone())
    }
    fn folder_taken(&self) -> bool {
        self.target
            .join(&self.folder_name)
            .symlink_metadata()
            .is_ok()
    }
}

/// A finished staging folder waiting to be published, or the reason it was discarded.
#[derive(Debug, Clone)]
pub struct StagedExtract {
    staging_name: String,
    pub skipped: Vec<ArchiveSkip>,
    pub entries: u32,
    pub bytes: u64,
    pub cancelled: bool,
    pub error: Option<String>,
}

impl CoreWorkspace {
    /// Checks an extraction destination: `target_dir` must be an existing
    /// workspace folder that is not a symbolic link and not inside `.git`, the
    /// same rules as an Explorer import. `folder_name` must be one plain name.
    pub fn archive_extract_target(
        &self,
        target_dir: &str,
        folder_name: &str,
    ) -> Result<ExtractTarget> {
        let target = self.import_target(target_dir)?;
        match names::safe_relative_path(folder_name) {
            Ok(name) if !name.contains('/') && !name.starts_with('.') => {}
            _ => return Err(archive_error("The new folder needs a plain name")),
        }
        Ok(ExtractTarget {
            root: self.root.clone(),
            target,
            folder_name: folder_name.to_owned(),
        })
    }

    /// Publishes a staging folder under the destination name with the Explorer
    /// clash policy: Keep both adds " copy", Skip leaves the existing item and
    /// discards the staging folder, Replace moves the existing item to the Trash.
    pub fn publish_archive_extract(
        &mut self,
        target: &ExtractTarget,
        staged: StagedExtract,
        policy: ConflictPolicy,
    ) -> Result<ArchiveExtractReport> {
        self.publish_archive_extract_with(target, staged, policy, &mut |resolved| {
            trash::delete(resolved).map_err(|error| {
                CoreError::InvalidEdit(format!(
                    "Move {} to system Trash: {error}",
                    resolved.display()
                ))
            })
        })
    }

    pub(crate) fn publish_archive_extract_with(
        &mut self,
        target: &ExtractTarget,
        staged: StagedExtract,
        policy: ConflictPolicy,
        trash: &mut dyn FnMut(&Path) -> Result<()>,
    ) -> Result<ArchiveExtractReport> {
        let mut report = ArchiveExtractReport {
            skipped: staged.skipped.clone(),
            entries: staged.entries,
            bytes: staged.bytes,
            cancelled: staged.cancelled,
            error: staged.error.clone(),
            ..ArchiveExtractReport::default()
        };
        if staged.cancelled || staged.error.is_some() {
            return Ok(report);
        }
        let staging = target.target.join(&staged.staging_name);
        let discard = |staging: &Path| {
            let _ = std::fs::remove_dir_all(staging);
        };
        let relative = self.relative(&target.target)?;
        let checked = self.import_target(&relative);
        if checked.as_ref().ok() != Some(&target.target) {
            discard(&staging);
            return Err(checked.err().unwrap_or_else(|| {
                archive_error("The extraction folder changed; nothing was extracted")
            }));
        }
        let wanted = target.target.join(&target.folder_name);
        let clash = wanted.symlink_metadata().is_ok();
        if clash && policy == ConflictPolicy::Skip {
            discard(&staging);
            report.skipped_existing = true;
            return Ok(report);
        }
        match self.publish_import(
            &staging,
            &target.target,
            &wanted,
            &target.folder_name,
            clash,
            policy,
            true,
            trash,
        ) {
            Ok(ImportOutcome::Created(path)) => report.created = Some(path),
            Ok(ImportOutcome::Replaced(path)) => {
                report.replaced = Some(path.clone());
                report.created = Some(path);
            }
            Ok(ImportOutcome::Skipped) => report.skipped_existing = true,
            Err(error) => {
                discard(&staging);
                return Err(error);
            }
        }
        Ok(report)
    }

    /// Plans, stages and publishes in one call. The desktop layer runs the
    /// phases separately so the workspace lock is not held while writing.
    #[allow(clippy::too_many_arguments)]
    pub fn extract_archive(
        &mut self,
        source: &ArchiveSource,
        target_dir: &str,
        folder_name: &str,
        policy: ConflictPolicy,
        options: &ArchiveExtractOptions,
        limits: &ArchiveLimits,
        cancellation: &CancellationToken,
        progress: &mut dyn FnMut(ArchiveExtractProgress),
    ) -> Result<ArchiveExtractReport> {
        let target = self.archive_extract_target(target_dir, folder_name)?;
        let staged = source.extract_to_staging(&target, options, limits, cancellation, progress)?;
        self.publish_archive_extract(&target, staged, policy)
    }
}

struct SelectedFile {
    source: String,
    output: String,
    size: u64,
    packed: Option<u64>,
    executable: bool,
}

struct Selection {
    /// Archive index to file, in archive order.
    files: BTreeMap<usize, SelectedFile>,
    dirs: Vec<String>,
    skipped: Vec<ArchiveSkip>,
    bytes: u64,
}

fn select(
    inspected: &Inspected,
    options: &ArchiveExtractOptions,
    limits: &ArchiveLimits,
) -> Result<Selection> {
    if inspected.truncated {
        return Err(archive_error(format!(
            "This archive has more than {} entries and cannot be extracted",
            limits.max_entries
        )));
    }
    let roots: Option<Vec<&str>> = options.paths.as_ref().map(|paths| {
        paths
            .iter()
            .map(|path| path.trim_end_matches('/'))
            .collect()
    });
    if let Some(roots) = &roots {
        if roots.len() > limits.max_entries {
            return Err(archive_error("The selection has too many paths"));
        }
        let known: HashSet<&str> = inspected
            .entries
            .iter()
            .map(|entry| entry.path.trim_end_matches('/'))
            .collect();
        // Folder rows the viewer builds from children may have no entry of their own.
        if let Some(missing) = roots.iter().find(|root| {
            !known.contains(*root)
                && !inspected
                    .entries
                    .iter()
                    .any(|entry| entry.path.starts_with(&format!("{root}/")))
        }) {
            return Err(archive_error(format!("{missing} is not in this archive")));
        }
    }
    let mut selection = Selection {
        files: BTreeMap::new(),
        dirs: Vec::new(),
        skipped: Vec::new(),
        bytes: 0,
    };
    let mut outputs = HashSet::new();
    for (index, entry) in inspected.entries.iter().enumerate() {
        let requested = roots.as_ref().is_none_or(|roots| {
            roots.iter().any(|root| {
                let path = entry.path.trim_end_matches('/');
                path == *root || path.starts_with(&format!("{root}/"))
            })
        });
        if !requested {
            continue;
        }
        let Some(safe) = &inspected.safe[index] else {
            selection.skipped.push(ArchiveSkip {
                path: entry.path.clone(),
                reason: entry
                    .unsafe_reason
                    .clone()
                    .unwrap_or_else(|| "unsafe entry".into()),
            });
            continue;
        };
        if options.skip_hidden && names::is_hidden(safe) {
            selection.skipped.push(ArchiveSkip {
                path: entry.path.clone(),
                reason: "hidden file".into(),
            });
            continue;
        }
        if entry.dir {
            if options.keep_structure {
                selection.dirs.push(safe.clone());
            }
            continue;
        }
        let output = if options.keep_structure {
            safe.clone()
        } else {
            safe.rsplit('/').next().unwrap_or(safe).to_owned()
        };
        if !outputs.insert(names::collision_key(&output)) {
            return Err(archive_error(format!(
                "Two selected files would both be written as {output}; keep the folder structure"
            )));
        }
        selection.bytes = selection.bytes.saturating_add(entry.size);
        if selection.bytes > limits.max_total_bytes {
            return Err(archive_error(format!(
                "The selection expands to more than {}, the extraction limit",
                format_bytes(limits.max_total_bytes)
            )));
        }
        selection.files.insert(
            index,
            SelectedFile {
                source: entry.path.clone(),
                output,
                size: entry.size,
                packed: (entry.kind == ArchiveEntryKind::File && entry.packed != entry.size)
                    .then_some(entry.packed),
                executable: entry.executable,
            },
        );
    }
    if selection.files.is_empty() && selection.dirs.is_empty() {
        return Err(archive_error(
            "Nothing in the selection can be extracted safely",
        ));
    }
    Ok(selection)
}

/// Applies the entry rules: name, kind, encryption, size and ratio.
fn judge(
    mut entry: ArchiveEntry,
    raw: &str,
    name_error: Option<&'static str>,
    other: Option<String>,
    limits: &ArchiveLimits,
    ratio: bool,
) -> (ArchiveEntry, Option<String>) {
    let safe = names::safe_relative_path(raw);
    let reason = if let Some(error) = name_error {
        Some(error.to_owned())
    } else if let Err(error) = &safe {
        Some((*error).to_owned())
    } else {
        match entry.kind {
            ArchiveEntryKind::Symlink => Some("symbolic link (links are never extracted)".into()),
            ArchiveEntryKind::HardLink => Some("hard link (links are never extracted)".into()),
            ArchiveEntryKind::Special => Some("device or special file".into()),
            _ if entry.encrypted => Some("encrypted".into()),
            _ if other.is_some() => other,
            _ if !entry.dir && entry.size > limits.max_file_bytes => Some(format!(
                "larger than {}, the per file limit",
                format_bytes(limits.max_file_bytes)
            )),
            _ if ratio
                && !entry.dir
                && entry.size >= limits.ratio_floor
                && entry.size > entry.packed.saturating_mul(limits.max_ratio) =>
            {
                Some(format!("compression ratio above {}:1", limits.max_ratio))
            }
            _ => None,
        }
    };
    let path = if reason.is_none() { safe.ok() } else { None };
    entry.unsafe_reason = reason;
    (entry, path)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TarKind {
    Plain(ArchiveEntryKind),
    Sparse,
    Unsupported,
}
impl TarKind {
    fn view(self) -> ArchiveEntryKind {
        match self {
            TarKind::Plain(kind) => kind,
            TarKind::Sparse | TarKind::Unsupported => ArchiveEntryKind::Special,
        }
    }
}

/// `None` for metadata records (global pax headers) that are not entries.
fn tar_kind(kind: tar::EntryType) -> Option<TarKind> {
    use tar::EntryType as T;
    Some(match kind {
        T::Regular | T::Continuous => TarKind::Plain(ArchiveEntryKind::File),
        T::Directory => TarKind::Plain(ArchiveEntryKind::Directory),
        T::Symlink => TarKind::Plain(ArchiveEntryKind::Symlink),
        T::Link => TarKind::Plain(ArchiveEntryKind::HardLink),
        T::Char | T::Block | T::Fifo => TarKind::Plain(ArchiveEntryKind::Special),
        T::GNUSparse => TarKind::Sparse,
        T::XGlobalHeader => return None,
        _ => TarKind::Unsupported,
    })
}

fn tar_error(error: io::Error) -> CoreError {
    archive_error(format!("This archive is damaged or incomplete: {error}"))
}

/// Counts decompressed bytes of a tar stream and stops a gzip bomb early.
struct Bounded<R> {
    inner: R,
    read: u64,
    max: u64,
    compressed: Option<u64>,
    ratio: u64,
    floor: u64,
}
impl<R: Read> Read for Bounded<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.inner.read(buffer)?;
        self.read = self.read.saturating_add(count as u64);
        if self.read > self.max {
            return Err(io::Error::other(
                "the archive is larger than the reading limit",
            ));
        }
        if let Some(compressed) = self.compressed {
            if self.read >= self.floor && self.read > compressed.saturating_mul(self.ratio) {
                return Err(io::Error::other(format!(
                    "compression ratio above {}:1",
                    self.ratio
                )));
            }
        }
        Ok(count)
    }
}

struct Writer<'a> {
    staging: &'a Dir,
    limits: &'a ArchiveLimits,
    keep_executable: bool,
    cancellation: &'a CancellationToken,
    progress: &'a mut dyn FnMut(ArchiveExtractProgress),
    state: ArchiveExtractProgress,
    reported_at: u64,
}
impl Writer<'_> {
    fn check(&self) -> std::result::Result<(), String> {
        if self.cancellation.is_cancelled() {
            Err("cancelled".into())
        } else {
            Ok(())
        }
    }

    /// Opens (creating as needed) each folder of `path` without following links.
    /// With `whole`, every component is a folder; otherwise the last is the file name.
    fn make_dirs(&self, path: &str, whole: bool) -> std::result::Result<(Dir, String), String> {
        let mut parts: Vec<&str> = path.split('/').collect();
        let leaf = if whole {
            String::new()
        } else {
            parts.pop().unwrap_or_default().to_owned()
        };
        let mut dir = self
            .staging
            .try_clone()
            .map_err(|error| error.to_string())?;
        for part in parts {
            dir = match dir.open_dir_nofollow(part) {
                Ok(child) => child,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    dir.create_dir(part)
                        .map_err(|error| format!("Create folder {path}: {error}"))?;
                    dir.open_dir_nofollow(part)
                        .map_err(|error| format!("Open folder {path}: {error}"))?
                }
                Err(error) => return Err(format!("Open folder {path}: {error}")),
            };
        }
        Ok((dir, leaf))
    }

    fn write_file(
        &mut self,
        item: &SelectedFile,
        mut reader: impl Read,
    ) -> std::result::Result<(), String> {
        self.check()?;
        self.state.current = item.source.clone();
        let (dir, name) = self.make_dirs(&item.output, false)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        let mut file = dir
            .open_with(&name, &options)
            .map_err(|error| format!("Create {}: {error}", item.output))?;
        let mut written = 0u64;
        let mut chunk = vec![0u8; CHUNK];
        loop {
            self.check()?;
            let count = reader
                .read(&mut chunk)
                .map_err(|error| format!("Read {}: {error}", item.source))?;
            if count == 0 {
                break;
            }
            written += count as u64;
            if written > item.size {
                return Err(format!(
                    "{} holds more data than its header declares",
                    item.source
                ));
            }
            if written > self.limits.max_file_bytes {
                return Err(format!("{} is larger than the per file limit", item.source));
            }
            if let Some(packed) = item.packed {
                if written >= self.limits.ratio_floor
                    && written > packed.saturating_mul(self.limits.max_ratio)
                {
                    return Err(format!(
                        "{} expands above {}:1",
                        item.source, self.limits.max_ratio
                    ));
                }
            }
            self.state.bytes = self.state.bytes.saturating_add(count as u64);
            if self.state.bytes > self.limits.max_total_bytes {
                return Err(format!(
                    "The extraction passed {}, the limit",
                    format_bytes(self.limits.max_total_bytes)
                ));
            }
            file.write_all(&chunk[..count])
                .map_err(|error| format!("Write {}: {error}", item.output))?;
            if self.state.bytes - self.reported_at >= PROGRESS_STEP {
                self.reported_at = self.state.bytes;
                (self.progress)(self.state.clone());
            }
        }
        if written != item.size {
            return Err(format!(
                "{} holds less data than its header declares",
                item.source
            ));
        }
        file.flush()
            .map_err(|error| format!("Write {}: {error}", item.output))?;
        set_mode(&file, item.executable && self.keep_executable)
            .map_err(|error| format!("Set permissions of {}: {error}", item.output))?;
        self.state.entries += 1;
        (self.progress)(self.state.clone());
        Ok(())
    }
}

/// Owner read and write, read for others; owner, group and other execute only
/// when kept. Set-user-ID, set-group-ID and sticky bits are never set.
#[cfg(unix)]
fn set_mode(file: &cap_std::fs::File, executable: bool) -> io::Result<()> {
    use cap_std::fs::PermissionsExt;
    let mode = if executable { 0o755 } else { 0o644 };
    file.set_permissions(cap_std::fs::Permissions::from_mode(mode))
}
#[cfg(not(unix))]
fn set_mode(_: &cap_std::fs::File, _: bool) -> io::Result<()> {
    Ok(())
}

fn open_dir_nofollow(path: &Path) -> io::Result<Dir> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no parent folder"))?;
    let leaf = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no folder name"))?;
    Dir::open_ambient_dir(parent, ambient_authority())?.open_dir_nofollow(leaf)
}

fn looks_like_text(bytes: &[u8], truncated: bool) -> bool {
    if bytes.contains(&0) {
        return false;
    }
    match std::str::from_utf8(bytes) {
        Ok(_) => true,
        // A cut inside a multi byte character at the cap is still text.
        Err(error) => {
            truncated && error.error_len().is_none() && bytes.len() - error.valid_up_to() < 4
        }
    }
}

const ZIP_FAMILY: &[&str] = &[".zip", ".jar", ".war", ".apk", ".whl", ".vsix"];
const IMAGE_EXTENSIONS: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".svg",
];
const ARCHIVE_EXTENSIONS: &[&str] = &[
    ".zip", ".jar", ".war", ".apk", ".whl", ".vsix", ".tar", ".tgz", ".gz", ".7z", ".rar", ".bz2",
    ".xz", ".zst", ".ear", ".aar", ".nupkg",
];

fn is_zip_family(lower: &str) -> bool {
    ZIP_FAMILY
        .iter()
        .any(|extension| lower.ends_with(extension))
}
fn is_image_name(lower: &str) -> bool {
    IMAGE_EXTENSIONS
        .iter()
        .any(|extension| lower.ends_with(extension))
}
fn is_archive_name(lower: &str) -> bool {
    ARCHIVE_EXTENSIONS
        .iter()
        .any(|extension| lower.ends_with(extension))
}

/// `build.tar.gz` to `build`, `app.jar` to `app`.
pub fn default_folder_name(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    let stem = [".tar.gz", ".tgz", ".tar"]
        .iter()
        .chain(ZIP_FAMILY.iter())
        .find(|extension| lower.ends_with(*extension))
        .map(|extension| &name[..name.len() - extension.len()])
        .unwrap_or(name);
    let stem = stem.trim_matches(|c: char| c == '.' || c == ' ');
    match names::safe_relative_path(stem) {
        Ok(safe) if !safe.contains('/') && !stem.is_empty() => safe,
        _ => "extracted".into(),
    }
}

fn format_bytes(bytes: u64) -> String {
    const MIB: u64 = 1024 * 1024;
    if bytes >= 1024 * MIB && bytes.is_multiple_of(1024 * MIB) {
        format!("{} GiB", bytes / (1024 * MIB))
    } else if bytes >= MIB {
        format!("{} MiB", bytes / MIB)
    } else {
        format!("{bytes} bytes")
    }
}

/// Civil date and time (UTC assumed) to milliseconds since the epoch.
fn civil_ms(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64) -> Option<u64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second;
    u64::try_from(seconds).ok().map(|seconds| seconds * 1000)
}
