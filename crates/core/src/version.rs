//! Small, forgiving version comparison for update checks (ADR 0004).
//!
//! It understands dotted numeric versions with an optional semver-style
//! pre-release, as used by this repository (`0.1.0-nightly.20261028.7`,
//! `0.1.0-preview.20261028.43`, `0.1.0`) and by most agents. Anything it does
//! not recognise parses to `None`, and callers must report that as "unknown",
//! never as "up to date".
use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Identifier {
    Number(u64),
    Text(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    release: Vec<u64>,
    pre: Vec<Identifier>,
}

impl Version {
    /// Accepts an optional leading `v`, two to four dotted numbers, an optional
    /// `-pre.release` suffix, and ignores `+build` metadata.
    pub fn parse(text: &str) -> Option<Version> {
        let text = text.trim();
        let text = text.strip_prefix(['v', 'V']).unwrap_or(text);
        let text = text.split('+').next()?;
        let (release, pre) = match text.split_once('-') {
            Some((release, pre)) => (release, Some(pre)),
            None => (text, None),
        };
        let release: Vec<u64> = release
            .split('.')
            .map(|part| {
                if !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()) {
                    part.parse().ok()
                } else {
                    None
                }
            })
            .collect::<Option<_>>()?;
        if !(2..=4).contains(&release.len()) {
            return None;
        }
        let pre = match pre {
            None => Vec::new(),
            Some(pre) => pre
                .split('.')
                .map(|part| {
                    if part.is_empty()
                        || !part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    {
                        None
                    } else if part.bytes().all(|b| b.is_ascii_digit()) {
                        part.parse().ok().map(Identifier::Number)
                    } else {
                        Some(Identifier::Text(part.to_owned()))
                    }
                })
                .collect::<Option<_>>()?,
        };
        Some(Version { release, pre })
    }

    pub fn is_prerelease(&self) -> bool {
        !self.pre.is_empty()
    }

    /// The first pre-release identifier when it is text, such as `nightly`.
    pub fn pre_label(&self) -> Option<&str> {
        match self.pre.first() {
            Some(Identifier::Text(label)) => Some(label),
            _ => None,
        }
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        let length = self.release.len().max(other.release.len());
        for index in 0..length {
            let a = self.release.get(index).copied().unwrap_or(0);
            let b = other.release.get(index).copied().unwrap_or(0);
            if a != b {
                return a.cmp(&b);
            }
        }
        match (self.pre.is_empty(), other.pre.is_empty()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => {
                for (a, b) in self.pre.iter().zip(&other.pre) {
                    let order = match (a, b) {
                        (Identifier::Number(a), Identifier::Number(b)) => a.cmp(b),
                        (Identifier::Number(_), Identifier::Text(_)) => Ordering::Less,
                        (Identifier::Text(_), Identifier::Number(_)) => Ordering::Greater,
                        (Identifier::Text(a), Identifier::Text(b)) => a.cmp(b),
                    };
                    if order != Ordering::Equal {
                        return order;
                    }
                }
                self.pre.len().cmp(&other.pre.len())
            }
        }
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// `None` when either side is not a recognised version.
pub fn compare(a: &str, b: &str) -> Option<Ordering> {
    Some(Version::parse(a)?.cmp(&Version::parse(b)?))
}

/// The first version-like word of a `--version` line, such as `2.0.32` from
/// `2.0.32 (Claude Code)` or `0.46.0` from `codex-cli 0.46.0`.
pub fn extract(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .map(|word| word.trim_matches(|c: char| matches!(c, '(' | ')' | ',' | ';' | '"' | '\'')))
        .find(|word| {
            let digits = word.strip_prefix(['v', 'V']).unwrap_or(word);
            digits.starts_with(|c: char| c.is_ascii_digit()) && Version::parse(word).is_some()
        })
        .map(|word| word.strip_prefix(['v', 'V']).unwrap_or(word).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use Ordering::{Equal, Greater, Less};

    #[test]
    fn comparison_table() {
        let table = [
            ("2.0.32", "2.2.0", Some(Less)),
            ("2.2.0", "2.2.0", Some(Equal)),
            ("2.10.0", "2.9.9", Some(Greater)),
            ("v1.2.3", "1.2.3", Some(Equal)),
            ("1.2", "1.2.0", Some(Equal)),
            ("1.2.3.4", "1.2.3", Some(Greater)),
            ("1.2.3+build5", "1.2.3", Some(Equal)),
            // This repository's schemes.
            (
                "0.1.0-nightly.20261028.7",
                "0.1.0-nightly.20261028.42",
                Some(Less),
            ),
            (
                "0.1.0-nightly.20261028.42",
                "0.1.0-nightly.20261029.1",
                Some(Less),
            ),
            (
                "0.1.0-nightly.20261028.7",
                "0.1.0-nightly.20261028.7",
                Some(Equal),
            ),
            (
                "0.1.0-nightly.20261028.10",
                "0.1.0-nightly.20261028.9",
                Some(Greater),
            ),
            (
                "0.1.0-preview.20261028.43",
                "0.1.0-preview.20261104.1",
                Some(Less),
            ),
            ("0.1.0-preview.20261028.43", "0.1.0", Some(Less)),
            ("0.1.0", "0.1.0-nightly.20261028.7", Some(Greater)),
            ("0.1.1-nightly.20261101.1", "0.1.0", Some(Greater)),
            ("1.0.0-alpha", "1.0.0-alpha.1", Some(Less)),
            ("1.0.0-1", "1.0.0-alpha", Some(Less)),
            // Not versions: unknown, never "equal".
            ("latest", "1.0.0", None),
            ("1.0.0", "", None),
            ("1", "1.0.0", None),
            ("1.x.0", "1.0.0", None),
            ("1.0.0-", "1.0.0", None),
            ("1.2.3.4.5", "1.2.3", None),
            ("99999999999999999999.0", "1.0", None),
            ("^1.0.0", "1.0.0", None),
        ];
        for (a, b, expected) in table {
            assert_eq!(compare(a, b), expected, "{a} vs {b}");
        }
    }

    #[test]
    fn channel_labels() {
        let nightly = Version::parse("0.1.0-nightly.20261028.7").unwrap();
        assert!(nightly.is_prerelease());
        assert_eq!(nightly.pre_label(), Some("nightly"));
        assert_eq!(
            Version::parse("0.1.0-preview.20261028.43")
                .unwrap()
                .pre_label(),
            Some("preview")
        );
        let stable = Version::parse("0.1.0").unwrap();
        assert!(!stable.is_prerelease() && stable.pre_label().is_none());
    }

    #[test]
    fn extracts_versions_from_probe_output() {
        for (output, expected) in [
            ("2.0.32 (Claude Code)", Some("2.0.32")),
            ("codex-cli 0.46.0", Some("0.46.0")),
            ("0.66.0", Some("0.66.0")),
            ("OpenCode v2.2.0", Some("2.2.0")),
            ("tool 1.0.0-beta.2, built today", Some("1.0.0-beta.2")),
            ("no version here", None),
            ("build 12", None),
            ("", None),
        ] {
            assert_eq!(extract(output).as_deref(), expected, "{output}");
        }
    }
}
