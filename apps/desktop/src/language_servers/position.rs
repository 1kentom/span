//! Conversion between the app's edit format and LSP positions.
//!
//! The editor addresses text with UTF-16 code unit offsets into the pre-transaction
//! document (CodeMirror). LSP wants `(line, character)` pairs where `character` is
//! also UTF-16 and lines end at `\n`, `\r\n` or `\r` (not at the other Unicode line
//! separators that `ropey` knows about).

use span_core::TextEdit;
use span_lsp::lsp_types::{Position, Range, TextDocumentContentChangeEvent};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PositionError {
    Unsorted,
    OutOfRange(u32),
    SplitsSurrogate(u32),
}

impl fmt::Display for PositionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsorted => write!(f, "offsets must be sorted ascending"),
            Self::OutOfRange(offset) => write!(f, "offset {offset} is past the end of the text"),
            Self::SplitsSurrogate(offset) => write!(f, "offset {offset} splits a surrogate pair"),
        }
    }
}

impl std::error::Error for PositionError {}

/// A UTF-16 offset resolved to a byte index and an LSP position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Located {
    pub byte: usize,
    pub position: Position,
}

/// Resolve ascending UTF-16 `offsets` in one pass over `text`.
pub fn locate_offsets(text: &str, offsets: &[u32]) -> Result<Vec<Located>, PositionError> {
    let mut out = Vec::with_capacity(offsets.len());
    let mut next = 0;
    let mut utf16 = 0u32;
    let mut byte = 0usize;
    let mut line = 0u32;
    let mut line_start = 0u32;
    let mut chars = text.chars().peekable();
    loop {
        while next < offsets.len() && offsets[next] <= utf16 {
            if offsets[next] < utf16 {
                return Err(PositionError::Unsorted);
            }
            out.push(Located {
                byte,
                position: Position::new(line, utf16 - line_start),
            });
            next += 1;
        }
        let Some(ch) = chars.next() else { break };
        let width = ch.len_utf16() as u32;
        if next < offsets.len() && offsets[next] > utf16 && offsets[next] < utf16 + width {
            return Err(PositionError::SplitsSurrogate(offsets[next]));
        }
        utf16 += width;
        byte += ch.len_utf8();
        if ch == '\n' || (ch == '\r' && chars.peek() != Some(&'\n')) {
            line += 1;
            line_start = utf16;
        }
    }
    match offsets.get(next) {
        Some(offset) => Err(PositionError::OutOfRange(*offset)),
        None => Ok(out),
    }
}

/// An app transaction converted for both consumers.
#[derive(Debug, Clone, PartialEq)]
pub struct ConvertedEdits {
    /// LSP content changes, ordered so that applying them one after another is correct.
    pub changes: Vec<TextDocumentContentChangeEvent>,
    /// The text after the transaction.
    pub text: String,
}

