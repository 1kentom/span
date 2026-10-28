//! Pure, platform independent path rules for archive entries. Windows paths are judged as
//! strings so every rule is tested on every platform.
use super::UnsafeReason;
use crate::attachment::{is_protected, is_windows_reserved, MAX_NAME_BYTES};
use std::collections::{HashMap, HashSet};

/// Longest accepted entry path, in bytes, before normalisation.
pub(crate) const MAX_PATH_BYTES: usize = 4096;

/// A normalised, safe entry path: clean components joined with `/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SafePath {
    pub components: Vec<String>,
}

impl SafePath {
    pub fn joined(&self) -> String {
        self.components.join("/")
    }
}

/// Classify a raw entry name.
///
/// Rules, in order:
/// 1. empty, NUL or any control character, or longer than 4096 bytes: unsafe.
/// 2. `\\server`, `//server`, `\\?\` and `//?/` prefixes: UNC, unsafe.
/// 3. a drive prefix such as `C:` (with or without a separator): unsafe.
/// 4. a leading `/` or `\`: absolute, unsafe.
/// 5. backslashes are path separators (old Windows tools write them), so `a\b` becomes
///    `a/b` and `..\..\x` is caught as traversal on every platform.
/// 6. empty and `.` components are dropped; any `..` component is traversal, never resolved.
/// 7. each component follows the attachment rules: at most 255 bytes, none of `<>:"|?*`,
///    no trailing dot or space, no Windows reserved device name, and no protected
///    directory (`.git`, `.span`, `node_modules`, any case). Such entries are skipped,
///    never renamed, so what is written always matches what the archive says.
pub(crate) fn classify_path(raw: &str) -> Result<SafePath, UnsafeReason> {
    if raw.is_empty() {
        return Err(UnsafeReason::Empty);
    }
    if raw.chars().any(char::is_control) {
        return Err(UnsafeReason::ControlCharacter);
    }
    if raw.len() > MAX_PATH_BYTES {
        return Err(UnsafeReason::NameTooLong);
    }
    let bytes = raw.as_bytes();
    let is_sep = |b: u8| b == b'/' || b == b'\\';
    if bytes.len() >= 2 && is_sep(bytes[0]) && is_sep(bytes[1]) {
        return Err(UnsafeReason::UncPrefix);
    }
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(UnsafeReason::DrivePrefix);
    }
    if is_sep(bytes[0]) {
        return Err(UnsafeReason::Absolute);
    }
    let mut components = Vec::new();
    for part in raw.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(UnsafeReason::ParentTraversal);
        }
        components.push(part);
    }
    if components.is_empty() {
        return Err(UnsafeReason::Empty);
    }
    for part in &components {
        if let Some(reason) = component_issue(part) {
            return Err(reason);
        }
    }
    Ok(SafePath {
        components: components.into_iter().map(str::to_owned).collect(),
    })
}

/// The attachment component rules, as a reason instead of an error.
pub(crate) fn component_issue(name: &str) -> Option<UnsafeReason> {
    if name.len() > MAX_NAME_BYTES {
        return Some(UnsafeReason::NameTooLong);
    }
    if name
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return Some(UnsafeReason::InvalidCharacter);
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Some(UnsafeReason::TrailingDotOrSpace);
    }
    if is_windows_reserved(name) {
        return Some(UnsafeReason::ReservedName);
    }
    if is_protected(name) {
        return Some(UnsafeReason::ProtectedDirectory);
    }
    None
}

/// Reasons that mean the entry names a location outside the archive's own tree.
pub(crate) fn points_outside(reason: UnsafeReason) -> bool {
    matches!(
        reason,
        UnsafeReason::Absolute
            | UnsafeReason::DrivePrefix
            | UnsafeReason::UncPrefix
            | UnsafeReason::ParentTraversal
            | UnsafeReason::EscapesDestination
            | UnsafeReason::Symlink
            | UnsafeReason::Hardlink
    )
}

/// OS clutter skipped by the "Skip hidden files" option: `.DS_Store`, `Thumbs.db`,
/// AppleDouble `._name` files and anything inside `__MACOSX`.
pub(crate) fn is_hidden_clutter(components: &[String]) -> bool {
    if components
        .iter()
        .any(|c| c.eq_ignore_ascii_case("__MACOSX"))
    {
        return true;
    }
    components.last().is_some_and(|name| {
        name.eq_ignore_ascii_case(".DS_Store")
            || name.eq_ignore_ascii_case("Thumbs.db")
            || name.starts_with("._")
    })
}

/// Entries whose paths would land on the same file on a case-insensitive filesystem, plus
/// exact duplicates and a file that another entry needs as a folder. Returns the indexes
/// (into `paths`) that collide. Two folder entries never collide with each other.
pub(crate) fn collisions(paths: &[(usize, &SafePath, bool)]) -> HashSet<usize> {
    let mut files: HashMap<String, Vec<usize>> = HashMap::new();
    let mut dirs: HashMap<String, Vec<usize>> = HashMap::new();
    let mut implied: HashMap<String, Vec<usize>> = HashMap::new();
    for &(index, path, is_dir) in paths {
        let lower: Vec<String> = path.components.iter().map(|c| c.to_lowercase()).collect();
        let key = lower.join("/");
        if is_dir {
            dirs.entry(key).or_default().push(index);
        } else {
            files.entry(key).or_default().push(index);
        }
        for depth in 1..lower.len() {
            implied
                .entry(lower[..depth].join("/"))
                .or_default()
                .push(index);
        }
    }
    let mut colliding = HashSet::new();
    for (key, owners) in &files {
        let clash_dirs = dirs.get(key);
        let clash_children = implied.get(key);
        if owners.len() > 1 || clash_dirs.is_some() || clash_children.is_some() {
            colliding.extend(owners.iter().copied());
            colliding.extend(clash_dirs.into_iter().flatten().copied());
            colliding.extend(clash_children.into_iter().flatten().copied());
        }
    }
    colliding
}

/// Folder name for "Extract into a new folder": the archive name without its archive
/// extension, or `archive` when nothing usable is left.
pub(crate) fn folder_name_for(archive_name: &str) -> String {
    let base = archive_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(archive_name);
    let lower = base.to_ascii_lowercase();
    let stem = [".tar.gz", ".tgz", ".zip", ".tar"]
        .iter()
        .find(|ext| lower.ends_with(*ext) && lower.len() > ext.len())
        .map_or(base, |ext| &base[..base.len() - ext.len()]);
    let cleaned: String = stem
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim_end_matches(['.', ' ']).to_owned();
    if cleaned.is_empty() || cleaned == "." || component_issue(&cleaned).is_some() {
        "archive".to_owned()
    } else {
        cleaned
    }
}
