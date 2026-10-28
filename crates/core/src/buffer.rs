use crate::{CoreError, Result};
use ropey::Rope;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BufferSnapshot {
    pub path: String,
    pub text: String,
    pub revision: u64,
    /// Latest revision whose text equals the loaded or successfully saved baseline.
    pub saved_revision: u64,
    pub language: String,
}

/// A transaction acknowledgement without materializing the complete document.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BufferRevision {
    pub path: String,
    pub revision: u64,
    /// Latest revision whose text equals the loaded or successfully saved baseline.
    pub saved_revision: u64,
}

/// Offsets are UTF-16 code units in the pre-transaction document, as in CodeMirror.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub from: u32,
    pub to: u32,
    pub insert: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProposalHunk {
    pub id: String,
    pub from: u32,
    pub to: u32,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EditProposal {
    pub id: String,
    pub path: String,
    pub base_revision: u64,
    pub hunks: Vec<ProposalHunk>,
}

#[derive(Clone)]
pub(crate) struct Buffer {
    pub rope: Rope,
    pub revision: u64,
    /// Latest revision whose text equals the loaded or successfully saved baseline.
    pub saved_revision: u64,
    pub disk_signature: Option<u64>,
    // A persistent Rope clone shares untouched chunks with the current document.
    saved_rope: Rope,
    equal_prefix: usize,
    equal_suffix: usize,
    #[cfg(test)]
    compared_chars: u64,
}

impl Buffer {
    pub fn new(text: String, exists: bool) -> Self {
        let rope = Rope::from_str(&text);
        let length = rope.len_chars();
        Self {
            saved_rope: rope.clone(),
            rope,
            revision: 0,
            saved_revision: 0,
            disk_signature: exists.then(|| signature(text.as_bytes())),
            equal_prefix: length,
            equal_suffix: length,
            #[cfg(test)]
            compared_chars: 0,
        }
    }

    pub fn snapshot(&self, path: &str) -> BufferSnapshot {
        BufferSnapshot {
            path: path.to_owned(),
            text: self.rope.to_string(),
            revision: self.revision,
            saved_revision: self.saved_revision,
            language: language(path).to_owned(),
        }
    }

    pub fn check_revision(&self, expected: u64) -> Result<()> {
        if expected != self.revision {
            return Err(CoreError::StaleRevision {
                expected,
                actual: self.revision,
            });
        }
        Ok(())
    }

    pub fn apply(&mut self, expected: u64, edits: &[TextEdit]) -> Result<()> {
        self.check_revision(expected)?;
        if edits.is_empty() {
            return Ok(());
        }
        let mut converted = Vec::with_capacity(edits.len());
        let mut previous_end = 0;
        for (i, edit) in edits.iter().enumerate() {
            if edit.from > edit.to || (i > 0 && edit.from < previous_end) {
                return Err(CoreError::InvalidEdit(
                    "changes must be ordered and non-overlapping".into(),
                ));
            }
            converted.push((
                utf16_to_char(&self.rope, edit.from)?,
                utf16_to_char(&self.rope, edit.to)?,
                &edit.insert,
            ));
            previous_end = edit.to;
        }
        let next_revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| CoreError::InvalidEdit("revision counter exhausted".into()))?;
        for (from, to, insert) in converted.into_iter().rev() {
            // These exterior characters were not touched, even when the edit changes length.
            self.equal_prefix = self.equal_prefix.min(from);
            self.equal_suffix = self.equal_suffix.min(self.rope.len_chars() - to);
            self.rope.remove(from..to);
            self.rope.insert(from, insert);
        }
        self.revision = next_revision;
        self.reconcile_saved_content();
        Ok(())
    }

    /// Save acknowledgement and content equality are distinct from revision identity.
    /// Matching the saved baseline may advance saved_revision without rewinding revision.
    pub(crate) fn mark_saved(&mut self) {
        self.saved_rope = self.rope.clone();
        self.equal_prefix = self.rope.len_chars();
        self.equal_suffix = self.rope.len_chars();
        self.saved_revision = self.revision;
    }

    fn reconcile_saved_content(&mut self) {
        let current_length = self.rope.len_chars();
        let saved_length = self.saved_rope.len_chars();
        // Different lengths prove dirtiness without inspecting document content.
        if current_length != saved_length {
            return;
        }
        let current_end = current_length - self.equal_suffix;
        let saved_end = saved_length - self.equal_suffix;
        let mut prefix = 0;
        #[cfg(test)]
        let mut compared = 0;
        for (current, saved) in self
            .rope
            .slice(self.equal_prefix..current_end)
            .chars()
            .zip(self.saved_rope.slice(self.equal_prefix..saved_end).chars())
        {
            #[cfg(test)]
            {
                compared += 1;
            }
            if current != saved {
                break;
            }
            prefix += 1;
        }
        self.equal_prefix += prefix;
        // Restrict suffix comparison to the remaining window, so matching regions never overlap.
        let mut suffix = 0;
        let remaining = (current_end - self.equal_prefix).min(saved_end - self.equal_prefix);
        for (current, saved) in self
            .rope
            .chars_at(current_end)
            .reversed()
            .zip(self.saved_rope.chars_at(saved_end).reversed())
            .take(remaining)
        {
            #[cfg(test)]
            {
                compared += 1;
            }
            if current != saved {
                break;
            }
            suffix += 1;
        }
        self.equal_suffix += suffix;
        #[cfg(test)]
        {
            self.compared_chars += compared;
        }
        if current_length == saved_length && self.equal_prefix + self.equal_suffix == current_length
        {
            self.saved_revision = self.revision;
            // Both full equal exterior regions may overlap only while the buffer is clean.
            self.equal_prefix = current_length;
            self.equal_suffix = current_length;
        }
    }
}