/// Convert an app transaction (ascending, non-overlapping edits against `text`) into
/// sequentially applicable LSP changes (last edit first, so earlier positions stay
/// valid) and the resulting text.
pub fn convert_edits(text: &str, edits: &[TextEdit]) -> Result<ConvertedEdits, PositionError> {
    let mut offsets = Vec::with_capacity(edits.len() * 2);
    for edit in edits {
        offsets.push(edit.from);
        offsets.push(edit.to);
    }
    let located = locate_offsets(text, &offsets)?;
    let mut next = String::with_capacity(text.len());
    let mut cursor = 0usize;
    for (i, edit) in edits.iter().enumerate() {
        next.push_str(&text[cursor..located[2 * i].byte]);
        next.push_str(&edit.insert);
        cursor = located[2 * i + 1].byte;
    }
    next.push_str(&text[cursor..]);
    let changes = edits
        .iter()
        .enumerate()
        .rev()
        .map(|(i, edit)| TextDocumentContentChangeEvent {
            range: Some(Range::new(
                located[2 * i].position,
                located[2 * i + 1].position,
            )),
            range_length: None,
            text: edit.insert.clone(),
        })
        .collect();
    Ok(ConvertedEdits {
        changes,
        text: next,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use span_lsp::TrackedDocument;

    fn edit(from: u32, to: u32, insert: &str) -> TextEdit {
        TextEdit {
            from,
            to,
            insert: insert.to_owned(),
        }
    }

    fn pos(line: u32, character: u32) -> Position {
        Position::new(line, character)
    }

    #[test]
    fn emoji_counts_as_two_units() {
        // "a😀b\nc": a=0, emoji=1..3, b=3, \n=4, c=5
        let text = "a😀b\nc";
        let located = locate_offsets(text, &[0, 1, 3, 4, 5, 6]).unwrap();
        let positions: Vec<_> = located.iter().map(|l| l.position).collect();
        assert_eq!(
            positions,
            vec![
                pos(0, 0),
                pos(0, 1),
                pos(0, 3),
                pos(0, 4),
                pos(1, 0),
                pos(1, 1)
            ]
        );
        assert_eq!(located[2].byte, 5, "byte index after the 4 byte emoji");
        assert_eq!(
            locate_offsets(text, &[2]),
            Err(PositionError::SplitsSurrogate(2))
        );
    }

    #[test]
    fn cjk_is_one_unit_but_three_bytes() {
        let text = "漢字\nx";
        let located = locate_offsets(text, &[1, 2, 3]).unwrap();
        assert_eq!(located[0].position, pos(0, 1));
        assert_eq!(located[0].byte, 3);
        assert_eq!(located[2].position, pos(1, 0));
    }

    #[test]
    fn line_breaks_follow_lsp_not_unicode() {
        // \r\n is one break, a lone \r is a break, U+2028 and VT are not.
        let text = "a\r\nb\rc\u{2028}d\u{b}e";
        let located = locate_offsets(text, &[3, 5, 8, 10]).unwrap();
        assert_eq!(located[0].position, pos(1, 0));
        assert_eq!(located[1].position, pos(2, 0));
        assert_eq!(located[2].position, pos(2, 3));
        assert_eq!(located[3].position, pos(2, 5));
    }

    #[test]
    fn rejects_bad_offsets() {
        assert_eq!(
            locate_offsets("ab", &[3]),
            Err(PositionError::OutOfRange(3))
        );
        assert_eq!(locate_offsets("ab", &[2, 1]), Err(PositionError::Unsorted));
        assert!(locate_offsets("ab", &[2]).is_ok());
    }

    #[test]
    fn multi_edit_transaction_is_converted_against_the_old_text() {
        let text = "😀 one\n二 two\nthree";
        // 😀=0..2 " "=2 "one"=3..6 \n=6 二=7 " "=8 "two"=9..12 \n=12
        let edits = vec![edit(0, 2, "X"), edit(9, 12, "2\n2"), edit(12, 12, "!")];
        let converted = convert_edits(text, &edits).unwrap();
        assert_eq!(converted.text, "X one\n二 2\n2!\nthree");
        // Last edit first.
        assert_eq!(converted.changes.len(), 3);
        assert_eq!(
            converted.changes[0].range,
            Some(Range::new(pos(1, 5), pos(1, 5)))
        );
        assert_eq!(
            converted.changes[2].range,
            Some(Range::new(pos(0, 0), pos(0, 2)))
        );
        // The LSP side, applying the changes one by one, agrees with the direct result.
        let mut doc = TrackedDocument::new("file:///t".into(), "x".into(), 1, text.to_owned());
        doc.apply_changes(converted.changes, 2).unwrap();
        assert_eq!(doc.content(), converted.text);
    }

    #[test]
    fn matches_the_core_rope_for_random_looking_edits() {
        use span_core::{CoreWorkspace, TextEdit as CoreEdit};
        let dir = tempfile::tempdir().unwrap();
        let original = "fn 😀() {\n\t// 日本語 ✓\r\n}\n";
        std::fs::write(dir.path().join("a.rs"), original).unwrap();
        let mut ws = CoreWorkspace::open(dir.path()).unwrap();
        ws.open_buffer("a.rs").unwrap();
        let units: Vec<u16> = original.encode_utf16().collect();
        let end = units.len() as u32;
        let edits = vec![
            CoreEdit {
                from: 3,
                to: 5,
                insert: "ok".into(),
            },
            CoreEdit {
                from: 12,
                to: 12,
                insert: "🎉".into(),
            },
            CoreEdit {
                from: end,
                to: end,
                insert: "// end".into(),
            },
        ];
        let converted = convert_edits(original, &edits).unwrap();
        ws.edit_buffer_delta("a.rs", 0, edits).unwrap();
        assert_eq!(ws.buffer_snapshot("a.rs").unwrap().text, converted.text);
    }
}
