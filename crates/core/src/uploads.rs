//! Per-workspace store for uploaded files: the bytes a user sent to agents or added
//! to the Uploads panel (ADR 0006). Blobs live in app data, never in the workspace,
//! and are only copied into the workspace through `save_attachment`.
use crate::attachment::{check_component, numbered};
use crate::workspace::{atomic_write, CoreWorkspace};
use crate::{io_error, CoreError, Result, SavedAttachment, MAX_ATTACHMENT_BYTES};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Largest single upload, the same cap as a workspace attachment.
pub const MAX_UPLOAD_BYTES: u64 = MAX_ATTACHMENT_BYTES as u64;
/// Largest total of all uploads in one workspace store.
pub const MAX_UPLOADS_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
/// Most uploads one workspace store holds.
pub const MAX_UPLOAD_COUNT: usize = 2000;
/// Largest chunk one bounded read returns.
pub const MAX_UPLOAD_READ_BYTES: u64 = 4 * 1024 * 1024;

const INDEX_VERSION: u32 = 1;
const INDEX_FILE: &str = "index.json";
const LOCK_FILE: &str = "index.lock";
const BLOB_DIR: &str = "blobs";
const OPEN_DIR: &str = "open";
const CORRUPT_PREFIX: &str = "index.corrupt-";
const MAX_INDEX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SOURCE_FIELD: usize = 256;
const SNIFF_BYTES: usize = 512;

