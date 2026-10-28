//! Archive viewing and safe extraction for ZIP, TAR and gzip-compressed TAR.
//!
//! Listing never writes anything. Extraction is two-phase (plan, then execute) and every
//! entry passes the rules in [`safety`] before a byte is written. Archives inside archives
//! are listed as ordinary files and never expanded.
mod extract;
mod safety;
#[cfg(test)]
mod tests;

pub use extract::{
    extract, plan_extract, ConflictAction, ConflictDecision, ConflictMode, ExistingKind,
    ExtractConflict, ExtractContext, ExtractFailure, ExtractOptions, ExtractPlan, ExtractProgress,
    ExtractReport, SkipReason, SkippedEntry, WrittenFile,
};

use crate::workspace::CoreWorkspace;
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::cell::Cell;
use std::fs::File;
use std::io::{self, BufReader, Cursor, Read, Seek};
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

/// Largest archive accepted from the workspace.
pub const MAX_ARCHIVE_SOURCE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Largest archive accepted inline from the UI (checked before base64 decoding).
pub const MAX_INLINE_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;

/// Hard caps. `Default` holds the production values; tests may tighten them.
#[derive(Debug, Clone)]
pub struct ArchiveLimits {
    /// Entries listed or extracted. Listing stops here and sets `truncated`; plans fail.
    pub max_entries: usize,
    /// Bytes of entry paths returned by one listing.
    pub max_listing_bytes: usize,
    /// Largest single entry, by header and while streaming.
    pub max_entry_bytes: u64,
    /// Largest total of one extraction, by header and while streaming.
    pub max_total_bytes: u64,
    /// Highest unpacked to packed ratio for one entry (zip bomb guard).
    pub max_ratio: u64,
    /// The ratio rule applies only to entries larger than this.
    pub ratio_floor: u64,
    /// Largest chunk returned by one entry read.
    pub max_read_len: u64,
}

