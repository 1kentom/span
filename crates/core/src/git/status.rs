use crate::{CoreError, Result};

pub(super) struct ParsedStatus {
    pub branch: Option<String>,
    pub head: Option<String>,
    pub detached: bool,
    pub unborn: bool,
    pub entries: Vec<super::GitChange>,
}

pub(super) fn parse_status(bytes: &[u8]) -> Result<ParsedStatus> {
    let mut parsed = ParsedStatus {
        branch: None,
        head: None,
        detached: false,
        unborn: false,
        entries: Vec::new(),
    };
    let mut chunks = bytes.split(|b| *b == 0).peekable();
    while let Some(current) = chunks.next() {
        if current.is_empty() {
            continue;
        }
        if current.starts_with(b"# ") {
            parse_header(current, &mut parsed)?;
            continue;
        }
        let marker = current[0];
        if marker != b'1' && marker != b'2' && marker != b'u' && marker != b'?' {
            return Err(malformed("unknown record type"));
        }
        if marker == b'?' {
            if current.get(1) != Some(&b' ') {
                return Err(malformed("bad untracked record"));
            }
            let path = &current[2..];
            if path.is_empty() {
                return Err(malformed("empty untracked path"));
            }
            parsed
                .entries
                .push(make_change(b"??", path, None, true, false, false));
        } else {
            let count = match marker {
                b'1' => 9,
                b'2' => 10,
                _ => 11,
            };
            let fields = split_fields(current, count)?;
            let xy = fields[1];
            let path = fields[count - 1];
            if path.is_empty() {
                return Err(malformed("empty record path"));
            }
            let (submodule, mode_gitlink) = (
                fields[2] != b"N...",
                fields[3..6].iter().any(|m| *m == b"160000"),
            );
            let conflicted = marker == b'u';
            let mut change =
                make_change(xy, path, None, false, conflicted, submodule || mode_gitlink);
            if marker == b'2' {
                let old = chunks
                    .next()
                    .ok_or_else(|| malformed("missing rename source path"))?;
                assign_old_path(&mut change, path, old);
            }
            if mode_gitlink {
                change.unsupported_reason =
                    Some("Git submodule changes are not editable as files".to_string());
            }
            if conflicted {
                change.unsupported_reason =
                    Some("Conflicted files must be resolved in Git".to_string());
            }
            parsed.entries.push(change);
        }
        if parsed.entries.len() > 10_000 {
            return Err(malformed("too many status entries"));
        }
    }
    Ok(parsed)
}

fn parse_header(line: &[u8], out: &mut ParsedStatus) -> Result<()> {
    if let Some(value) = line.strip_prefix(b"# branch.oid ") {
        if value == b"(initial)" {
            out.unborn = true;
        } else {
            out.head = Some(ascii(value)?);
        }
    } else if let Some(value) = line.strip_prefix(b"# branch.head ") {
        if value == b"(detached)" {
            out.detached = true;
        } else {
            out.branch = Some(String::from_utf8_lossy(value).into_owned());
        }
    }
    Ok(())
}

fn split_fields(record: &[u8], count: usize) -> Result<Vec<&[u8]>> {
    let mut fields = Vec::with_capacity(count);
    let mut rest = record;
    for _ in 1..count {
        let pos = rest
            .iter()
            .position(|b| *b == b' ')
            .ok_or_else(|| malformed("too few fields"))?;
        fields.push(&rest[..pos]);
        rest = &rest[pos + 1..];
    }
    if rest.is_empty() {
        return Err(malformed("missing path"));
    }
    fields.push(rest);
    Ok(fields)
}

fn make_change(
    xy: &[u8],
    path: &[u8],
    old: Option<&[u8]>,
    untracked: bool,
    conflicted: bool,
    submodule: bool,
) -> super::GitChange {
    let (path_value, display_path, invalid) = path_value(path);
    let mut change = super::GitChange {
        id: stable_id(path, old),
        path: path_value,
        display_path,
        old_path: None,
        display_old_path: None,
        index_status: xy
            .first()
            .copied()
            .map(char::from)
            .unwrap_or('?')
            .to_string(),
        worktree_status: xy
            .get(1)
            .copied()
            .map(char::from)
            .unwrap_or('?')
            .to_string(),
        untracked,
        conflicted,
        submodule,
        unsupported_reason: None,
    };
    if invalid {
        change.unsupported_reason = Some("Path is not valid UTF-8".to_string());
    }
    if submodule && change.unsupported_reason.is_none() {
        change.unsupported_reason =
            Some("Git submodule changes are not editable as files".to_string());
    }
    if conflicted && change.unsupported_reason.is_none() {
        change.unsupported_reason = Some("Conflicted files must be resolved in Git".to_string());
    }
    if let Some(old) = old {
        assign_old_path(&mut change, path, old);
    }
    change
}