fn utf16_to_char(rope: &Rope, offset: u32) -> Result<usize> {
    let offset = offset as usize;
    if offset > rope.len_utf16_cu() {
        return Err(CoreError::InvalidEdit(format!(
            "UTF-16 offset {offset} exceeds document length"
        )));
    }
    let char_index = rope.utf16_cu_to_char(offset);
    if rope.char_to_utf16_cu(char_index) != offset {
        return Err(CoreError::InvalidEdit(format!(
            "UTF-16 offset {offset} splits a surrogate pair"
        )));
    }
    Ok(char_index)
}

pub(crate) fn language(path: &str) -> &'static str {
    let path = Path::new(path);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_ascii_lowercase);
    if name
        .as_deref()
        .is_some_and(|name| name == ".env" || name.starts_with(".env."))
    {
        return "dotenv";
    }
    match path
        .extension()
        .and_then(|s| s.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("ts" | "tsx" | "mts" | "cts") => "typescript",
        Some("js" | "jsx" | "mjs" | "cjs") => "javascript",
        Some("json" | "jsonc") => "json",
        Some("md" | "markdown" | "mdown" | "mkd" | "mdx") => "markdown",
        Some("rs") => "rust",
        Some("py" | "pyi") => "python",
        Some("java" | "jav") => "java",
        Some("yaml" | "yml") => "yaml",
        Some("css") => "css",
        Some("scss") => "scss",
        Some("less") => "less",
        Some("html" | "htm") => "html",
        Some("vue") => "vue",
        Some("svelte") => "svelte",
        Some("toml") => "toml",
        Some("sh" | "bash" | "zsh") => "shell",
        _ => "text",
    }
}

