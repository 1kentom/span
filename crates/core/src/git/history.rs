use crate::{CoreError, Result};

const MAX_COMMIT_BODY_BYTES: usize = 64 * 1024;

/// Parses `git log -z --format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b`.
/// Each commit contains seven NUL-delimited fields; `-z` terminates the formatted record.
pub(super) fn parse_history(bytes: &[u8]) -> Result<Vec<super::GitCommit>> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let fields: Vec<&[u8]> = bytes.split(|byte| *byte == 0).collect();
    let mut commits = Vec::new();
    let mut at = 0;
    while at < fields.len() {
        if fields[at].is_empty() {
            at += 1;
            continue;
        }
        if fields.len().saturating_sub(at) < 8 {
            return Err(malformed("incomplete commit record"));
        }
        let id = hash(fields[at])?;
        let parents = parse_parents(fields[at + 1])?;
        let author = String::from_utf8_lossy(fields[at + 2]).into_owned();
        let author_email = String::from_utf8_lossy(fields[at + 3]).into_owned();
        let timestamp = parse_timestamp(fields[at + 4])?;
        let subject = String::from_utf8_lossy(fields[at + 5]).into_owned();
        let body_bytes = fields[at + 6];
        if body_bytes.len() > MAX_COMMIT_BODY_BYTES {
            return Err(malformed("commit body exceeds 64 KiB"));
        }
        let body = String::from_utf8_lossy(body_bytes).into_owned();
        commits.push(super::GitCommit {
            id,
            parents,
            author,
            author_email,
            timestamp,
            subject,
            body,
        });
        at += 7;
        if at < fields.len() && fields[at].is_empty() {
            at += 1;
        }
    }
    Ok(commits)
}

fn hash(raw: &[u8]) -> Result<String> {
    if (raw.len() != 40 && raw.len() != 64) || !raw.iter().all(u8::is_ascii_hexdigit) {
        return Err(malformed("invalid commit hash"));
    }
    String::from_utf8(raw.to_vec()).map_err(|_| malformed("invalid commit hash"))
}

fn parse_parents(raw: &[u8]) -> Result<Vec<String>> {
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    raw.split(|byte| *byte == b' ').map(hash).collect()
}

fn parse_timestamp(raw: &[u8]) -> Result<i64> {
    let text = std::str::from_utf8(raw).map_err(|_| malformed("invalid commit timestamp"))?;
    text.parse::<i64>()
        .map_err(|_| malformed("invalid commit timestamp"))
}

fn malformed(reason: &str) -> CoreError {
    CoreError::Git(format!("Malformed Git history: {reason}"))
}

#[cfg(test)]
mod tests {
    use super::parse_history;

    #[test]
    fn parses_unicode_multiline_and_merge_records() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let c = "c".repeat(40);
        let bytes = format!("{a}\0{b} {c}\0Zoë 🐈\0zoe@example.test\0-123\0Fix café\0First line\n\nSecond line\n\0{b}\0\0A. Author\0a@example.test\00\0Initial\0\0");
        let commits = parse_history(bytes.as_bytes()).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].parents, vec![b, c]);
        assert_eq!(commits[0].author, "Zoë 🐈");
        assert_eq!(commits[0].timestamp, -123);
        assert_eq!(commits[0].subject, "Fix café");
        assert_eq!(commits[0].body, "First line\n\nSecond line\n");
        assert!(commits[1].parents.is_empty());
        assert_eq!(commits[1].body, "");
    }

    #[test]
    fn rejects_bad_hash_timestamp_and_truncated_record() {
        assert!(parse_history(b"not-a-hash\0\0A\0a@b\01\0subject\0body\0").is_err());
        let id = "d".repeat(40);
        assert!(
            parse_history(format!("{id}\0\0A\0a@b\0nope\0subject\0body\0").as_bytes()).is_err()
        );
        assert!(parse_history(format!("{id}\0\0A\0a@b\01\0subject\0").as_bytes()).is_err());
    }

    #[test]
    fn rejects_oversized_body() {
        let id = "e".repeat(40);
        let mut bytes = format!("{id}\0\0A\0a@b\01\0subject\0").into_bytes();
        bytes.extend(std::iter::repeat(b'x').take(64 * 1024 + 1));
        bytes.push(0);
        assert!(parse_history(&bytes).is_err());
    }
}
