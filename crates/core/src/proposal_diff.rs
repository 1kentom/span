use crate::{CoreError, Result, TextEdit};
use similar::{Algorithm, ChangeTag, TextDiff};

/// Build contiguous line-change groups in the original document's UTF-16 coordinates.
/// Equal lines terminate a hunk, so accepting one group never consumes another group.
pub(crate) fn line_edits(before: &str, after: &str) -> Result<Vec<TextEdit>> {
    let mut edits = Vec::new();
    let mut pending: Option<TextEdit> = None;
    let mut old_offset = 0_u32;
    let diff = TextDiff::configure()
        .algorithm(Algorithm::Myers)
        .diff_lines(before, after);
    for change in diff.iter_all_changes() {
        let value = change.value();
        let units = u32::try_from(value.encode_utf16().count())
            .map_err(|_| CoreError::InvalidEdit("Proposal exceeds UTF-16 offset range".into()))?;
        match change.tag() {
            ChangeTag::Equal => {
                if let Some(edit) = pending.take() {
                    edits.push(edit);
                }
                old_offset = advance(old_offset, units)?;
            }
            ChangeTag::Delete => {
                let edit = pending.get_or_insert_with(|| TextEdit {
                    from: old_offset,
                    to: old_offset,
                    insert: String::new(),
                });
                old_offset = advance(old_offset, units)?;
                edit.to = old_offset;
            }
            ChangeTag::Insert => {
                let edit = pending.get_or_insert_with(|| TextEdit {
                    from: old_offset,
                    to: old_offset,
                    insert: String::new(),
                });
                edit.insert.push_str(value);
            }
        }
    }
    if let Some(edit) = pending {
        edits.push(edit);
    }
    Ok(edits)
}

fn advance(offset: u32, units: u32) -> Result<u32> {
    offset
        .checked_add(units)
        .ok_or_else(|| CoreError::InvalidEdit("Proposal exceeds UTF-16 offset range".into()))
}