static TEMP_ID: AtomicU64 = AtomicU64::new(1);
static ID_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Panel grouping. Derived from the sniffed type, never used to decide execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum UploadKind {
    Document,
    Data,
    Media,
    Code,
    Archive,
    Image,
    Font,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum UploadOrigin {
    Sent,
    Pasted,
    Dropped,
    Picked,
    AgentGenerated,
}

/// Where an upload came from. Ids are opaque labels for "Show in session".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UploadSource {
    pub session_id: Option<String>,
    pub agent_id: Option<String>,
    pub message_id: Option<String>,
    pub origin: UploadOrigin,
    /// The chat's title when the file was recorded, so the panel can name the
    /// session after the chat is gone. Display text only; cleaned on store.
    #[serde(default)]
    pub session_title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Upload {
    /// 32 lowercase hex characters, random and opaque.
    pub id: String,
    /// Display name, validated with the workspace attachment rules.
    pub name: String,
    /// Sniffed from the extension and magic bytes. Informational only.
    pub mime: String,
    pub size: u64,
    pub kind: UploadKind,
    /// `fnv1a128:<hex>` over the bytes. A cheap non-cryptographic fingerprint for
    /// spotting duplicates, not an integrity or security check (ADR 0006).
    pub fingerprint: String,
    pub source: UploadSource,
    /// Unix milliseconds.
    pub created_ms: u64,
    /// True when the blob file is gone from the store. Computed on list.
    pub missing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UploadUsage {
    pub count: u32,
    pub total_bytes: u64,
    pub max_count: u32,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    /// Blob files with no index entry, kept rather than deleted silently.
    pub orphan_blobs: u32,
    pub orphan_bytes: u64,
    /// Unreadable index files moved aside as `index.corrupt-*.json`.
    pub quarantined_indexes: u32,
}

/// What `UploadStore::clear` removed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClearedUploads {
    /// Indexed uploads plus orphaned blobs.
    pub files: u32,
    pub bytes: u64,
}

/// One bounded read of an upload's bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadChunk {
    pub bytes: Vec<u8>,
    pub offset: u64,
    /// Size of the whole upload.
    pub size: u64,
    pub eof: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UploadLimits {
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    pub max_count: usize,
}

impl Default for UploadLimits {
    fn default() -> Self {
        Self {
            max_file_bytes: MAX_UPLOAD_BYTES,
            max_total_bytes: MAX_UPLOADS_TOTAL_BYTES,
            max_count: MAX_UPLOAD_COUNT,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct Index {
    version: u32,
    uploads: Vec<Upload>,
}

impl Index {
    fn empty() -> Self {
        Self {
            version: INDEX_VERSION,
            uploads: vec![],
        }
    }
    fn total_bytes(&self) -> u64 {
        self.uploads.iter().map(|u| u.size).sum()
    }
    fn position(&self, id: &str) -> Result<usize> {
        self.uploads
            .iter()
            .position(|u| u.id == id)
            .ok_or_else(|| reject(format!("no upload with id {id}")))
    }
}

fn reject(message: impl Into<String>) -> CoreError {
    CoreError::Upload(message.into())
}

/// The attachment validators report `Attachment rejected`; uploads say `Upload`.
fn check_name(name: &str) -> Result<()> {
    check_component(name).map_err(|error| match error {
        CoreError::Attachment(message) => reject(format!("invalid name: {message}")),
        other => other,
    })
}

pub fn is_valid_upload_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn check_id(id: &str) -> Result<()> {
    if is_valid_upload_id(id) {
        Ok(())
    } else {
        Err(reject("invalid upload id"))
    }
}

fn check_source(source: &UploadSource) -> Result<()> {
    for field in [&source.session_id, &source.agent_id, &source.message_id]
        .into_iter()
        .flatten()
    {
        if field.is_empty() || field.len() > MAX_SOURCE_FIELD || field.chars().any(char::is_control)
        {
            return Err(reject("invalid source id"));
        }
    }
    Ok(())
}

/// A session title as display text: control characters become spaces, the
/// result is trimmed and cut to `MAX_SOURCE_FIELD` bytes on a character
/// boundary. Empty becomes `None`.
fn clean_title(title: Option<String>) -> Option<String> {
    let title = title?;
    let spaced: String = title
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let mut cut = spaced.trim().to_owned();
    if cut.len() > MAX_SOURCE_FIELD {
        let mut end = MAX_SOURCE_FIELD;
        while !cut.is_char_boundary(end) {
            end -= 1;
        }
        cut.truncate(end);
        cut = cut.trim_end().to_owned();
    }
    (!cut.is_empty()).then_some(cut)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// FNV-1a with a 128 bit state. Stable across Rust versions and platforms.
fn fnv1a128(parts: &[&[u8]]) -> u128 {
    const OFFSET: u128 = 0x6c62272e07bb014262b821756295c58d;
    const PRIME: u128 = 0x0000000001000000000000000000013B;
    let mut hash = OFFSET;
    for part in parts {
        for byte in *part {
            hash ^= *byte as u128;
            hash = hash.wrapping_mul(PRIME);
        }
    }
    hash
}

pub fn content_fingerprint(bytes: &[u8]) -> String {
    format!("fnv1a128:{:032x}", fnv1a128(&[bytes]))
}

/// Folder name for a canonical workspace root. Hash only, no path text.
pub fn workspace_key(canonical_root: &Path) -> String {
    #[cfg(unix)]
    let bytes = {
        use std::os::unix::ffi::OsStrExt;
        canonical_root.as_os_str().as_bytes().to_vec()
    };
    #[cfg(not(unix))]
    let bytes = canonical_root.to_string_lossy().into_owned().into_bytes();
    format!("{:032x}", fnv1a128(&[b"span-uploads-v1\0", &bytes]))
}

/// 128 random bits from the standard library's randomly keyed hasher, so no new
/// dependency is needed. Opaque, not a secret.
fn new_id() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let count = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    let mut id = String::with_capacity(32);
    for salt in 0..2u8 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(nanos);
        hasher.write_u64(count);
        hasher.write_u32(std::process::id());
        hasher.write_u8(salt);
        id.push_str(&format!("{:016x}", hasher.finish()));
    }
    id
}

fn extension(name: &str) -> Option<String> {
    Path::new(name)
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
}

fn by_extension(ext: &str) -> Option<(&'static str, UploadKind)> {
    use UploadKind::*;
    Some(match ext {
        "pdf" => ("application/pdf", Document),
        "txt" | "text" | "log" => ("text/plain", Document),
        "md" | "markdown" => ("text/markdown", Document),
        "rtf" => ("application/rtf", Document),
        "doc" => ("application/msword", Document),
        "docx" => (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            Document,
        ),
        "odt" => ("application/vnd.oasis.opendocument.text", Document),
        "ppt" => ("application/vnd.ms-powerpoint", Document),
        "pptx" => (
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            Document,
        ),
        "epub" => ("application/epub+zip", Document),
        "csv" => ("text/csv", Data),
        "tsv" => ("text/tab-separated-values", Data),
        "json" => ("application/json", Data),
        "jsonl" | "ndjson" => ("application/x-ndjson", Data),
        "xml" => ("application/xml", Data),
        "yaml" | "yml" => ("application/yaml", Data),
        "toml" => ("application/toml", Data),
        "xls" => ("application/vnd.ms-excel", Data),
        "xlsx" => (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            Data,
        ),
        "ods" => ("application/vnd.oasis.opendocument.spreadsheet", Data),
        "parquet" => ("application/vnd.apache.parquet", Data),
        "sqlite" | "sqlite3" | "db" => ("application/vnd.sqlite3", Data),
        "png" => ("image/png", Image),
        "jpg" | "jpeg" => ("image/jpeg", Image),
        "gif" => ("image/gif", Image),
        "webp" => ("image/webp", Image),
        "svg" => ("image/svg+xml", Image),
        "bmp" => ("image/bmp", Image),
        "ico" => ("image/x-icon", Image),
        "tif" | "tiff" => ("image/tiff", Image),
        "heic" => ("image/heic", Image),
        "avif" => ("image/avif", Image),
        "mp3" => ("audio/mpeg", Media),
        "wav" => ("audio/wav", Media),
        "ogg" => ("audio/ogg", Media),
        "flac" => ("audio/flac", Media),
        "m4a" => ("audio/mp4", Media),
        "mp4" => ("video/mp4", Media),
        "mov" => ("video/quicktime", Media),
        "webm" => ("video/webm", Media),
        "mkv" => ("video/x-matroska", Media),
        "ttf" => ("font/ttf", Font),
        "otf" => ("font/otf", Font),
        "woff" => ("font/woff", Font),
        "woff2" => ("font/woff2", Font),
        "zip" => ("application/zip", Archive),
        "gz" | "tgz" => ("application/gzip", Archive),
        "tar" => ("application/x-tar", Archive),
        "7z" => ("application/x-7z-compressed", Archive),
        "rar" => ("application/vnd.rar", Archive),
        "bz2" => ("application/x-bzip2", Archive),
        "xz" => ("application/x-xz", Archive),
        "zst" => ("application/zstd", Archive),
        "jar" => ("application/java-archive", Archive),
        "dmg" => ("application/x-apple-diskimage", Archive),
        "rs" => ("text/x-rust", Code),
        "ts" | "tsx" | "mts" | "cts" => ("text/x-typescript", Code),
        "js" | "jsx" | "mjs" | "cjs" => ("text/javascript", Code),
        "py" => ("text/x-python", Code),
        "go" => ("text/x-go", Code),
        "java" => ("text/x-java", Code),
        "kt" | "kts" => ("text/x-kotlin", Code),
        "swift" => ("text/x-swift", Code),
        "c" | "h" => ("text/x-c", Code),
        "cc" | "cpp" | "cxx" | "hpp" => ("text/x-c++", Code),
        "cs" => ("text/x-csharp", Code),
        "rb" => ("text/x-ruby", Code),
        "php" => ("text/x-php", Code),
        "html" | "htm" => ("text/html", Code),
        "css" => ("text/css", Code),
        "sql" => ("application/sql", Code),
        "sh" | "bash" | "zsh" => ("application/x-sh", Code),
        "ps1" => ("text/x-powershell", Code),
        "exe" | "dll" => ("application/vnd.microsoft.portable-executable", Other),
        _ => return None,
    })
}

/// Office and similar formats are ZIP containers; the extension names them better.
fn is_zip_container(ext: &str) -> bool {
    matches!(
        ext,
        "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp" | "epub" | "jar" | "apk"
    )
}

fn by_magic(head: &[u8], ext: &str) -> Option<(&'static str, UploadKind)> {
    use UploadKind::*;
    let at = |offset: usize, magic: &[u8]| {
        head.len() >= offset + magic.len() && &head[offset..offset + magic.len()] == magic
    };
    Some(if at(0, b"\x89PNG\r\n\x1a\n") {
        ("image/png", Image)
    } else if at(0, b"\xFF\xD8\xFF") {
        ("image/jpeg", Image)
    } else if at(0, b"GIF87a") || at(0, b"GIF89a") {
        ("image/gif", Image)
    } else if at(0, b"RIFF") && at(8, b"WEBP") {
        ("image/webp", Image)
    } else if at(0, b"RIFF") && at(8, b"WAVE") {
        ("audio/wav", Media)
    } else if at(0, b"%PDF-") {
        ("application/pdf", Document)
    } else if at(0, b"PK\x03\x04") || at(0, b"PK\x05\x06") {
        if is_zip_container(ext) {
            return None;
        }
        ("application/zip", Archive)
    } else if at(0, b"\x1F\x8B") {
        ("application/gzip", Archive)
    } else if at(0, b"7z\xBC\xAF\x27\x1C") {
        ("application/x-7z-compressed", Archive)
    } else if at(0, b"Rar!\x1A\x07") {
        ("application/vnd.rar", Archive)
    } else if at(0, b"\xFD7zXZ\x00") {
        ("application/x-xz", Archive)
    } else if at(0, b"\x28\xB5\x2F\xFD") {
        ("application/zstd", Archive)
    } else if at(0, b"BZh") && head.len() > 3 && head[3].is_ascii_digit() {
        ("application/x-bzip2", Archive)
    } else if at(0, b"ID3") || at(0, b"\xFF\xFB") {
        ("audio/mpeg", Media)
    } else if at(0, b"OggS") {
        ("audio/ogg", Media)
    } else if at(0, b"fLaC") {
        ("audio/flac", Media)
    } else if at(4, b"ftyp") {
        match head.get(8..12) {
            Some(b"qt  ") => ("video/quicktime", Media),
            Some(b"M4A ") => ("audio/mp4", Media),
            Some(b"heic") | Some(b"heix") | Some(b"mif1") => ("image/heic", Image),
            Some(b"avif") => ("image/avif", Image),
            _ => ("video/mp4", Media),
        }
    } else if at(0, b"\x1A\x45\xDF\xA3") {
        if ext == "webm" {
            ("video/webm", Media)
        } else {
            ("video/x-matroska", Media)
        }
    } else if at(0, b"wOFF") {
        ("font/woff", Font)
    } else if at(0, b"wOF2") {
        ("font/woff2", Font)
    } else if at(0, b"OTTO") {
        ("font/otf", Font)
    } else if at(0, b"\x00\x01\x00\x00\x00") && matches!(ext, "ttf" | "otf" | "") {
        ("font/ttf", Font)
    } else if at(0, b"SQLite format 3\x00") {
        ("application/vnd.sqlite3", Data)
    } else if at(0, b"MZ") {
        ("application/vnd.microsoft.portable-executable", Other)
    } else if at(0, b"\x7FELF") {
        ("application/x-elf", Other)
    } else if is_mach_o(head) {
        ("application/x-mach-binary", Other)
    } else {
        return None;
    })
}

fn is_mach_o(head: &[u8]) -> bool {
    [
        b"\xFE\xED\xFA\xCE",
        b"\xFE\xED\xFA\xCF",
        b"\xCE\xFA\xED\xFE",
        b"\xCF\xFA\xED\xFE",
        b"\xCA\xFE\xBA\xBE",
    ]
    .iter()
    .any(|magic| head.starts_with(*magic))
}

fn looks_like_text(head: &[u8]) -> bool {
    if head.is_empty() || head.contains(&0) {
        return false;
    }
    match std::str::from_utf8(head) {
        Ok(_) => true,
        // A multi-byte character cut by the sniff window is still text.
        Err(error) => error.error_len().is_none(),
    }
}

/// MIME type and panel kind for a name and the first bytes of its content.
/// Magic bytes win over the extension, except for ZIP-based document formats.
pub fn sniff_upload(name: &str, head: &[u8]) -> (String, UploadKind) {
    let ext = extension(name).unwrap_or_default();
    let head = &head[..head.len().min(SNIFF_BYTES)];
    if let Some((mime, kind)) = by_magic(head, &ext) {
        return (mime.to_owned(), kind);
    }
    if let Some((mime, kind)) = by_extension(&ext) {
        return (mime.to_owned(), kind);
    }
    if looks_like_text(head) {
        return ("text/plain".to_owned(), UploadKind::Document);
    }
    ("application/octet-stream".to_owned(), UploadKind::Other)
}

/// Extensions the system would run, install, mount or script rather than show.
const RISKY_EXTENSIONS: &[&str] = &[
    "exe",
    "msi",
    "msp",
    "bat",
    "cmd",
    "com",
    "scr",
    "pif",
    "cpl",
    "hta",
    "ps1",
    "psm1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "reg",
    "lnk",
    "url",
    "sh",
    "bash",
    "zsh",
    "csh",
    "ksh",
    "fish",
    "command",
    "tool",
    "terminal",
    "workflow",
    "app",
    "pkg",
    "mpkg",
    "dmg",
    "jar",
    "appimage",
    "desktop",
    "run",
    "py",
    "pyw",
    "pl",
    "rb",
    "applescript",
    "scpt",
];

/// Why opening an upload with the system default app is refused, or `None` when it
/// is allowed. Pure, so the table is tested on every platform. `head` is the first
/// bytes of the content and `executable` the unix executable bit.
pub fn open_refusal(name: &str, head: &[u8], executable: bool) -> Option<String> {
    let advice = "Use Save to workspace and review it there instead.";
    if let Some(ext) = extension(name) {
        if RISKY_EXTENSIONS.contains(&ext.as_str()) {
            return Some(format!(
                "Span does not open .{ext} files with the system default app because it could run code. {advice}"
            ));
        }
    }
    if executable {
        return Some(format!(
            "Span does not open files marked executable with the system default app. {advice}"
        ));
    }
    if head.starts_with(b"MZ")
        || head.starts_with(b"\x7FELF")
        || is_mach_o(head)
        || head.starts_with(b"#!")
    {
        return Some(format!(
            "This file contains a program or script, so Span does not open it with the system default app. {advice}"
        ));
    }
    None
}

/// One workspace's upload store. Every mutation holds an exclusive file lock, so
/// threads and Span processes sharing a store serialise their index updates.
#[derive(Debug, Clone)]
pub struct UploadStore {
    dir: PathBuf,
    limits: UploadLimits,
}

impl UploadStore {
    /// `~/.config/span/uploads/<workspace key>`, next to `session.json`.
    pub fn for_current_user(workspace_root: &Path) -> Result<Self> {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .ok_or_else(|| reject("cannot locate the user profile for uploads"))?;
        Self::open(
            PathBuf::from(home).join(".config/span/uploads"),
            workspace_root,
        )
    }

    /// Store for `workspace_root` under `base`. Creates the folders.
    pub fn open(base: impl AsRef<Path>, workspace_root: &Path) -> Result<Self> {
        let root = workspace_root
            .canonicalize()
            .map_err(|e| io_error("Resolve workspace for uploads", workspace_root, e))?;
        let dir = base.as_ref().join(workspace_key(&root));
        fs::create_dir_all(dir.join(BLOB_DIR))
            .map_err(|e| io_error("Create uploads store", &dir, e))?;
        let dir = dir
            .canonicalize()
            .map_err(|e| io_error("Resolve uploads store", &dir, e))?;
        Ok(Self {
            dir,
            limits: UploadLimits::default(),
        })
    }

    pub fn with_limits(mut self, limits: UploadLimits) -> Self {
        self.limits = limits;
        self
    }

    /// Canonical store folder for this workspace.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn add(&self, name: &str, bytes: &[u8], mut source: UploadSource) -> Result<Upload> {
        check_name(name)?;
        check_source(&source)?;
        source.session_title = clean_title(source.session_title.take());
        let size = bytes.len() as u64;
        if size > self.limits.max_file_bytes {
            return Err(reject(format!(
                "file is larger than {} bytes",
                self.limits.max_file_bytes
            )));
        }
        let _lock = self.lock()?;
        let mut index = self.read_index()?;
        self.check_room(&index, size)?;
        let id = self.fresh_id(&index);
        let blob = self.blob_path(&id);
        self.write_blob(&blob, |file| file.write_all(bytes))?;
        let (mime, kind) = sniff_upload(name, bytes);
        let upload = Upload {
            id,
            name: name.to_owned(),
            mime,
            size,
            kind,
            fingerprint: content_fingerprint(bytes),
            source,
            created_ms: now_ms(),
            missing: false,
        };
        index.uploads.push(upload.clone());
        if let Err(error) = self.write_index(&index) {
            let _ = fs::remove_file(&blob);
            return Err(error);
        }
        Ok(upload)
    }

    /// Newest first.
    pub fn list(&self) -> Result<Vec<Upload>> {
        let _lock = self.lock()?;
        let index = self.read_index()?;
        let mut uploads: Vec<Upload> = index
            .uploads
            .into_iter()
            .map(|mut upload| {
                upload.missing = !self.blob_path(&upload.id).is_file();
                upload
            })
            .collect();
        uploads.reverse();
        Ok(uploads)
    }

    pub fn get_meta(&self, id: &str) -> Result<Upload> {
        check_id(id)?;
        let _lock = self.lock()?;
        let index = self.read_index()?;
        let mut upload = index.uploads[index.position(id)?].clone();
        upload.missing = !self.blob_path(id).is_file();
        Ok(upload)
    }

    /// Up to `len` bytes (capped at `MAX_UPLOAD_READ_BYTES`) from `offset`.
    pub fn read(&self, id: &str, offset: u64, len: u64) -> Result<UploadChunk> {
        self.get_meta(id)?;
        let path = self.checked_blob(id)?;
        let mut file = File::open(&path).map_err(|e| io_error("Read upload", &path, e))?;
        let size = file
            .metadata()
            .map_err(|e| io_error("Read upload", &path, e))?
            .len();
        let len = len.min(MAX_UPLOAD_READ_BYTES);
        if offset >= size || len == 0 {
            return Ok(UploadChunk {
                bytes: vec![],
                offset: offset.min(size),
                size,
                eof: offset >= size,
            });
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| io_error("Read upload", &path, e))?;
        let mut bytes = Vec::with_capacity(len.min(size - offset) as usize);
        file.take(len)
            .read_to_end(&mut bytes)
            .map_err(|e| io_error("Read upload", &path, e))?;
        let end = offset + bytes.len() as u64;
        Ok(UploadChunk {
            bytes,
            offset,
            size,
            eof: end >= size,
        })
    }

    /// New display name. Validated like a workspace file name; the type is sniffed
    /// again so the kind follows a changed extension, while magic bytes still win.
    pub fn rename(&self, id: &str, new_name: &str) -> Result<Upload> {
        check_id(id)?;
        check_name(new_name)?;
        let _lock = self.lock()?;
        let mut index = self.read_index()?;
        let position = index.position(id)?;
        let head = self.head(id).unwrap_or_default();
        let (mime, kind) = sniff_upload(new_name, &head);
        let upload = &mut index.uploads[position];
        upload.name = new_name.to_owned();
        upload.mime = mime;
        upload.kind = kind;
        let upload = upload.clone();
        self.write_index(&index)?;
        let _ = self.clear_open_copy(id);
        Ok(upload)
    }

    /// Copy with a new id and the first free ` (n)` name among this store's uploads.
    pub fn duplicate(&self, id: &str) -> Result<Upload> {
        check_id(id)?;
        let _lock = self.lock()?;
        let mut index = self.read_index()?;
        let original = index.uploads[index.position(id)?].clone();
        self.check_room(&index, original.size)?;
        let source = self.checked_blob(id)?;
        let names: HashSet<&str> = index.uploads.iter().map(|u| u.name.as_str()).collect();
        let name = (1..=10_000u32)
            .map(|n| numbered(&original.name, n))
            .find(|candidate| !names.contains(candidate.as_str()) && check_name(candidate).is_ok())
            .ok_or_else(|| reject("too many uploads with the same name"))?;
        let new_id = self.fresh_id(&index);
        let blob = self.blob_path(&new_id);
        let mut input =
            File::open(&source).map_err(|e| io_error("Duplicate upload", &source, e))?;
        self.write_blob(&blob, |file| std::io::copy(&mut input, file).map(|_| ()))?;
        let copy = Upload {
            id: new_id,
            name,
            created_ms: now_ms(),
            missing: false,
            ..original
        };
        index.uploads.push(copy.clone());
        if let Err(error) = self.write_index(&index) {
            let _ = fs::remove_file(&blob);
            return Err(error);
        }
        Ok(copy)
    }

    /// Delete the index entry, then the blob and any external copy.
    pub fn remove(&self, id: &str) -> Result<()> {
        check_id(id)?;
        let _lock = self.lock()?;
        let mut index = self.read_index()?;
        let position = index.position(id)?;
        index.uploads.remove(position);
        self.write_index(&index)?;
        let blob = self.blob_path(id);
        match fs::remove_file(&blob) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error("Remove upload", &blob, e)),
        }
        self.clear_open_copy(id)
    }

    /// Copy into workspace-relative `dir` through `save_attachment`: never overwrites,
    /// refuses protected directories and paths outside the workspace.
    pub fn save_to_workspace(
        &self,
        id: &str,
        workspace: &mut CoreWorkspace,
        dir: &str,
    ) -> Result<SavedAttachment> {
        let upload = self.get_meta(id)?;
        let path = self.checked_blob(id)?;
        let mut bytes = Vec::new();
        File::open(&path)
            .and_then(|file| {
                file.take(MAX_ATTACHMENT_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)
            })
            .map_err(|e| io_error("Read upload", &path, e))?;
        workspace.save_attachment(dir, &upload.name, &bytes)
    }

    pub fn usage(&self) -> Result<UploadUsage> {
        let _lock = self.lock()?;
        let index = self.read_index()?;
        let known: HashSet<String> = index
            .uploads
            .iter()
            .map(|u| format!("{}.bin", u.id))
            .collect();
        let (mut orphan_blobs, mut orphan_bytes) = (0u32, 0u64);
        if let Ok(entries) = fs::read_dir(self.dir.join(BLOB_DIR)) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.ends_with(".bin") && !known.contains(&name) {
                    orphan_blobs += 1;
                    orphan_bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }
        let quarantined_indexes = fs::read_dir(&self.dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| e.file_name().to_string_lossy().starts_with(CORRUPT_PREFIX))
                    .count() as u32
            })
            .unwrap_or(0);
        Ok(UploadUsage {
            count: index.uploads.len() as u32,
            total_bytes: index.total_bytes(),
            max_count: self.limits.max_count as u32,
            max_total_bytes: self.limits.max_total_bytes,
            max_file_bytes: self.limits.max_file_bytes,
            orphan_blobs,
            orphan_bytes,
            quarantined_indexes,
        })
    }

    /// Removes this workspace's whole store contents: every blob (orphans
    /// included), the `open/` copies, the index and any quarantined index.
    /// Nothing outside the store folder is touched, so workspace files and
    /// uploads already saved into the workspace stay. The folder and its lock
    /// file remain so the store keeps working.
    pub fn clear(&self) -> Result<ClearedUploads> {
        let _lock = self.lock()?;
        let index = self.read_index()?;
        let blobs = self.dir.join(BLOB_DIR);
        let (mut files, mut bytes) = (0u32, 0u64);
        if let Ok(entries) = fs::read_dir(&blobs) {
            for entry in entries.flatten() {
                let Ok(metadata) = entry.path().symlink_metadata() else {
                    continue;
                };
                if metadata.is_file() && entry.file_name().to_string_lossy().ends_with(".bin") {
                    files += 1;
                    bytes += metadata.len();
                }
            }
        }
        // Indexed uploads whose blob is gone still count as cleared entries.
        let missing = index
            .uploads
            .iter()
            .filter(|u| !self.blob_path(&u.id).is_file())
            .count() as u32;
        files += missing;
        self.remove_store_dir(&blobs)?;
        fs::create_dir_all(&blobs).map_err(|e| io_error("Create uploads store", &blobs, e))?;
        self.remove_store_dir(&self.dir.join(OPEN_DIR))?;
        let entries =
            fs::read_dir(&self.dir).map_err(|e| io_error("Clear uploads", &self.dir, e))?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == INDEX_FILE || name.starts_with(CORRUPT_PREFIX) {
                let path = entry.path();
                fs::remove_file(&path).map_err(|e| io_error("Clear uploads", &path, e))?;
            }
        }
        Ok(ClearedUploads { files, bytes })
    }

    /// Removes a folder directly inside the store. A symlink is removed as a
    /// link, never followed.
    fn remove_store_dir(&self, folder: &Path) -> Result<()> {
        match folder.symlink_metadata() {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_error("Clear uploads", folder, e)),
            Ok(metadata) if metadata.file_type().is_symlink() || metadata.is_file() => {
                fs::remove_file(folder).map_err(|e| io_error("Clear uploads", folder, e))
            }
            Ok(_) => {
                self.contained(folder)?;
                fs::remove_dir_all(folder).map_err(|e| io_error("Clear uploads", folder, e))
            }
        }
    }

    /// A fresh copy of the upload under its display name, at
    /// `<store>/open/<id>/<name>`, for reveal and open with the system app. The blob
    /// itself is never handed out, so an external editor cannot change it. Also
    /// returns the first content bytes and whether the copy is executable.
    pub fn external_copy(&self, id: &str) -> Result<ExternalCopy> {
        let upload = self.get_meta(id)?;
        check_name(&upload.name)?;
        let blob = self.checked_blob(id)?;
        self.clear_open_copy(id)?;
        let folder = self.dir.join(OPEN_DIR).join(id);
        fs::create_dir_all(&folder).map_err(|e| io_error("Prepare upload copy", &folder, e))?;
        let folder = self.contained(&folder)?;
        let target = folder.join(&upload.name);
        let mut input = File::open(&blob).map_err(|e| io_error("Prepare upload copy", &blob, e))?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| io_error("Prepare upload copy", &target, e))?;
        std::io::copy(&mut input, &mut output)
            .and_then(|_| output.sync_all())
            .map_err(|e| io_error("Prepare upload copy", &target, e))?;
        drop(output);
        let path = self.checked_file(&target)?;
        let head = read_head(&path).unwrap_or_default();
        let executable = is_executable(&path);
        Ok(ExternalCopy {
            path,
            name: upload.name,
            head,
            executable,
        })
    }

    fn lock(&self) -> Result<File> {
        let path = self.dir.join(LOCK_FILE);
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|e| io_error("Open uploads lock", &path, e))?;
        file.lock()
            .map_err(|e| io_error("Lock uploads", &path, e))?;
        Ok(file)
    }

    /// Missing index means empty. An unreadable one is moved aside and replaced by an
    /// empty index; blobs stay on disk and show up as orphans in `usage`. A newer
    /// schema version is refused untouched so an older Span never discards it.
    fn read_index(&self) -> Result<Index> {
        let path = self.dir.join(INDEX_FILE);
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Index::empty()),
            Err(e) => return Err(io_error("Read uploads index", &path, e)),
        };
        let mut bytes = Vec::new();
        file.take(MAX_INDEX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| io_error("Read uploads index", &path, e))?;
        let parsed = if bytes.len() as u64 > MAX_INDEX_BYTES {
            None
        } else {
            serde_json::from_slice::<serde_json::Value>(&bytes).ok()
        };
        if let Some(version) = parsed
            .as_ref()
            .and_then(|value| value.get("version"))
            .and_then(serde_json::Value::as_u64)
        {
            if version > INDEX_VERSION as u64 {
                return Err(reject(format!(
                    "the uploads index uses schema version {version}, written by a newer Span"
                )));
            }
        }
        match parsed.and_then(|value| serde_json::from_value::<Index>(value).ok()) {
            Some(index) if index.version == INDEX_VERSION => Ok(self.sanitize(index)),
            _ => {
                self.quarantine(&path)?;
                Ok(Index::empty())
            }
        }
    }

    /// Drops entries that fail validation or repeat an id. Their blobs are kept.
    fn sanitize(&self, index: Index) -> Index {
        let mut seen = HashSet::new();
        let uploads = index
            .uploads
            .into_iter()
            .filter(|u| {
                is_valid_upload_id(&u.id)
                    && check_name(&u.name).is_ok()
                    && check_source(&u.source).is_ok()
                    && seen.insert(u.id.clone())
            })
            .map(|mut u| {
                u.source.session_title = clean_title(u.source.session_title.take());
                u
            })
            .collect();
        Index {
            version: INDEX_VERSION,
            uploads,
        }
    }

    fn quarantine(&self, path: &Path) -> Result<()> {
        for n in 0..1000u32 {
            let aside = self
                .dir
                .join(format!("{CORRUPT_PREFIX}{}-{n}.json", now_ms()));
            if aside.symlink_metadata().is_ok() {
                continue;
            }
            return fs::rename(path, &aside)
                .map_err(|e| io_error("Move aside unreadable uploads index", path, e));
        }
        Err(reject("cannot move aside the unreadable uploads index"))
    }

    fn write_index(&self, index: &Index) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(index)
            .map_err(|e| reject(format!("cannot encode the uploads index: {e}")))?;
        atomic_write(&self.dir.join(INDEX_FILE), &bytes)
    }

    fn check_room(&self, index: &Index, size: u64) -> Result<()> {
        if index.uploads.len() >= self.limits.max_count {
            return Err(reject(format!(
                "the uploads store is full ({} of {} files). Remove uploads to add more.",
                index.uploads.len(),
                self.limits.max_count
            )));
        }
        let total = index.total_bytes();
        if total.saturating_add(size) > self.limits.max_total_bytes {
            return Err(reject(format!(
                "the uploads store is full ({total} of {} bytes used, this file needs {size}). Remove uploads to add more.",
                self.limits.max_total_bytes
            )));
        }
        Ok(())
    }

    fn fresh_id(&self, index: &Index) -> String {
        loop {
            let id = new_id();
            if !index.uploads.iter().any(|u| u.id == id)
                && self.blob_path(&id).symlink_metadata().is_err()
            {
                return id;
            }
        }
    }

    fn blob_path(&self, id: &str) -> PathBuf {
        self.dir.join(BLOB_DIR).join(format!("{id}.bin"))
    }

    /// Write to a new temp file, then rename onto `target`. `create_new` refuses an
    /// existing temp (or symlink) and the rename replaces rather than follows one.
    fn write_blob(
        &self,
        target: &Path,
        fill: impl FnOnce(&mut File) -> std::io::Result<()>,
    ) -> Result<()> {
        let temp = self.dir.join(BLOB_DIR).join(format!(
            ".upload.span-{}-{}",
            std::process::id(),
            TEMP_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            fill(&mut file)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp, target)
        })();
        if let Err(e) = result {
            let _ = fs::remove_file(&temp);
            return Err(io_error("Store upload", target, e));
        }
        Ok(())
    }

    /// The blob for `id` as a regular file inside the store, never through a symlink.
    fn checked_blob(&self, id: &str) -> Result<PathBuf> {
        check_id(id)?;
        self.checked_file(&self.blob_path(id))
    }

    fn checked_file(&self, path: &Path) -> Result<PathBuf> {
        let metadata = path
            .symlink_metadata()
            .map_err(|e| io_error("Open upload", path, e))?;
        if !metadata.file_type().is_file() {
            return Err(reject("upload file is not a regular file in the store"));
        }
        self.contained(path)
    }

    fn contained(&self, path: &Path) -> Result<PathBuf> {
        let canonical = path
            .canonicalize()
            .map_err(|e| io_error("Resolve upload", path, e))?;
        if !canonical.starts_with(&self.dir) {
            return Err(reject("upload path leads outside the uploads store"));
        }
        Ok(canonical)
    }

    fn head(&self, id: &str) -> Result<Vec<u8>> {
        read_head(&self.checked_blob(id)?)
    }

    fn clear_open_copy(&self, id: &str) -> Result<()> {
        check_id(id)?;
        let folder = self.dir.join(OPEN_DIR).join(id);
        match folder.symlink_metadata() {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_error("Clear upload copy", &folder, e)),
            Ok(metadata) if metadata.file_type().is_symlink() || metadata.is_file() => {
                fs::remove_file(&folder).map_err(|e| io_error("Clear upload copy", &folder, e))
            }
            Ok(_) => {
                self.contained(&folder)?;
                fs::remove_dir_all(&folder).map_err(|e| io_error("Clear upload copy", &folder, e))
            }
        }
    }
}