impl Default for ArchiveLimits {
    fn default() -> Self {
        Self {
            max_entries: 50_000,
            max_listing_bytes: 8 * 1024 * 1024,
            max_entry_bytes: 1024 * 1024 * 1024,
            max_total_bytes: 4 * 1024 * 1024 * 1024,
            max_ratio: 250,
            ratio_floor: 1024 * 1024,
            max_read_len: 4 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveFormat {
    Zip,
    Tar,
    TarGz,
}

/// Why an entry is never written. Entries with a reason are always skipped and reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UnsafeReason {
    /// Empty name, or nothing left after dropping `.` components.
    Empty,
    /// Starts with `/` or `\`.
    Absolute,
    /// Starts with a drive such as `C:`.
    DrivePrefix,
    /// Starts with `\\` or `//` (UNC, device namespace).
    UncPrefix,
    /// Contains a `..` component.
    ParentTraversal,
    /// NUL or another control character.
    ControlCharacter,
    /// One of `<>:"|?*` in a component.
    InvalidCharacter,
    /// A component ends with a dot or a space.
    TrailingDotOrSpace,
    /// A Windows device name such as `CON` or `com1.txt`.
    ReservedName,
    /// Path over 4096 bytes or a component over 255 bytes.
    NameTooLong,
    /// Inside `.git`, `.span` or `node_modules`.
    ProtectedDirectory,
    /// Same path as another entry ignoring case, an exact duplicate, or a file that
    /// another entry needs as a folder.
    Collision,
    /// A symbolic link entry. Links are never created.
    Symlink,
    /// A hard link entry. Links are never created.
    Hardlink,
    /// A device, FIFO, socket or unknown entry type.
    SpecialFile,
    /// Larger than the per-entry cap.
    EntryTooLarge,
    /// Unpacks far larger than it is packed (zip bomb guard).
    CompressionRatio,
    /// Encrypted. Passwords are never tried.
    Encrypted,
    /// A compression method other than Stored or Deflate, or a sparse tar entry.
    UnsupportedMethod,
    /// A folder on disk (for example a symlink) would lead the write outside the
    /// destination. Found while extracting.
    EscapesDestination,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    /// Normalised path with `/` (no trailing slash) for safe entries. Unsafe entries show
    /// the raw name with control characters replaced by U+FFFD.
    pub path: String,
    pub is_dir: bool,
    /// Unpacked size from the header.
    pub size: u64,
    /// Compressed size, known for ZIP only.
    pub packed_size: Option<u64>,
    /// Milliseconds since the Unix epoch. ZIP times have no zone and are read as UTC.
    pub modified_ms: Option<i64>,
    pub unsafe_reason: Option<UnsafeReason>,
    pub is_symlink: bool,
}

#[derive(Debug, Clone, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveTotals {
    pub files: u32,
    /// Explicit folder entries plus folders implied by safe entry paths.
    pub folders: u32,
    pub unpacked_bytes: u64,
    /// Sum of compressed entry sizes for ZIP, the archive size for TAR and TGZ.
    pub packed_bytes: u64,
    /// Entries that are always skipped.
    pub unsafe_entries: u32,
    /// Unsafe entries that point outside the archive tree (absolute, drive, UNC, `..`,
    /// links). The viewer's "N entries point outside the archive" count.
    pub outside_entries: u32,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveListing {
    pub format: ArchiveFormat,
    /// Compression summary for the footer, for example `Deflate` or `Deflate, Stored`.
    pub compression: String,
    pub entries: Vec<ArchiveEntry>,
    pub totals: ArchiveTotals,
    /// True when the entry or listing byte cap stopped the listing early.
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveErrorKind {
    NotAnArchive,
    Damaged,
    UnsupportedMethod,
    PasswordProtected,
    TooLarge,
    InvalidPath,
    EntryNotFound,
    Unavailable,
    Busy,
    Io,
}

/// Typed failure for archive operations. `message` is ready to show.
#[derive(Debug, Clone, Serialize, Deserialize, Type, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct ArchiveError {
    pub kind: ArchiveErrorKind,
    pub message: String,
}

impl ArchiveError {
    pub fn new(kind: ArchiveErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

pub type ArchiveResult<T> = std::result::Result<T, ArchiveError>;

fn damaged(message: impl std::fmt::Display) -> ArchiveError {
    ArchiveError::new(
        ArchiveErrorKind::Damaged,
        format!("The archive is damaged: {message}"),
    )
}

fn io_failure(error: io::Error) -> ArchiveError {
    if error.kind() == io::ErrorKind::UnexpectedEof {
        damaged("it ends early")
    } else {
        ArchiveError::new(
            ArchiveErrorKind::Io,
            format!("Reading the archive: {error}"),
        )
    }
}

/// The tar crate reports malformed headers as plain I/O errors; inside an archive they
/// mean damage.
fn tar_failure(error: io::Error) -> ArchiveError {
    if error.kind() == io::ErrorKind::UnexpectedEof {
        damaged("it ends early")
    } else {
        damaged(error)
    }
}

fn zip_failure(error: zip::result::ZipError) -> ArchiveError {
    use zip::result::ZipError;
    match error {
        ZipError::UnsupportedArchive(ZipError::PASSWORD_REQUIRED) | ZipError::InvalidPassword => {
            ArchiveError::new(
                ArchiveErrorKind::PasswordProtected,
                "The entry is password protected. Passwords are not supported.",
            )
        }
        ZipError::UnsupportedArchive(message) => ArchiveError::new(
            ArchiveErrorKind::UnsupportedMethod,
            format!("Unsupported ZIP feature: {message}"),
        ),
        ZipError::InvalidArchive(message) => damaged(message),
        ZipError::Io(error) => io_failure(error),
        other => damaged(other),
    }
}

/// Where archive bytes come from: a workspace file or bytes held in memory.
#[derive(Debug, Clone)]
pub enum ArchiveSource {
    Bytes {
        name: String,
        bytes: Arc<Vec<u8>>,
    },
    File {
        name: String,
        path: PathBuf,
        len: u64,
    },
}

impl ArchiveSource {
    pub fn from_bytes(name: impl Into<String>, bytes: Vec<u8>) -> Self {
        Self::Bytes {
            name: name.into(),
            bytes: Arc::new(bytes),
        }
    }

    /// The file name used for format detection and new-folder naming.
    pub fn name(&self) -> &str {
        match self {
            Self::Bytes { name, .. } | Self::File { name, .. } => name,
        }
    }

    fn len(&self) -> u64 {
        match self {
            Self::Bytes { bytes, .. } => bytes.len() as u64,
            Self::File { len, .. } => *len,
        }
    }

    fn head(&self) -> ArchiveResult<Vec<u8>> {
        let mut head = vec![0u8; 512];
        let read = match self {
            Self::Bytes { bytes, .. } => {
                let n = bytes.len().min(512);
                head[..n].copy_from_slice(&bytes[..n]);
                n
            }
            Self::File { path, .. } => {
                let mut file = File::open(path).map_err(io_failure)?;
                let mut total = 0;
                while total < 512 {
                    let n = file.read(&mut head[total..]).map_err(io_failure)?;
                    if n == 0 {
                        break;
                    }
                    total += n;
                }
                total
            }
        };
        head.truncate(read);
        Ok(head)
    }

    /// Run `f` with a seekable reader over the source.
    fn with_reader<T>(
        &self,
        f: impl FnOnce(&mut dyn ReadSeek) -> ArchiveResult<T>,
    ) -> ArchiveResult<T> {
        match self {
            Self::Bytes { bytes, .. } => f(&mut Cursor::new(bytes.as_slice())),
            Self::File { path, .. } => {
                let file = File::open(path).map_err(io_failure)?;
                f(&mut BufReader::with_capacity(64 * 1024, file))
            }
        }
    }
}

trait ReadSeek: Read + Seek {}
impl<T: Read + Seek> ReadSeek for T {}

impl CoreWorkspace {
    /// Resolve a workspace-relative archive path. Absolute paths and `..` are refused, and
    /// the canonical file must stay inside the workspace.
    pub fn archive_source(&self, path: &str) -> ArchiveResult<ArchiveSource> {
        let invalid = |message: &str| ArchiveError::new(ArchiveErrorKind::InvalidPath, message);
        let requested = Path::new(path);
        if path.is_empty()
            || path.contains('\0')
            || requested.is_absolute()
            || path.starts_with(['/', '\\'])
            || requested
                .components()
                .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
        {
            return Err(invalid("Archive path must be relative to the workspace"));
        }
        let resolved = self
            .resolve(path)
            .map_err(|e| invalid(&format!("Archive path is not usable: {e}")))?;
        let metadata = std::fs::metadata(&resolved).map_err(io_failure)?;
        if !metadata.is_file() {
            return Err(invalid("Archive path is not a file"));
        }
        if metadata.len() > MAX_ARCHIVE_SOURCE_BYTES {
            return Err(ArchiveError::new(
                ArchiveErrorKind::TooLarge,
                "The archive is larger than 2 GiB",
            ));
        }
        let name = resolved
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(ArchiveSource::File {
            name,
            path: resolved,
            len: metadata.len(),
        })
    }

    /// The canonical root and open buffer paths, captured so extraction can run without
    /// holding the workspace lock.
    pub fn extract_context(&self) -> ExtractContext {
        ExtractContext {
            root: self.root.clone(),
            open_buffers: self.buffers.keys().cloned().collect(),
        }
    }
}

/// Detect the format by magic bytes first, then by extension.
pub fn detect_format(source: &ArchiveSource) -> ArchiveResult<ArchiveFormat> {
    let head = source.head()?;
    let lower = source.name().to_ascii_lowercase();
    if head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06") {
        return Ok(ArchiveFormat::Zip);
    }
    if head.starts_with(&[0x1f, 0x8b]) {
        return Ok(ArchiveFormat::TarGz);
    }
    if head.len() >= 262 && &head[257..262] == b"ustar" {
        return Ok(ArchiveFormat::Tar);
    }
    if !head.is_empty() {
        if lower.ends_with(".zip") && head.starts_with(b"PK") {
            return Ok(ArchiveFormat::Zip);
        }
        if lower.ends_with(".tar") && head.len() == 512 {
            return Ok(ArchiveFormat::Tar);
        }
    }
    Err(ArchiveError::new(
        ArchiveErrorKind::NotAnArchive,
        "This file is not a ZIP, TAR or TGZ archive",
    ))
}

/// Entry metadata common to every format.
#[derive(Debug, Clone)]
pub(crate) struct RawEntry {
    pub name: String,
    pub kind: RawKind,
    pub size: u64,
    pub packed: Option<u64>,
    pub modified_ms: Option<i64>,
    pub encrypted: bool,
    pub supported: bool,
    pub method: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RawKind {
    File,
    Dir,
    Symlink,
    Hardlink,
    Special,
}

pub(crate) enum Step {
    Skip,
    Read,
    Stop,
}

/// Visits entries in archive order. `data` is called only for entries `entry` asked to read.
pub(crate) trait Visitor {
    fn entry(&mut self, index: usize, raw: &RawEntry) -> ArchiveResult<Step>;
    fn data(&mut self, index: usize, raw: &RawEntry, reader: &mut dyn Read) -> ArchiveResult<bool>;
    /// Called once with the entry count when the format knows it up front.
    fn count(&mut self, _count: usize) -> ArchiveResult<()> {
        Ok(())
    }
}

/// Counts decompressed bytes of a whole gzip stream and stops past `limit`.
struct Bounded<R> {
    inner: R,
    read: u64,
    limit: u64,
    tripped: Rc<Cell<bool>>,
}

impl<R: Read> Read for Bounded<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.read += n as u64;
        if self.read > self.limit {
            self.tripped.set(true);
            return Err(io::Error::other("decompressed size limit"));
        }
        Ok(n)
    }
}

pub(crate) fn walk(
    source: &ArchiveSource,
    limits: &ArchiveLimits,
    visitor: &mut dyn Visitor,
) -> ArchiveResult<ArchiveFormat> {
    let format = detect_format(source)?;
    let len = source.len();
    source.with_reader(|reader| match format {
        ArchiveFormat::Zip => walk_zip(reader, visitor),
        ArchiveFormat::Tar => {
            let mut archive = tar::Archive::new(reader);
            let entries = archive.entries_with_seek().map_err(tar_failure)?;
            walk_tar(entries, Some(len), visitor)
        }
        ArchiveFormat::TarGz => {
            let tripped = Rc::new(Cell::new(false));
            // The whole stream is bounded by the total cap and by the ratio cap measured
            // against the compressed size, so a gzip bomb stops early even when listing.
            let limit = limits
                .max_total_bytes
                .saturating_add(limits.max_entries as u64 * 1024)
                .min(
                    len.saturating_mul(limits.max_ratio)
                        .max(limits.ratio_floor.saturating_mul(4)),
                );
            let bounded = Bounded {
                inner: GzDecoder::new(reader),
                read: 0,
                limit,
                tripped: tripped.clone(),
            };
            let mut archive = tar::Archive::new(bounded);
            let result = archive
                .entries()
                .map_err(tar_failure)
                .and_then(|entries| walk_tar(entries, None, visitor));
            if tripped.get() {
                return Err(ArchiveError::new(
                    ArchiveErrorKind::TooLarge,
                    "The compressed archive unpacks beyond the size or ratio limit",
                ));
            }
            result
        }
    })?;
    Ok(format)
}

fn zip_kind(file: &zip::read::ZipFile<'_, &mut dyn ReadSeek>) -> RawKind {
    if file.is_dir() {
        return RawKind::Dir;
    }
    match file.unix_mode().map(|mode| mode & 0o170000) {
        None | Some(0) | Some(0o100000) => RawKind::File,
        Some(0o040000) => RawKind::Dir,
        Some(0o120000) => RawKind::Symlink,
        Some(_) => RawKind::Special,
    }
}

fn zip_time(file: &zip::read::ZipFile<'_, &mut dyn ReadSeek>) -> Option<i64> {
    let t = file.last_modified()?;
    if !t.is_valid() {
        return None;
    }
    let days = days_from_civil(i64::from(t.year()), t.month().into(), t.day().into());
    let seconds = days * 86_400
        + i64::from(t.hour()) * 3600
        + i64::from(t.minute()) * 60
        + i64::from(t.second());
    Some(seconds * 1000)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn walk_zip(reader: &mut dyn ReadSeek, visitor: &mut dyn Visitor) -> ArchiveResult<()> {
    let mut zip = zip::ZipArchive::new(reader).map_err(zip_failure)?;
    visitor.count(zip.len())?;
    for index in 0..zip.len() {
        let raw = {
            let file = zip.by_index_raw(index).map_err(zip_failure)?;
            let method = file.compression();
            let (supported, method_name) = match method {
                zip::CompressionMethod::Stored => (true, "Stored"),
                zip::CompressionMethod::Deflated => (true, "Deflate"),
                _ => (false, "Other"),
            };
            RawEntry {
                name: file.name().to_owned(),
                kind: zip_kind(&file),
                size: file.size(),
                packed: Some(file.compressed_size()),
                modified_ms: zip_time(&file),
                encrypted: file.encrypted(),
                supported,
                method: method_name,
            }
        };
        match visitor.entry(index, &raw)? {
            Step::Skip => {}
            Step::Stop => break,
            Step::Read => {
                let mut file = zip.by_index(index).map_err(zip_failure)?;
                if !visitor.data(index, &raw, &mut file)? {
                    break;
                }
            }
        }
    }
    Ok(())
}

fn walk_tar<R: Read>(
    entries: tar::Entries<'_, R>,
    source_len: Option<u64>,
    visitor: &mut dyn Visitor,
) -> ArchiveResult<()> {
    let mut index = 0usize;
    for entry in entries {
        let mut entry = entry.map_err(tar_failure)?;
        let kind = entry.header().entry_type();
        if kind.is_pax_global_extensions() {
            continue;
        }
        let size = entry.size();
        if let Some(len) = source_len {
            if entry.raw_file_position().saturating_add(size) > len {
                return Err(damaged("an entry runs past the end of the file"));
            }
        }
        let (raw_kind, supported) = if kind.is_file() {
            (RawKind::File, true)
        } else if kind.is_dir() {
            (RawKind::Dir, true)
        } else if kind.is_symlink() {
            (RawKind::Symlink, true)
        } else if kind.is_hard_link() {
            (RawKind::Hardlink, true)
        } else if kind.is_gnu_sparse() {
            (RawKind::File, false)
        } else {
            (RawKind::Special, true)
        };
        let raw = RawEntry {
            name: String::from_utf8_lossy(&entry.path_bytes()).into_owned(),
            kind: raw_kind,
            size,
            packed: None,
            modified_ms: entry
                .header()
                .mtime()
                .ok()
                .and_then(|s| i64::try_from(s).ok())
                .and_then(|s| s.checked_mul(1000)),
            encrypted: false,
            supported,
            method: "Stored",
        };
        match visitor.entry(index, &raw)? {
            Step::Skip => {}
            Step::Stop => break,
            Step::Read => {
                if !visitor.data(index, &raw, &mut entry)? {
                    break;
                }
            }
        }
        index += 1;
    }
    Ok(())
}

/// What the safety rules say about one entry, before collision detection.
pub(crate) fn judge(
    raw: &RawEntry,
    limits: &ArchiveLimits,
) -> Result<safety::SafePath, UnsafeReason> {
    let path = safety::classify_path(&raw.name)?;
    match raw.kind {
        RawKind::Symlink => return Err(UnsafeReason::Symlink),
        RawKind::Hardlink => return Err(UnsafeReason::Hardlink),
        RawKind::Special => return Err(UnsafeReason::SpecialFile),
        RawKind::File | RawKind::Dir => {}
    }
    if raw.encrypted {
        return Err(UnsafeReason::Encrypted);
    }
    if !raw.supported {
        return Err(UnsafeReason::UnsupportedMethod);
    }
    if raw.kind == RawKind::File {
        if raw.size > limits.max_entry_bytes {
            return Err(UnsafeReason::EntryTooLarge);
        }
        if let Some(packed) = raw.packed {
            if raw.size > limits.ratio_floor && raw.size > packed.saturating_mul(limits.max_ratio) {
                return Err(UnsafeReason::CompressionRatio);
            }
        }
    }
    Ok(path)
}

fn display_name(raw: &str) -> String {
    raw.chars()
        .map(|c| if c.is_control() { '\u{FFFD}' } else { c })
        .collect()
}

/// One judged entry, shared by listing and planning.
pub(crate) struct Judged {
    pub index: usize,
    pub raw: RawEntry,
    pub verdict: Result<safety::SafePath, UnsafeReason>,
}

struct Collect<'a> {
    limits: &'a ArchiveLimits,
    entries: Vec<Judged>,
    listing_bytes: usize,
    truncated: bool,
    /// Listing tolerates the caps by truncating; planning refuses instead.
    strict: bool,
}

impl Collect<'_> {
    fn over(&self) -> ArchiveError {
        ArchiveError::new(
            ArchiveErrorKind::TooLarge,
            format!(
                "The archive has more than {} entries",
                self.limits.max_entries
            ),
        )
    }
}

impl Visitor for Collect<'_> {
    fn count(&mut self, count: usize) -> ArchiveResult<()> {
        if self.strict && count > self.limits.max_entries {
            return Err(self.over());
        }
        Ok(())
    }

