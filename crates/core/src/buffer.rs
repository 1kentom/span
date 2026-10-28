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
    pub saved_revision: u64,
    pub language: String,
}

/// A transaction acknowledgement without materializing the complete document.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BufferRevision {
    pub path: String,
    pub revision: u64,
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
    pub saved_revision: u64,
    pub disk_signature: Option<u64>,
}

impl Buffer {
    pub fn new(text: String, exists: bool) -> Self {
        Self {
            rope: Rope::from_str(&text),
            revision: 0,
            saved_revision: 0,
            disk_signature: exists.then(|| signature(text.as_bytes())),
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
            self.rope.remove(from..to);
            self.rope.insert(from, insert);
        }
        self.revision = next_revision;
        Ok(())
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