pub(crate) fn signature(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod dirty_tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn deterministic_unicode_transactions_match_exact_saved_string_baseline() {
        let mut buffer = Buffer::new("a😀a\néé\r\nrepeat repeat".into(), true);
        let mut baseline = buffer.rope.to_string();
        let mut oracle = baseline.clone();
        let mut random = 0x8329_efa4_1122_7a91_u64;
        for step in 0..5_000 {
            random = random
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let length = oracle.chars().count();
            let replacements = ["", "a", "😀", "é", "\n", "a😀", "\r\n", "repeat"];
            let mut changes = if step % 13 == 0 {
                vec![(0, length, baseline.clone())]
            } else if step % 7 == 0 && length > 0 {
                vec![(0, 0, "😀".into()), (length, length, "é".into())]
            } else {
                let from = (random as usize) % (length + 1);
                let to = from + ((random >> 17) as usize) % (length - from + 1);
                vec![(
                    from,
                    to,
                    replacements[((random >> 33) as usize) % replacements.len()].to_owned(),
                )]
            };
            let original_chars: Vec<char> = oracle.chars().collect();
            let edits = changes
                .iter()
                .map(|(from, to, text)| TextEdit {
                    from: original_chars[..*from]
                        .iter()
                        .map(|ch| ch.len_utf16() as u32)
                        .sum(),
                    to: original_chars[..*to]
                        .iter()
                        .map(|ch| ch.len_utf16() as u32)
                        .sum(),
                    insert: text.clone(),
                })
                .collect::<Vec<_>>();
            for (from, to, text) in changes.drain(..).rev() {
                let from_byte = oracle
                    .char_indices()
                    .nth(from)
                    .map_or(oracle.len(), |(index, _)| index);
                let to_byte = oracle
                    .char_indices()
                    .nth(to)
                    .map_or(oracle.len(), |(index, _)| index);
                oracle.replace_range(from_byte..to_byte, &text);
            }
            buffer.apply(buffer.revision, &edits).unwrap();
            assert_eq!(buffer.rope.to_string(), oracle, "text at step {step}");
            assert_eq!(
                buffer.revision != buffer.saved_revision,
                oracle != baseline,
                "dirty at step {step}"
            );
            if step % 97 == 0 {
                buffer.mark_saved();
                baseline = oracle.clone();
                assert_eq!(buffer.revision, buffer.saved_revision);
            }
        }
    }

    #[test]
    fn repeated_text_restored_by_different_positions_is_clean() {
        let mut buffer = Buffer::new("aaaa".into(), true);
        buffer
            .apply(
                0,
                &[TextEdit {
                    from: 0,
                    to: 0,
                    insert: "a".into(),
                }],
            )
            .unwrap();
        buffer
            .apply(
                1,
                &[TextEdit {
                    from: 4,
                    to: 5,
                    insert: "".into(),
                }],
            )
            .unwrap();
        assert_eq!(buffer.rope.to_string(), "aaaa");
        assert_eq!(buffer.revision, buffer.saved_revision);
    }

    #[test]
    fn hundred_mib_local_insert_delete_does_not_scan_unchanged_text() {
        let size = 100 * 1024 * 1024;
        let mut buffer = Buffer::new("a".repeat(size), true);
        let middle = (size / 2) as u32;
        let started = Instant::now();
        for _ in 0..100 {
            buffer
                .apply(
                    buffer.revision,
                    &[TextEdit {
                        from: middle,
                        to: middle,
                        insert: "😀".into(),
                    }],
                )
                .unwrap();
            assert_ne!(buffer.revision, buffer.saved_revision);
            buffer
                .apply(
                    buffer.revision,
                    &[TextEdit {
                        from: middle,
                        to: middle + 2,
                        insert: "".into(),
                    }],
                )
                .unwrap();
            assert_eq!(buffer.revision, buffer.saved_revision);
        }
        assert_eq!(
            buffer.compared_chars, 0,
            "unchanged saved prefix/suffix must not be scanned"
        );
        eprintln!(
            "100 MiB: 200 local transactions in {:?}, saved-content characters compared={}",
            started.elapsed(),
            buffer.compared_chars
        );
    }

    #[test]
    fn failed_atomic_edit_preserves_saved_envelope_and_dirty_state() {
        let mut buffer = Buffer::new("a😀b".into(), true);
        assert!(buffer
            .apply(
                0,
                &[
                    TextEdit {
                        from: 0,
                        to: 1,
                        insert: "z".into()
                    },
                    TextEdit {
                        from: 2,
                        to: 3,
                        insert: "x".into()
                    }
                ]
            )
            .is_err());
        assert_eq!(buffer.rope.to_string(), "a😀b");
        assert_eq!(buffer.revision, buffer.saved_revision);
        buffer
            .apply(
                0,
                &[TextEdit {
                    from: 1,
                    to: 3,
                    insert: "😀".into(),
                }],
            )
            .unwrap();
        assert_eq!(buffer.revision, buffer.saved_revision);
    }
}

#[cfg(test)]
mod language_tests {
    use super::language;

    #[test]
    fn java_files_are_java_not_text() {
        for path in [
            "App.java",
            "src/main/java/com/example/todo/Controller.java",
            "UPPER.JAVA",
            "old.jav",
        ] {
            assert_eq!(language(path), "java", "{path}");
        }
    }

    #[test]
    fn existing_languages_and_the_text_fallback_are_unchanged() {
        assert_eq!(language("a.ts"), "typescript");
        assert_eq!(language("a.rs"), "rust");
        assert_eq!(language("a.py"), "python");
        assert_eq!(language(".env.local"), "dotenv");
        assert_eq!(language("notes.unknown"), "text");
        assert_eq!(language("Makefile"), "text");
    }
}