    fn entry(&mut self, index: usize, raw: &RawEntry) -> ArchiveResult<Step> {
        if self.entries.len() >= self.limits.max_entries {
            if self.strict {
                return Err(self.over());
            }
            self.truncated = true;
            return Ok(Step::Stop);
        }
        self.listing_bytes += raw.name.len();
        if !self.strict && self.listing_bytes > self.limits.max_listing_bytes {
            self.truncated = true;
            return Ok(Step::Stop);
        }
        self.entries.push(Judged {
            index,
            raw: raw.clone(),
            verdict: judge(raw, self.limits),
        });
        Ok(Step::Skip)
    }

    fn data(&mut self, _: usize, _: &RawEntry, _: &mut dyn Read) -> ArchiveResult<bool> {
        Ok(true)
    }
}

/// Read every entry header and apply the safety rules, including collisions.
pub(crate) fn judge_all(
    source: &ArchiveSource,
    limits: &ArchiveLimits,
    strict: bool,
) -> ArchiveResult<(ArchiveFormat, Vec<Judged>, bool)> {
    let mut collect = Collect {
        limits,
        entries: Vec::new(),
        listing_bytes: 0,
        truncated: false,
        strict,
    };
    let format = walk(source, limits, &mut collect)?;
    let safe: Vec<(usize, &safety::SafePath, bool)> = collect
        .entries
        .iter()
        .enumerate()
        .filter_map(|(i, j)| {
            j.verdict
                .as_ref()
                .ok()
                .map(|p| (i, p, j.raw.kind == RawKind::Dir))
        })
        .collect();
    let colliding = safety::collisions(&safe);
    for i in colliding {
        collect.entries[i].verdict = Err(UnsafeReason::Collision);
    }
    Ok((format, collect.entries, collect.truncated))
}