/// A named copy of an upload prepared for the system file manager or default app.
#[derive(Debug, Clone)]
pub struct ExternalCopy {
    pub path: PathBuf,
    pub name: String,
    pub head: Vec<u8>,
    pub executable: bool,
}

impl ExternalCopy {
    pub fn open_refusal(&self) -> Option<String> {
        open_refusal(&self.name, &self.head, self.executable)
    }
}

fn read_head(path: &Path) -> Result<Vec<u8>> {
    let mut head = Vec::with_capacity(SNIFF_BYTES);
    File::open(path)
        .and_then(|file| file.take(SNIFF_BYTES as u64).read_to_end(&mut head))
        .map_err(|e| io_error("Read upload", path, e))?;
    Ok(head)
}

#[cfg(unix)]
pub(crate) fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(true)
}

#[cfg(not(unix))]
pub(crate) fn is_executable(_path: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> UploadSource {
        UploadSource {
            session_id: Some("s1".into()),
            agent_id: Some("claude".into()),
            message_id: None,
            origin: UploadOrigin::Sent,
            session_title: None,
        }
    }

    struct Fixture {
        _base: tempfile::TempDir,
        workspace: tempfile::TempDir,
        store: UploadStore,
    }

    fn fixture() -> Fixture {
        let base = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let store = UploadStore::open(base.path(), workspace.path()).unwrap();
        Fixture {
            _base: base,
            workspace,
            store,
        }
    }

    #[test]
    fn add_list_and_meta_round_trip() {
        let f = fixture();
        let a = f.store.add("notes.md", b"# hi", source()).unwrap();
        let b = f
            .store
            .add("pic.png", b"\x89PNG\r\n\x1a\nrest", source())
            .unwrap();
        assert!(is_valid_upload_id(&a.id) && is_valid_upload_id(&b.id));
        assert_ne!(a.id, b.id);
        assert_eq!(
            (a.size, a.kind, a.mime.as_str()),
            (4, UploadKind::Document, "text/markdown")
        );
        assert_eq!(b.kind, UploadKind::Image);
        assert_eq!(a.fingerprint, content_fingerprint(b"# hi"));
        assert!(a.fingerprint.starts_with("fnv1a128:"));
        let list = f.store.list().unwrap();
        assert_eq!(
            list.iter().map(|u| u.id.as_str()).collect::<Vec<_>>(),
            [&b.id, &a.id]
        );
        assert_eq!(f.store.get_meta(&a.id).unwrap(), a);
        assert!(f
            .store
            .dir()
            .join("blobs")
            .join(format!("{}.bin", a.id))
            .is_file());
        let names: Vec<String> = fs::read_dir(f.store.dir().join("blobs"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().all(|n| n.ends_with(".bin")), "{names:?}");
    }

    #[test]
    fn store_folder_name_has_no_path_text() {
        let f = fixture();
        let key = f
            .store
            .dir()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(is_valid_upload_id(&key), "{key}");
        let root_name = f
            .workspace
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(!f.store.dir().to_string_lossy().contains(&root_name));
        assert_eq!(
            key,
            workspace_key(&f.workspace.path().canonicalize().unwrap())
        );
    }

    #[test]
    fn bounded_reads() {
        let f = fixture();
        let data: Vec<u8> = (0..=255u8).cycle().take(10_000).collect();
        let up = f.store.add("data.bin", &data, source()).unwrap();
        let chunk = f.store.read(&up.id, 0, 100).unwrap();
        assert_eq!(
            (chunk.bytes.as_slice(), chunk.size, chunk.eof),
            (&data[..100], 10_000, false)
        );
        let tail = f.store.read(&up.id, 9_990, 100).unwrap();
        assert_eq!((tail.bytes.as_slice(), tail.eof), (&data[9_990..], true));
        let past = f.store.read(&up.id, 20_000, 10).unwrap();
        assert!(past.bytes.is_empty() && past.eof && past.offset == 10_000);
        let zero = f.store.read(&up.id, 5, 0).unwrap();
        assert!(zero.bytes.is_empty() && !zero.eof);
        let huge = f.store.read(&up.id, 0, u64::MAX).unwrap();
        assert_eq!(huge.bytes, data);
        let big = vec![7u8; (MAX_UPLOAD_READ_BYTES + 10) as usize];
        let big = f.store.add("big.bin", &big, source()).unwrap();
        let capped = f.store.read(&big.id, 0, u64::MAX).unwrap();
        assert_eq!(capped.bytes.len() as u64, MAX_UPLOAD_READ_BYTES);
        assert!(!capped.eof);
    }

    #[test]
    fn names_are_validated_on_add_and_rename() {
        let f = fixture();
        let up = f.store.add("a.txt", b"x", source()).unwrap();
        for bad in [
            "",
            ".",
            "..",
            "../x",
            "a/b",
            "a\\b",
            "con",
            "NUL.txt",
            "com1.png",
            "trail.",
            "trail ",
            "a:b",
            ".git",
            ".span",
            "n\0ul",
            "new\nline",
        ] {
            assert!(
                matches!(f.store.add(bad, b"x", source()), Err(CoreError::Upload(_))),
                "add {bad:?}"
            );
            assert!(f.store.rename(&up.id, bad).is_err(), "rename {bad:?}");
        }
        assert_eq!(f.store.get_meta(&up.id).unwrap().name, "a.txt");
        assert_eq!(f.store.list().unwrap().len(), 1);
    }

    #[test]
    fn rename_resniffs_and_magic_bytes_still_win() {
        let f = fixture();
        let text = f.store.add("data.txt", b"a,b\n1,2\n", source()).unwrap();
        let renamed = f.store.rename(&text.id, "data.csv").unwrap();
        assert_eq!(
            (renamed.name.as_str(), renamed.kind, renamed.mime.as_str()),
            ("data.csv", UploadKind::Data, "text/csv")
        );
        let png = f
            .store
            .add("pic.png", b"\x89PNG\r\n\x1a\n0000", source())
            .unwrap();
        let disguised = f.store.rename(&png.id, "pic.txt").unwrap();
        assert_eq!(
            (disguised.kind, disguised.mime.as_str()),
            (UploadKind::Image, "image/png")
        );
        assert_eq!(
            f.store.read(&png.id, 0, 100).unwrap().bytes,
            b"\x89PNG\r\n\x1a\n0000"
        );
    }

    #[test]
    fn duplicate_picks_free_numbered_names() {
        let f = fixture();
        let a = f.store.add("a.png", b"one", source()).unwrap();
        f.store.add("a (1).png", b"taken", source()).unwrap();
        let d1 = f.store.duplicate(&a.id).unwrap();
        let d2 = f.store.duplicate(&a.id).unwrap();
        assert_eq!(
            (d1.name.as_str(), d2.name.as_str()),
            ("a (2).png", "a (3).png")
        );
        assert_ne!(d1.id, a.id);
        assert_eq!(
            (d1.fingerprint.as_str(), d1.size),
            (a.fingerprint.as_str(), a.size)
        );
        assert_eq!(f.store.read(&d1.id, 0, 10).unwrap().bytes, b"one");
        let bare = f.store.add("notes", b"n", source()).unwrap();
        assert_eq!(f.store.duplicate(&bare.id).unwrap().name, "notes (1)");
        assert_eq!(f.store.list().unwrap().len(), 6);
    }

    #[test]
    fn remove_deletes_blob_entry_and_copy() {
        let f = fixture();
        let up = f.store.add("a.pdf", b"%PDF-1.4", source()).unwrap();
        let copy = f.store.external_copy(&up.id).unwrap();
        assert!(copy.path.is_file());
        f.store.remove(&up.id).unwrap();
        assert!(f.store.list().unwrap().is_empty());
        assert!(!f
            .store
            .dir()
            .join("blobs")
            .join(format!("{}.bin", up.id))
            .exists());
        assert!(!copy.path.exists());
        assert!(f.store.remove(&up.id).is_err());
        assert!(f.store.read(&up.id, 0, 1).is_err());
        assert_eq!(f.store.usage().unwrap().orphan_blobs, 0);
    }

    #[test]
    fn missing_blob_is_reported_not_hidden() {
        let f = fixture();
        let up = f.store.add("a.txt", b"x", source()).unwrap();
        fs::remove_file(f.store.dir().join("blobs").join(format!("{}.bin", up.id))).unwrap();
        assert!(f.store.list().unwrap()[0].missing);
        assert!(f.store.read(&up.id, 0, 1).is_err());
        f.store.remove(&up.id).unwrap();
    }

    #[test]
    fn corrupt_index_is_moved_aside_and_blobs_are_kept() {
        let f = fixture();
        let up = f.store.add("a.txt", b"keep me", source()).unwrap();
        fs::write(f.store.dir().join(INDEX_FILE), b"{not json").unwrap();
        assert!(f.store.list().unwrap().is_empty());
        let usage = f.store.usage().unwrap();
        assert_eq!(
            (
                usage.quarantined_indexes,
                usage.orphan_blobs,
                usage.orphan_bytes
            ),
            (1, 1, 7)
        );
        assert_eq!(
            fs::read(f.store.dir().join("blobs").join(format!("{}.bin", up.id))).unwrap(),
            b"keep me"
        );
        let fresh = f.store.add("b.txt", b"y", source()).unwrap();
        assert_eq!(f.store.list().unwrap(), vec![fresh]);
    }

    #[test]
    fn wrong_shape_and_bad_entries_are_tolerated() {
        let f = fixture();
        fs::write(
            f.store.dir().join(INDEX_FILE),
            br#"{"version":1,"uploads":"nope"}"#,
        )
        .unwrap();
        assert!(f.store.list().unwrap().is_empty());
        let good = f.store.add("ok.txt", b"1", source()).unwrap();
        let mut index: serde_json::Value =
            serde_json::from_slice(&fs::read(f.store.dir().join(INDEX_FILE)).unwrap()).unwrap();
        let mut bad = index["uploads"][0].clone();
        bad["id"] = "../../etc".into();
        let mut dup = index["uploads"][0].clone();
        dup["name"] = "dup.txt".into();
        let mut evil_name = index["uploads"][0].clone();
        evil_name["id"] = "0123456789abcdef0123456789abcdef".into();
        evil_name["name"] = "../x".into();
        index["uploads"]
            .as_array_mut()
            .unwrap()
            .extend([bad, dup, evil_name]);
        fs::write(
            f.store.dir().join(INDEX_FILE),
            serde_json::to_vec(&index).unwrap(),
        )
        .unwrap();
        assert_eq!(f.store.list().unwrap(), vec![good]);
    }

    #[test]
    fn newer_schema_is_refused_untouched() {
        let f = fixture();
        let text = br#"{"version":99,"uploads":[]}"#;
        fs::write(f.store.dir().join(INDEX_FILE), text).unwrap();
        assert!(f.store.list().is_err());
        assert!(f.store.add("a.txt", b"x", source()).is_err());
        assert_eq!(fs::read(f.store.dir().join(INDEX_FILE)).unwrap(), text);
        assert_eq!(
            f.store.usage().map(|u| u.quarantined_indexes).unwrap_or(0),
            0
        );
    }

    #[test]
    fn caps_refuse_without_evicting_and_usage_reports() {
        let f = fixture();
        let store = f.store.clone().with_limits(UploadLimits {
            max_file_bytes: 10,
            max_total_bytes: 25,
            max_count: 3,
        });
        assert!(store.add("big.bin", &[0; 11], source()).is_err());
        let a = store.add("a.bin", &[0; 10], source()).unwrap();
        store.add("b.bin", &[0; 10], source()).unwrap();
        let err = store
            .add("c.bin", &[0; 6], source())
            .unwrap_err()
            .to_string();
        assert!(err.contains("full"), "{err}");
        assert!(store.duplicate(&a.id).is_err());
        store.add("c.bin", &[0; 5], source()).unwrap();
        let err = store.add("d.bin", &[], source()).unwrap_err().to_string();
        assert!(err.contains("3 of 3"), "{err}");
        let usage = store.usage().unwrap();
        assert_eq!(
            (
                usage.count,
                usage.total_bytes,
                usage.max_count,
                usage.max_total_bytes,
                usage.max_file_bytes
            ),
            (3, 25, 3, 25, 10)
        );
        assert_eq!(store.list().unwrap().len(), 3);
        store.remove(&a.id).unwrap();
        store.add("d.bin", &[0; 10], source()).unwrap();
        let defaults = f.store.usage().unwrap();
        assert_eq!(
            (
                defaults.max_file_bytes,
                defaults.max_total_bytes,
                defaults.max_count
            ),
            (
                MAX_UPLOAD_BYTES,
                MAX_UPLOADS_TOTAL_BYTES,
                MAX_UPLOAD_COUNT as u32
            )
        );
        assert_eq!(MAX_UPLOAD_BYTES, MAX_ATTACHMENT_BYTES as u64);
    }

    #[test]
    fn save_to_workspace_never_overwrites_and_respects_protected_dirs() {
        let f = fixture();
        let mut ws = CoreWorkspace::open(f.workspace.path()).unwrap();
        fs::write(f.workspace.path().join("a.txt"), b"original").unwrap();
        let up = f.store.add("a.txt", b"upload", source()).unwrap();
        let saved = f.store.save_to_workspace(&up.id, &mut ws, "").unwrap();
        assert_eq!((saved.path.as_str(), saved.renamed), ("a (1).txt", true));
        assert_eq!(
            fs::read(f.workspace.path().join("a.txt")).unwrap(),
            b"original"
        );
        assert_eq!(
            fs::read(f.workspace.path().join("a (1).txt")).unwrap(),
            b"upload"
        );
        let nested = f
            .store
            .save_to_workspace(&up.id, &mut ws, "docs/in")
            .unwrap();
        assert_eq!(nested.path, "docs/in/a.txt");
        for dir in [".git", ".span", "node_modules", "a/.git", "..", "../x"] {
            assert!(
                f.store.save_to_workspace(&up.id, &mut ws, dir).is_err(),
                "{dir}"
            );
        }
        let outside = f.workspace.path().parent().unwrap().display().to_string();
        assert!(f
            .store
            .save_to_workspace(&up.id, &mut ws, &outside)
            .is_err());
    }

    #[test]
    fn ids_are_validated_everywhere() {
        let f = fixture();
        f.store.add("a.txt", b"x", source()).unwrap();
        for id in [
            "",
            "../index",
            "0123456789ABCDEF0123456789ABCDEF",
            "0123456789abcdef",
            "0123456789abcdef0123456789abcdeg",
            "0123456789abcdef0123456789abcdef/",
            "index",
        ] {
            assert!(!is_valid_upload_id(id), "{id}");
            assert!(f.store.get_meta(id).is_err());
            assert!(f.store.read(id, 0, 1).is_err());
            assert!(f.store.rename(id, "b.txt").is_err());
            assert!(f.store.duplicate(id).is_err());
            assert!(f.store.remove(id).is_err());
            assert!(f.store.external_copy(id).is_err());
        }
        let unknown = "0123456789abcdef0123456789abcdef";
        assert!(is_valid_upload_id(unknown));
        assert!(f.store.get_meta(unknown).is_err());
        assert_eq!(f.store.list().unwrap().len(), 1);
    }

    #[test]
    fn source_ids_are_bounded() {
        let f = fixture();
        let mut bad = source();
        bad.message_id = Some("x".repeat(MAX_SOURCE_FIELD + 1));
        assert!(f.store.add("a.txt", b"x", bad).is_err());
        let mut control = source();
        control.agent_id = Some("a\nb".into());
        assert!(f.store.add("a.txt", b"x", control).is_err());
        let agent = UploadSource {
            session_id: None,
            agent_id: None,
            message_id: None,
            origin: UploadOrigin::AgentGenerated,
            session_title: None,
        };
        let up = f.store.add("a.txt", b"x", agent.clone()).unwrap();
        assert_eq!(up.source, agent);
        assert_eq!(
            serde_json::to_value(&up.source).unwrap()["origin"],
            "agent-generated"
        );
    }

    #[test]
    fn external_copy_uses_display_name_inside_store() {
        let f = fixture();
        let up = f
            .store
            .add("report.pdf", b"%PDF-1.7 body", source())
            .unwrap();
        let copy = f.store.external_copy(&up.id).unwrap();
        assert!(copy.path.starts_with(f.store.dir()));
        assert_eq!(copy.path.file_name().unwrap(), "report.pdf");
        assert_eq!(fs::read(&copy.path).unwrap(), b"%PDF-1.7 body");
        assert!(copy.open_refusal().is_none());
        fs::write(&copy.path, b"edited outside").unwrap();
        assert_eq!(
            f.store.read(&up.id, 0, 100).unwrap().bytes,
            b"%PDF-1.7 body"
        );
        f.store.rename(&up.id, "renamed.pdf").unwrap();
        assert!(!copy.path.exists());
        let again = f.store.external_copy(&up.id).unwrap();
        assert_eq!(again.path.file_name().unwrap(), "renamed.pdf");
        let script = f
            .store
            .add("run.sh", b"#!/bin/sh\necho hi", source())
            .unwrap();
        assert!(f
            .store
            .external_copy(&script.id)
            .unwrap()
            .open_refusal()
            .is_some());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_blob_pointing_out_of_store_is_refused() {
        let f = fixture();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, b"secret").unwrap();
        let up = f.store.add("a.txt", b"x", source()).unwrap();
        let blob = f.store.dir().join("blobs").join(format!("{}.bin", up.id));
        fs::remove_file(&blob).unwrap();
        std::os::unix::fs::symlink(&secret, &blob).unwrap();
        assert!(f.store.read(&up.id, 0, 100).is_err());
        assert!(f.store.external_copy(&up.id).is_err());
        let mut ws = CoreWorkspace::open(f.workspace.path()).unwrap();
        assert!(f.store.save_to_workspace(&up.id, &mut ws, "").is_err());
        assert!(f.store.duplicate(&up.id).is_err());
        // A symlinked copy folder is replaced, not followed.
        let real = f.store.add("b.txt", b"y", source()).unwrap();
        let open_dir = f.store.dir().join("open");
        fs::create_dir_all(&open_dir).unwrap();
        std::os::unix::fs::symlink(outside.path(), open_dir.join(&real.id)).unwrap();
        let copy = f.store.external_copy(&real.id).unwrap();
        assert!(copy.path.starts_with(f.store.dir()));
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
        assert_eq!(fs::read(&secret).unwrap(), b"secret");
    }

    #[cfg(unix)]
    #[test]
    fn executable_bit_blocks_open() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.txt");
        fs::write(&path, b"plain").unwrap();
        assert!(!is_executable(&path));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(is_executable(&path));
        assert!(open_refusal("x.txt", b"plain", true).is_some());
    }

    #[test]
    fn per_workspace_isolation() {
        let base = tempfile::tempdir().unwrap();
        let (one, two) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let a = UploadStore::open(base.path(), one.path()).unwrap();
        let b = UploadStore::open(base.path(), two.path()).unwrap();
        assert_ne!(a.dir(), b.dir());
        let up = a.add("a.txt", b"one", source()).unwrap();
        assert!(b.list().unwrap().is_empty());
        assert!(b.get_meta(&up.id).is_err());
        assert!(b.read(&up.id, 0, 10).is_err());
        assert!(b.remove(&up.id).is_err());
        let again = UploadStore::open(base.path(), &one.path().join(".")).unwrap();
        assert_eq!(again.dir(), a.dir());
        assert_eq!(again.list().unwrap().len(), 1);
    }

    #[test]
    fn concurrent_adds_from_two_threads_keep_every_entry() {
        let f = fixture();
        let handles: Vec<_> = (0..2)
            .map(|t| {
                let store = f.store.clone();
                std::thread::spawn(move || {
                    (0..25)
                        .map(|i| {
                            store
                                .add(
                                    &format!("t{t}-{i}.txt"),
                                    format!("{t}{i}").as_bytes(),
                                    source(),
                                )
                                .unwrap()
                                .id
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let ids: HashSet<String> = handles
            .into_iter()
            .flat_map(|h| h.join().unwrap())
            .collect();
        assert_eq!(ids.len(), 50);
        let listed: HashSet<String> = f.store.list().unwrap().into_iter().map(|u| u.id).collect();
        assert_eq!(listed, ids);
        let usage = f.store.usage().unwrap();
        assert_eq!((usage.count, usage.orphan_blobs), (50, 0));
        let temps = fs::read_dir(f.store.dir().join("blobs"))
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with('.')
            })
            .count();
        assert_eq!(temps, 0);
    }

    #[test]
    fn risky_extension_table() {
        for name in [
            "setup.exe",
            "a.MSI",
            "run.bat",
            "run.cmd",
            "x.com",
            "x.scr",
            "x.ps1",
            "x.sh",
            "x.command",
            "Thing.app",
            "x.pkg",
            "x.dmg",
            "x.jar",
            "x.vbs",
            "x.js",
            "x.AppImage",
            "x.desktop",
            "x.lnk",
            "x.py",
            "x.hta",
            "x.reg",
        ] {
            let reason = open_refusal(name, b"", false);
            assert!(
                reason
                    .as_deref()
                    .is_some_and(|r| r.contains("Save to workspace")),
                "{name}"
            );
        }
        for name in [
            "a.pdf",
            "a.png",
            "a.txt",
            "a.md",
            "a.csv",
            "a.json",
            "a.zip",
            "a.mp4",
            "notes",
            "a.exe.txt",
            "a.jsx",
            "a.ts",
            "a.docx",
        ] {
            assert_eq!(open_refusal(name, b"hello", false), None, "{name}");
        }
        for head in [
            &b"MZ\x90\x00"[..],
            b"\x7FELF\x02",
            b"\xCF\xFA\xED\xFE",
            b"#!/bin/sh",
        ] {
            assert!(
                open_refusal("innocent.txt", head, false).is_some(),
                "{head:?}"
            );
        }
        assert!(open_refusal("a.txt", b"x", true).is_some());
    }

    #[test]
    fn mime_sniffing_table() {
        use UploadKind::*;
        let cases: &[(&str, &[u8], &str, UploadKind)] = &[
            ("a.png", b"\x89PNG\r\n\x1a\n", "image/png", Image),
            ("a.jpg", b"\xFF\xD8\xFF\xE0", "image/jpeg", Image),
            ("a.gif", b"GIF89a", "image/gif", Image),
            ("a.webp", b"RIFF\0\0\0\0WEBPVP8 ", "image/webp", Image),
            ("a.wav", b"RIFF\0\0\0\0WAVEfmt ", "audio/wav", Media),
            ("a.pdf", b"%PDF-1.7", "application/pdf", Document),
            ("a.zip", b"PK\x03\x04", "application/zip", Archive),
            (
                "a.docx",
                b"PK\x03\x04",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                Document,
            ),
            (
                "a.xlsx",
                b"PK\x03\x04",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                Data,
            ),
            ("a.gz", b"\x1F\x8B\x08", "application/gzip", Archive),
            (
                "a.7z",
                b"7z\xBC\xAF\x27\x1C",
                "application/x-7z-compressed",
                Archive,
            ),
            ("a.mp3", b"ID3\x04", "audio/mpeg", Media),
            ("a.mp4", b"\0\0\0\x18ftypisom", "video/mp4", Media),
            ("a.mov", b"\0\0\0\x14ftypqt  ", "video/quicktime", Media),
            ("a.woff2", b"wOF2", "font/woff2", Font),
            ("a.ttf", b"\x00\x01\x00\x00\x00", "font/ttf", Font),
            (
                "a.db",
                b"SQLite format 3\x00",
                "application/vnd.sqlite3",
                Data,
            ),
            ("a.csv", b"a,b\n", "text/csv", Data),
            ("a.json", b"{}", "application/json", Data),
            ("a.rs", b"fn main() {}", "text/x-rust", Code),
            ("a.svg", b"<svg/>", "image/svg+xml", Image),
            ("README", b"plain words \xC3", "text/plain", Document),
            ("blob", b"\x00\x01\x02", "application/octet-stream", Other),
            ("empty", b"", "application/octet-stream", Other),
            ("photo.txt", b"\x89PNG\r\n\x1a\n", "image/png", Image),
            (
                "tool.png",
                b"MZ\x90\x00",
                "application/vnd.microsoft.portable-executable",
                Other,
            ),
            ("UPPER.PDF", b"", "application/pdf", Document),
            ("a.tar.gz", b"", "application/gzip", Archive),
        ];
        for (name, head, mime, kind) in cases {
            assert_eq!(
                sniff_upload(name, head),
                (mime.to_string(), *kind),
                "{name}"
            );
        }
    }

    #[test]
    fn clear_removes_blobs_open_copies_orphans_and_index_but_not_the_workspace() {
        let f = fixture();
        std::fs::write(f.workspace.path().join("keep.txt"), b"workspace file").unwrap();
        let a = f.store.add("a.txt", b"aaaa", source()).unwrap();
        f.store.add("b.txt", b"bb", source()).unwrap();
        let mut workspace = CoreWorkspace::open(f.workspace.path()).unwrap();
        let saved = f
            .store
            .save_to_workspace(&a.id, &mut workspace, "assets")
            .unwrap();
        let copy = f.store.external_copy(&a.id).unwrap();
        assert!(copy.path.is_file());
        let orphan = f
            .store
            .dir()
            .join(BLOB_DIR)
            .join(format!("{}.bin", "f".repeat(32)));
        std::fs::write(&orphan, b"orphan").unwrap();
        std::fs::write(
            f.store.dir().join(format!("{CORRUPT_PREFIX}1-0.json")),
            b"{",
        )
        .unwrap();

        let cleared = f.store.clear().unwrap();
        assert_eq!(
            cleared,
            ClearedUploads {
                files: 3,
                bytes: 4 + 2 + 6
            }
        );
        assert!(f.store.list().unwrap().is_empty());
        assert!(!orphan.exists());
        assert!(!copy.path.exists());
        assert!(!f.store.dir().join(OPEN_DIR).exists());
        assert!(!f.store.dir().join(INDEX_FILE).exists());
        let usage = f.store.usage().unwrap();
        assert_eq!(
            (
                usage.count,
                usage.total_bytes,
                usage.orphan_blobs,
                usage.quarantined_indexes
            ),
            (0, 0, 0, 0)
        );
        // The workspace and the copy saved into it are untouched.
        assert_eq!(
            std::fs::read(f.workspace.path().join("keep.txt")).unwrap(),
            b"workspace file"
        );
        assert_eq!(
            std::fs::read(f.workspace.path().join(&saved.path)).unwrap(),
            b"aaaa"
        );
        // The store keeps working after a clear.
        f.store.add("c.txt", b"c", source()).unwrap();
        assert_eq!(f.store.list().unwrap().len(), 1);
    }

    #[test]
    fn clear_on_an_empty_store_reports_nothing() {
        let f = fixture();
        assert_eq!(
            f.store.clear().unwrap(),
            ClearedUploads { files: 0, bytes: 0 }
        );
    }

    #[test]
    fn session_titles_are_stored_as_clean_display_text() {
        let f = fixture();
        let titled = UploadSource {
            session_title: Some("  Fix the\nlogin bug\u{7}  ".into()),
            ..source()
        };
        let up = f.store.add("a.txt", b"x", titled).unwrap();
        assert_eq!(
            up.source.session_title.as_deref(),
            Some("Fix the login bug")
        );
        assert_eq!(
            f.store
                .get_meta(&up.id)
                .unwrap()
                .source
                .session_title
                .as_deref(),
            Some("Fix the login bug")
        );
        let blank = UploadSource {
            session_title: Some(" \t ".into()),
            ..source()
        };
        assert_eq!(
            f.store
                .add("b.txt", b"y", blank)
                .unwrap()
                .source
                .session_title,
            None
        );
        let long = UploadSource {
            session_title: Some("\u{e9}".repeat(300)),
            ..source()
        };
        let title = f
            .store
            .add("c.txt", b"z", long)
            .unwrap()
            .source
            .session_title
            .unwrap();
        assert!(title.len() <= MAX_SOURCE_FIELD && title.chars().all(|c| c == '\u{e9}'));
        // Entries written before titles existed still read.
        let raw = std::fs::read_to_string(f.store.dir().join(INDEX_FILE)).unwrap();
        let mut index: serde_json::Value = serde_json::from_str(&raw).unwrap();
        for upload in index["uploads"].as_array_mut().unwrap() {
            upload["source"]
                .as_object_mut()
                .unwrap()
                .remove("sessionTitle");
        }
        std::fs::write(f.store.dir().join(INDEX_FILE), index.to_string()).unwrap();
        assert!(f
            .store
            .list()
            .unwrap()
            .iter()
            .all(|u| u.source.session_title.is_none()));
    }
}
