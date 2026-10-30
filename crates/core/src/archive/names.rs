//! Archive entry name rules. A name is either a safe relative path made of
//! plain components, or it carries the reason it is refused.
use std::collections::{HashMap, HashSet};
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;

/// Longest entry path kept in a listing and accepted for extraction, in bytes.
pub const MAX_ARCHIVE_PATH_BYTES: usize = 1024;
/// Longest single path component accepted for extraction, in bytes.
pub const MAX_ARCHIVE_COMPONENT_BYTES: usize = 255;
/// Deepest folder nesting accepted for extraction.
pub const MAX_ARCHIVE_DEPTH: usize = 64;

/// Validates a stored entry name. Returns the safe relative path (forward
/// slashes, no trailing slash) or the reason the name is refused.
pub(crate) fn safe_relative_path(name: &str) -> Result<String, &'static str> {
    if name.is_empty() {
        return Err("empty name");
    }
    if name.contains('\0') {
        return Err("NUL character in name");
    }
    // A backslash is a separator on Windows: `a\..\..\b` must never be read as
    // one harmless component on one platform and as a traversal on another.
    if name.contains('\\') {
        return Err("backslash in name");
    }
    if name.len() > MAX_ARCHIVE_PATH_BYTES {
        return Err("name is longer than 1,024 bytes");
    }
    if name.starts_with('/') {
        return Err("absolute path");
    }
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err("drive prefix");
    }
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    // `./a` is common in tar archives; a leading `./` adds nothing and is dropped.
    let trimmed = trimmed.trim_start_matches("./");
    if trimmed.is_empty() {
        return Err("empty name");
    }
    let mut depth = 0;
    for component in trimmed.split('/') {
        depth += 1;
        if component.is_empty() || component == "." {
            return Err("empty path component");
        }
        if component == ".." {
            return Err("parent folder component (..)");
        }
        if component.len() > MAX_ARCHIVE_COMPONENT_BYTES {
            return Err("path component is longer than 255 bytes");
        }
        if component.contains(':') {
            return Err("colon in name (drive or alternate data stream)");
        }
        if component.chars().any(char::is_control) {
            return Err("control character in name");
        }
        if component.ends_with(' ') || component.ends_with('.') {
            return Err("name ends with a space or dot");
        }
        if is_windows_reserved(component) {
            return Err("reserved device name");
        }
    }
    if depth > MAX_ARCHIVE_DEPTH {
        return Err("nested deeper than 64 folders");
    }
    Ok(trimmed.to_owned())
}

/// Truncates a name for display at a character boundary.
pub(crate) fn display_name(name: &str) -> String {
    if name.len() <= MAX_ARCHIVE_PATH_BYTES {
        return name.to_owned();
    }
    let mut end = MAX_ARCHIVE_PATH_BYTES;
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    name[..end].to_owned()
}

fn is_windows_reserved(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or(component);
    let upper = stem.trim_end().to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            upper
                .strip_prefix(prefix)
                .is_some_and(|suffix| matches!(suffix.as_bytes(), [b'1'..=b'9']))
        })
}

/// The key two names share when a case insensitive or normalising file system
/// would store them as one: NFKC, Unicode case folding, then NFC.
pub(crate) fn collision_key(path: &str) -> String {
    let normalized: String = path.nfkc().collect();
    let folded: String = normalized.case_fold().collect();
    folded.nfc().collect()
}

/// Dot files and OS metadata folders.
pub(crate) fn is_hidden(path: &str) -> bool {
    path.split('/')
        .any(|part| part.starts_with('.') || part == "__MACOSX")
}

/// Finds entries whose output paths collide: two files with the same key, or a
/// file that another entry uses as a folder. Returns the indexes to refuse.
/// `items` holds (index, safe path, is_dir).
pub(crate) fn collisions(items: &[(usize, &str, bool)]) -> HashSet<usize> {
    let mut files: HashMap<String, Vec<usize>> = HashMap::new();
    let mut dirs: HashSet<String> = HashSet::new();
    for (index, path, dir) in items {
        let key = collision_key(path);
        if *dir {
            dirs.insert(key);
        } else {
            files.entry(key).or_default().push(*index);
        }
    }
    let mut refused = HashSet::new();
    for indexes in files.values().filter(|indexes| indexes.len() > 1) {
        refused.extend(indexes.iter().copied());
    }
    // A file named like a folder the archive uses elsewhere.
    for (key, indexes) in &files {
        if dirs.contains(key) {
            refused.extend(indexes.iter().copied());
        }
    }
    // A file used as a parent folder: `a` and `a/b`. Depth is bounded, so this
    // is at most 64 lookups per entry.
    for (index, path, _) in items {
        let key = collision_key(path);
        for (offset, byte) in key.bytes().enumerate() {
            if byte == b'/' {
                if let Some(owners) = files.get(&key[..offset]) {
                    refused.insert(*index);
                    refused.extend(owners.iter().copied());
                }
            }
        }
    }
    refused
}