/// List an archive with the default limits.
pub fn open_archive(source: &ArchiveSource) -> ArchiveResult<ArchiveListing> {
    list_archive(source, &ArchiveLimits::default())
}

pub fn list_archive(
    source: &ArchiveSource,
    limits: &ArchiveLimits,
) -> ArchiveResult<ArchiveListing> {
    let (format, judged, truncated) = judge_all(source, limits, false)?;
    let mut totals = ArchiveTotals::default();
    let mut folders = std::collections::HashSet::new();
    let mut methods: Vec<&'static str> = Vec::new();
    let mut packed_sum = 0u64;
    let mut entries = Vec::with_capacity(judged.len());
    for j in &judged {
        let is_dir = j.raw.kind == RawKind::Dir;
        let path = match &j.verdict {
            Ok(safe) => {
                let comps = &safe.components;
                let parents = if is_dir { comps.len() } else { comps.len() - 1 };
                for depth in 1..=parents {
                    folders.insert(comps[..depth].join("/"));
                }
                safe.joined()
            }
            Err(reason) => {
                totals.unsafe_entries += 1;
                if safety::points_outside(*reason) {
                    totals.outside_entries += 1;
                }
                display_name(&j.raw.name)
            }
        };
        if !is_dir {
            if j.raw.kind == RawKind::File {
                totals.files += 1;
                totals.unpacked_bytes = totals.unpacked_bytes.saturating_add(j.raw.size);
            }
            if !methods.contains(&j.raw.method) && j.raw.kind == RawKind::File {
                methods.push(j.raw.method);
            }
        }
        packed_sum = packed_sum.saturating_add(j.raw.packed.unwrap_or(0));
        entries.push(ArchiveEntry {
            path,
            is_dir,
            size: j.raw.size,
            packed_size: j.raw.packed,
            modified_ms: j.raw.modified_ms,
            unsafe_reason: j.verdict.as_ref().err().copied(),
            is_symlink: j.raw.kind == RawKind::Symlink,
        });
    }
    totals.folders = folders.len() as u32;
    totals.packed_bytes = match format {
        ArchiveFormat::Zip => packed_sum,
        ArchiveFormat::Tar | ArchiveFormat::TarGz => source.len(),
    };
    let compression = match format {
        ArchiveFormat::Zip if methods.is_empty() => "Stored".to_owned(),
        ArchiveFormat::Zip => methods.join(", "),
        ArchiveFormat::Tar => "None".to_owned(),
        ArchiveFormat::TarGz => "Gzip".to_owned(),
    };
    Ok(ArchiveListing {
        format,
        compression,
        entries,
        totals,
        truncated,
    })
}

