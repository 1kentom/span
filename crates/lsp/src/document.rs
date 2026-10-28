//! Document synchronization with UTF-16 position handling.
//!
//! Implements incremental document updates using LSP UTF-16 code unit positions,
//! supporting astral Unicode characters (surrogate pairs) per LSP 3.17 specification.

use crate::error::{LspError, Result};
use lsp_types::{Position, Range, TextDocumentContentChangeEvent};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct TrackedDocument {
    pub uri: String,
    pub language_id: String,
    pub version: i32,
    content: String,
    line_offsets: Vec<usize>,
}

impl TrackedDocument {
    pub fn new(uri: String, language_id: String, version: i32, content: String) -> Self {
        let line_offsets = Self::compute_line_offsets(&content);
        Self {
            uri,
            language_id,
            version,
            content,
            line_offsets,
        }
    }

    pub fn content(&self) -> &str {
        &self.content
    }

    pub fn apply_changes(
        &mut self,
        changes: Vec<TextDocumentContentChangeEvent>,
        new_version: i32,
    ) -> Result<()> {
        if new_version <= self.version {
            return Err(LspError::VersionMismatch {
                expected: self.version + 1,
                actual: new_version,
            });
        }

        // Make updates transactional
        let mut new_content = self.content.clone();

        for change in changes {
            match change.range {
                Some(range) => {
                    new_content = self.apply_ranged_change_to_content(
                        &new_content,
                        range,
                        &change.text,
                        change.range_length,
                    )?;
                }
                None => {
                    new_content = change.text;
                }
            }
        }

        self.content = new_content;
        self.line_offsets = Self::compute_line_offsets(&self.content);
        self.version = new_version;

        Ok(())
    }

    fn apply_ranged_change_to_content(
        &self,
        content: &str,
        range: Range,
        text: &str,
        range_length: Option<u32>,
    ) -> Result<String> {
        let start_offset = self.position_to_offset_in_content(content, &range.start)?;
        let end_offset = if let Some(len) = range_length {
            // rangeLength is UTF-16 code units
            let calculated_end = self.position_to_offset_in_content(content, &range.end)?;
            let utf16_len = self.utf16_length_between(content, start_offset, calculated_end);

            if utf16_len != len as usize {
                return Err(LspError::Protocol(format!(
                    "rangeLength {} does not match range UTF-16 length {}",
                    len, utf16_len
                )));
            }

            calculated_end
        } else {
            self.position_to_offset_in_content(content, &range.end)?
        };

        if end_offset > content.len() || start_offset > end_offset {
            return Err(LspError::Protocol(format!(
                "Invalid range: start={}, end={}, content_len={}",
                start_offset,
                end_offset,
                content.len()
            )));
        }

        // Ensure we're not slicing through UTF-8 code points
        if !content.is_char_boundary(start_offset) || !content.is_char_boundary(end_offset) {
            return Err(LspError::Protocol(
                "Range boundaries do not align with UTF-8 character boundaries".to_string(),
            ));
        }

        let mut new_content =
            String::with_capacity(content.len() - (end_offset - start_offset) + text.len());
        new_content.push_str(&content[..start_offset]);
        new_content.push_str(text);
        new_content.push_str(&content[end_offset..]);

        Ok(new_content)
    }

    fn utf16_length_between(&self, content: &str, start: usize, end: usize) -> usize {
        content[start..end].chars().map(|c| c.len_utf16()).sum()
    }

    fn position_to_offset_in_content(&self, content: &str, position: &Position) -> Result<usize> {
        let line = position.line as usize;
        let line_offsets = Self::compute_line_offsets(content);

        if line >= line_offsets.len() {
            return Err(LspError::Protocol(format!(
                "Line {} out of range (document has {} lines)",
                line,
                line_offsets.len()
            )));
        }

        let line_start = line_offsets[line];
        let line_end = if line + 1 < line_offsets.len() {
            line_offsets[line + 1]
        } else {
            content.len()
        };

        let line_text = &content[line_start..line_end];
        let line_text_trimmed = line_text.trim_end_matches(&['\r', '\n'][..]);

        let mut utf16_offset = 0u32;
        let mut byte_offset = 0;

        for ch in line_text_trimmed.chars() {
            if utf16_offset >= position.character {
                break;
            }

            let utf16_len = ch.len_utf16() as u32;

            // Check if position is in the middle of a surrogate pair
            if utf16_offset + utf16_len > position.character && utf16_len == 2 {
                return Err(LspError::Protocol(format!(
                    "Position {}:{} is in the middle of a surrogate pair",
                    position.line, position.character
                )));
            }

            utf16_offset += utf16_len;
            byte_offset += ch.len_utf8();
        }

        if utf16_offset < position.character {
            return Err(LspError::Protocol(format!(
                "Character offset {} out of range for line {} (max {})",
                position.character, line, utf16_offset
            )));
        }

        Ok(line_start + byte_offset)
    }

    fn compute_line_offsets(content: &str) -> Vec<usize> {
        let mut offsets = vec![0];

        let mut i = 0;
        let bytes = content.as_bytes();

        while i < bytes.len() {
            if bytes[i] == b'\n' {
                offsets.push(i + 1);
            } else if bytes[i] == b'\r' {
                if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                    offsets.push(i + 2);
                    i += 1;
                } else {
                    offsets.push(i + 1);
                }
            }
            i += 1;
        }

        offsets
    }
}

pub struct DocumentRegistry {
    documents: HashMap<String, TrackedDocument>,
}

impl DocumentRegistry {
    pub fn new() -> Self {
        Self {
            documents: HashMap::new(),
        }
    }

    pub fn open(&mut self, uri: String, language_id: String, version: i32, content: String) {
        let doc = TrackedDocument::new(uri.clone(), language_id, version, content);
        self.documents.insert(uri, doc);
    }

    pub fn close(&mut self, uri: &str) {
        self.documents.remove(uri);
    }

    pub fn get(&self, uri: &str) -> Result<&TrackedDocument> {
        self.documents
            .get(uri)
            .ok_or_else(|| LspError::DocumentNotTracked(uri.to_string()))
    }

    pub fn get_mut(&mut self, uri: &str) -> Result<&mut TrackedDocument> {
        self.documents
            .get_mut(uri)
            .ok_or_else(|| LspError::DocumentNotTracked(uri.to_string()))
    }

    pub fn update(
        &mut self,
        uri: &str,
        changes: Vec<TextDocumentContentChangeEvent>,
        version: i32,
    ) -> Result<()> {
        let doc = self.get_mut(uri)?;
        doc.apply_changes(changes, version)
    }
}

impl Default for DocumentRegistry {
    fn default() -> Self {
        Self::new()
    }
}