fn assign_old_path(change: &mut super::GitChange, path: &[u8], old: &[u8]) {
    let (value, display, invalid) = path_value(old);
    change.old_path = value;
    change.display_old_path = Some(display);
    if invalid {
        change.path = None;
        change.unsupported_reason = Some("Rename path is not valid UTF-8".to_string());
    }
    change.id = stable_id(path, Some(old));
}

fn path_value(raw: &[u8]) -> (Option<String>, String, bool) {
    match std::str::from_utf8(raw) {
        Ok(s) => (Some(s.to_string()), s.to_string(), false),
        Err(_) => (None, String::from_utf8_lossy(raw).into_owned(), true),
    }
}

fn stable_id(path: &[u8], old: Option<&[u8]>) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in path
        .iter()
        .chain([0xff].iter())
        .chain(old.unwrap_or_default())
    {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn ascii(value: &[u8]) -> Result<String> {
    if !value.is_ascii() {
        return Err(malformed("non-ASCII metadata"));
    }
    String::from_utf8(value.to_vec()).map_err(|_| malformed("invalid metadata"))
}

fn malformed(reason: &str) -> CoreError {
    CoreError::Git(format!("Malformed Git status: {reason}"))
}

#[cfg(test)]
mod tests {
    use super::parse_status;

    #[test]
    fn parses_branch_staged_worktree_and_untracked_records() {
        let data = b"# branch.oid abcdef\0# branch.head main\01 M. N... 100644 100644 100644 aaaaaaaa bbbbbbbb staged.txt\0? untracked file.txt\0";
        let status = parse_status(data).unwrap();
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.head.as_deref(), Some("abcdef"));
        assert_eq!(status.entries.len(), 2);
        assert_eq!(status.entries[0].path.as_deref(), Some("staged.txt"));
        assert_eq!(status.entries[0].index_status, "M");
        assert_eq!(
            status.entries[1].path.as_deref(),
            Some("untracked file.txt")
        );
        assert!(status.entries[1].untracked);
    }

    #[test]
    fn parses_rename_unicode_and_embedded_newline_path() {
        let data = "# branch.head topic\02 R. N... 100644 100644 100644 aaaaaaaa bbbbbbbb R100 新しい\nname\0old name.txt\0".as_bytes();
        let status = parse_status(data).unwrap();
        assert_eq!(status.entries[0].path.as_deref(), Some("新しい\nname"));
        assert_eq!(status.entries[0].old_path.as_deref(), Some("old name.txt"));
        assert_eq!(status.entries[0].index_status, "R");
    }

    #[test]
    fn parses_actual_git_z_headers_and_rename_path_tokens() {
        // Captured from `git status --porcelain=v2 -z --branch --untracked-files=all --ignore-submodules=none --renames`.
        let data = b"# branch.oid c7c2405fd3ec4c5591f63bbdfa4acb036c0acb0b\0# branch.head t\xc3\xb3pico\02 R. N... 100644 100644 100644 78981922613b2afb6025042ff6bd878ac1994e85 78981922613b2afb6025042ff6bd878ac1994e85 R100 new\nname\0old name\0";
        let status = parse_status(data).unwrap();
        assert_eq!(status.branch.as_deref(), Some("tópico"));
        assert_eq!(
            status.head.as_deref(),
            Some("c7c2405fd3ec4c5591f63bbdfa4acb036c0acb0b")
        );
        assert_eq!(status.entries[0].path.as_deref(), Some("new\nname"));
        assert_eq!(status.entries[0].old_path.as_deref(), Some("old name"));
    }

    #[test]
    fn handles_unborn_detached_conflict_and_invalid_path_bytes() {
        let unborn = parse_status(b"# branch.oid (initial)\0# branch.head main\0").unwrap();
        assert!(unborn.unborn);
        assert_eq!(unborn.branch.as_deref(), Some("main"));
        let detached = parse_status(b"# branch.oid 0123\0# branch.head (detached)\0").unwrap();
        assert!(detached.detached);
        assert_eq!(detached.head.as_deref(), Some("0123"));

        let conflict =
            parse_status(b"u UU N... 100644 100644 100644 100644 a b c conflict\0").unwrap();
        assert!(conflict.entries[0].conflicted);
        assert!(conflict.entries[0].unsupported_reason.is_some());

        let invalid = parse_status(b"? bad\xffpath\0").unwrap();
        assert!(invalid.entries[0].path.is_none());
        assert!(invalid.entries[0].unsupported_reason.is_some());
    }

    #[test]
    fn rejects_malformed_records() {
        assert!(parse_status(b"1 M. N... 100644\0").is_err());
        assert!(parse_status(b"? \0").is_err());
    }
}