/// A bounded slice of one entry's unpacked bytes, for previews.
#[derive(Debug, Clone)]
pub struct EntryChunk {
    pub data: Vec<u8>,
    /// Unpacked size from the header.
    pub entry_size: u64,
    /// True when the chunk reaches the end of the entry.
    pub eof: bool,
}

struct ReadOne<'a> {
    target: &'a str,
    offset: u64,
    len: u64,
    limits: &'a ArchiveLimits,
    found: Option<ArchiveResult<EntryChunk>>,
}

impl Visitor for ReadOne<'_> {
    fn entry(&mut self, _: usize, raw: &RawEntry) -> ArchiveResult<Step> {
        if raw.kind == RawKind::Dir {
            return Ok(Step::Skip);
        }
        let matches = match safety::classify_path(&raw.name) {
            Ok(safe) => safe.joined() == self.target,
            Err(_) => display_name(&raw.name) == self.target,
        };
        if !matches {
            return Ok(Step::Skip);
        }
        if raw.encrypted {
            self.found = Some(Err(ArchiveError::new(
                ArchiveErrorKind::PasswordProtected,
                "The entry is password protected. Passwords are not supported.",
            )));
            return Ok(Step::Stop);
        }
        if !raw.supported {
            self.found = Some(Err(ArchiveError::new(
                ArchiveErrorKind::UnsupportedMethod,
                "The entry uses an unsupported compression method",
            )));
            return Ok(Step::Stop);
        }
        Ok(Step::Read)
    }

    fn data(&mut self, _: usize, raw: &RawEntry, reader: &mut dyn Read) -> ArchiveResult<bool> {
        // Never read past the declared size or the per-entry cap, whatever the stream says.
        let cap = raw.size.min(self.limits.max_entry_bytes);
        let mut bounded = reader.take(cap);
        io::copy(&mut (&mut bounded).take(self.offset), &mut io::sink()).map_err(io_failure)?;
        let mut data = Vec::new();
        (&mut bounded)
            .take(self.len)
            .read_to_end(&mut data)
            .map_err(io_failure)?;
        let eof = self.offset + data.len() as u64 >= raw.size;
        self.found = Some(Ok(EntryChunk {
            data,
            entry_size: raw.size,
            eof,
        }));
        Ok(false)
    }
}

/// Read up to `len` bytes of entry `path` (as listed) starting at `offset`.
pub fn read_archive_entry(
    source: &ArchiveSource,
    path: &str,
    offset: u64,
    len: u64,
    limits: &ArchiveLimits,
) -> ArchiveResult<EntryChunk> {
    if len > limits.max_read_len {
        return Err(ArchiveError::new(
            ArchiveErrorKind::TooLarge,
            format!("Read at most {} bytes at a time", limits.max_read_len),
        ));
    }
    if offset.saturating_add(len) > limits.max_entry_bytes {
        return Err(ArchiveError::new(
            ArchiveErrorKind::TooLarge,
            "The read goes past the entry size limit",
        ));
    }
    let mut visitor = ReadOne {
        target: path,
        offset,
        len,
        limits,
        found: None,
    };
    walk(source, limits, &mut visitor)?;
    visitor.found.unwrap_or_else(|| {
        Err(ArchiveError::new(
            ArchiveErrorKind::EntryNotFound,
            format!("No file named {path} in the archive"),
        ))
    })
}
