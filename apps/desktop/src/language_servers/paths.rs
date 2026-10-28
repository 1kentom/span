//! Path identity for documents.
//!
//! The workspace root comes from `canonicalize`, which on Windows yields the verbatim
//! form `\\?\C:\proj`, while servers report `file:///c%3A/proj/a.ts`, which decodes to
//! `c:\proj\a.ts`. Documents are keyed, compared and shown relative to the root through
//! the helpers here so both spellings meet. The text functions are pure and run on every
//! OS; only `normalize_path` is conditional (other platforms keep paths untouched).

use std::path::{Path, PathBuf};

fn has_drive(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() >= 2
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b.len() == 2 || matches!(b[2], b'\\' | b'/'))
}

/// A Windows style path: drive letter or UNC share (after normalisation).
fn windows_style(text: &str) -> bool {
    has_drive(text) || text.starts_with("\\\\")
}

/// Strip the verbatim prefix, upper case the drive letter and use `\` separators for
/// Windows style paths. Anything else (POSIX paths) is returned unchanged.
pub fn normalize_path_text(text: &str) -> String {
    let mut rest = text;
    let mut unc = false;
    for verbatim_unc in ["\\\\?\\UNC\\", "//?/UNC/"] {
        if let Some(r) = rest.strip_prefix(verbatim_unc) {
            rest = r;
            unc = true;
        }
    }
    if !unc {
        for verbatim in ["\\\\?\\", "//?/"] {
            if let Some(r) = rest.strip_prefix(verbatim) {
                if has_drive(r) {
                    rest = r;
                }
            }
        }
    }
    // `/c:/proj` as produced by decoding a `file:///c%3A/proj` URI path.
    if let Some(r) = rest.strip_prefix('/') {
        if has_drive(r) {
            rest = r;
        }
    }
    if unc {
        return format!("\\\\{}", rest.replace('/', "\\"));
    }
    if has_drive(rest) {
        let mut out = String::with_capacity(rest.len());
        out.push(rest.as_bytes()[0].to_ascii_uppercase() as char);
        out.push_str(&rest[1..].replace('/', "\\"));
        return out;
    }
    if rest.starts_with("\\\\") {
        return rest.replace('/', "\\");
    }
    text.to_owned()
}

/// `normalize_path_text` for a `Path`; a no-op outside Windows.
pub fn normalize_path(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(normalize_path_text(&path.to_string_lossy()))
    } else {
        path.to_path_buf()
    }
}

/// `root` joined with the workspace relative `relative` (either separator), normalised.
pub fn join_normalized(root: &Path, relative: &str) -> PathBuf {
    normalize_path(&root.join(relative))
}

/// Workspace relative path with forward slashes when `path` is inside `root`, else the
/// normalised absolute path. Windows style paths compare case insensitively.
pub fn display_path_text(root: &str, path: &str) -> String {
    let root = normalize_path_text(root);
    let path = normalize_path_text(path);
    let windows = windows_style(&root) && windows_style(&path);
    let sep = if windows { '\\' } else { '/' };
    let root_trimmed = root.trim_end_matches(sep);
    if path.len() >= root_trimmed.len() && path.is_char_boundary(root_trimmed.len()) {
        let (head, tail) = path.split_at(root_trimmed.len());
        let same = if windows {
            head.eq_ignore_ascii_case(root_trimmed)
        } else {
            head == root_trimmed
        };
        if same && (tail.is_empty() || tail.starts_with(sep)) {
            return tail.trim_start_matches(sep).replace('\\', "/");
        }
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_verbatim_prefixes_and_normalises_drive_and_separators() {
        for (input, want) in [
            ("\\\\?\\C:\\proj\\a.ts", "C:\\proj\\a.ts"),
            ("c:\\proj\\a.ts", "C:\\proj\\a.ts"),
            ("c:/proj/src/a.ts", "C:\\proj\\src\\a.ts"),
            ("C:\\proj/src/a.ts", "C:\\proj\\src\\a.ts"),
            ("/c:/proj/a.ts", "C:\\proj\\a.ts"),
            ("\\\\?\\UNC\\srv\\share\\a.ts", "\\\\srv\\share\\a.ts"),
            ("\\\\srv/share/a.ts", "\\\\srv\\share\\a.ts"),
            ("/home/me/proj/a.ts", "/home/me/proj/a.ts"),
            ("relative/a.ts", "relative/a.ts"),
        ] {
            assert_eq!(normalize_path_text(input), want, "{input}");
        }
    }

    #[test]
    fn verbatim_root_and_server_uri_path_meet() {
        let key = normalize_path_text("\\\\?\\C:\\proj\\a.ts");
        let from_uri = normalize_path_text("c:\\proj\\a.ts");
        assert_eq!(key, from_uri);
    }

    #[test]
    fn relative_display_path_across_spellings() {
        for (root, path, want) in [
            ("\\\\?\\C:\\proj", "c:\\proj\\src\\a.ts", "src/a.ts"),
            ("\\\\?\\C:\\proj\\", "C:\\proj\\a.ts", "a.ts"),
            ("c:\\Proj", "C:\\proj\\a.ts", "a.ts"),
            ("C:\\proj", "C:\\proj", ""),
            ("C:\\proj", "C:\\project\\a.ts", "C:\\project\\a.ts"),
            ("C:\\proj", "D:\\other\\a.ts", "D:\\other\\a.ts"),
            ("/home/me/proj", "/home/me/proj/src/a.ts", "src/a.ts"),
            (
                "/home/me/proj",
                "/home/me/project/a.ts",
                "/home/me/project/a.ts",
            ),
            ("/home/me/proj", "/etc/a.ts", "/etc/a.ts"),
            ("/home/me/Proj", "/home/me/proj/a.ts", "/home/me/proj/a.ts"),
        ] {
            assert_eq!(display_path_text(root, path), want, "{root} {path}");
        }
    }
}
