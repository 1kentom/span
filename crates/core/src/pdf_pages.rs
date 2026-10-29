//! PDF page count for attachment tiles (#91) when the viewer's PDF library
//! cannot open the file. A count is returned only when it reads reliably from
//! plain (uncompressed) objects: the catalog's page tree root, or else the one
//! page tree node without a parent. Anything else (object streams, damaged
//! files, several candidate roots) gives `None`, and the UI leaves the count
//! out rather than guess.
use std::collections::HashMap;

/// Upper bound on a believable page count.
const MAX_PAGES: u64 = 1_000_000;

fn is_white(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r' | b'\n' | b'\x0c' | b'\0')
}

fn is_delimiter(byte: u8) -> bool {
    is_white(byte)
        || matches!(
            byte,
            b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
        )
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= haystack.len() || needle.is_empty() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| at + from)
}

fn skip_white(bytes: &[u8], mut at: usize) -> usize {
    while at < bytes.len() && is_white(bytes[at]) {
        at += 1;
    }
    at
}

/// Positions right after each occurrence of the PDF name `name` (with its
/// slash) that is a whole name, not the prefix of a longer one.
fn names<'a>(body: &'a [u8], name: &'a [u8]) -> impl Iterator<Item = usize> + 'a {
    let mut from = 0;
    std::iter::from_fn(move || loop {
        let at = find(body, name, from)?;
        from = at + 1;
        let end = at + name.len();
        if end >= body.len() || is_delimiter(body[end]) {
            return Some(end);
        }
    })
}

fn has_name_value(body: &[u8], key: &[u8], value: &[u8]) -> bool {
    names(body, key).any(|end| {
        let at = skip_white(body, end);
        body[at..].starts_with(value)
            && body
                .get(at + value.len())
                .is_none_or(|next| is_delimiter(*next))
    })
}

fn integer_after(body: &[u8], key: &[u8]) -> Option<u64> {
    let end = names(body, key).next()?;
    let at = skip_white(body, end);
    let digits = body[at..].iter().take_while(|b| b.is_ascii_digit()).count();
    if digits == 0 || digits > 12 {
        return None;
    }
    std::str::from_utf8(&body[at..at + digits])
        .ok()?
        .parse()
        .ok()
}

/// `/Key N G R`: the referenced object number.
fn reference_after(body: &[u8], key: &[u8]) -> Option<u64> {
    let end = names(body, key).next()?;
    let mut at = skip_white(body, end);
    let number_len = body[at..].iter().take_while(|b| b.is_ascii_digit()).count();
    let number: u64 = std::str::from_utf8(&body[at..at + number_len])
        .ok()?
        .parse()
        .ok()?;
    at = skip_white(body, at + number_len);
    let gen_len = body[at..].iter().take_while(|b| b.is_ascii_digit()).count();
    if gen_len == 0 {
        return None;
    }
    at = skip_white(body, at + gen_len);
    (body.get(at) == Some(&b'R')).then_some(number)
}

/// Indirect objects by number; a later definition replaces an earlier one
/// (incremental updates). Only the dictionary part before any stream.
fn objects(bytes: &[u8]) -> HashMap<u64, &[u8]> {
    let mut found = HashMap::new();
    let mut from = 0;
    while let Some(at) = find(bytes, b"obj", from) {
        from = at + 3;
        if at == 0
            || !is_white(bytes[at - 1])
            || bytes.get(at + 3).is_some_and(|b| !is_delimiter(*b))
        {
            continue;
        }
        // Back over "<num> <gen> ".
        let mut cursor = at;
        while cursor > 0 && is_white(bytes[cursor - 1]) {
            cursor -= 1;
        }
        let gen_end = cursor;
        while cursor > 0 && bytes[cursor - 1].is_ascii_digit() {
            cursor -= 1;
        }
        if cursor == gen_end {
            continue;
        }
        let gap_end = cursor;
        while cursor > 0 && is_white(bytes[cursor - 1]) {
            cursor -= 1;
        }
        if cursor == gap_end {
            continue;
        }
        let number_end = cursor;
        while cursor > 0 && bytes[cursor - 1].is_ascii_digit() {
            cursor -= 1;
        }
        if cursor == number_end || (cursor > 0 && !is_delimiter(bytes[cursor - 1])) {
            continue;
        }
        let Some(number) = std::str::from_utf8(&bytes[cursor..number_end])
            .ok()
            .and_then(|n| n.parse::<u64>().ok())
        else {
            continue;
        };
        let start = at + 3;
        let end = find(bytes, b"endobj", start).unwrap_or(bytes.len());
        let body = &bytes[start..end];
        let body = match find(body, b"stream", 0) {
            Some(stream) => &body[..stream],
            None => body,
        };
        found.insert(number, body);
        from = end.max(from);
    }
    found
}

fn count_of(body: &[u8]) -> Option<u32> {
    let count = integer_after(body, b"/Count")?;
    (count > 0 && count <= MAX_PAGES).then_some(count as u32)
}

/// Number of pages, or `None` when it cannot be read reliably.
pub fn pdf_page_count(bytes: &[u8]) -> Option<u32> {
    find(&bytes[..bytes.len().min(1024)], b"%PDF-", 0)?;
    let objects = objects(bytes);
    let is_pages = |body: &[u8]| has_name_value(body, b"/Type", b"/Pages");
    // The catalog names the page tree root.
    let catalogs: Vec<&[u8]> = objects
        .values()
        .copied()
        .filter(|body| has_name_value(body, b"/Type", b"/Catalog"))
        .collect();
    if let [catalog] = catalogs.as_slice() {
        if let Some(root) = reference_after(catalog, b"/Pages").and_then(|n| objects.get(&n)) {
            if is_pages(root) {
                return count_of(root);
            }
        }
    }
    // Otherwise only one parentless page tree node counts.
    let roots: Vec<&[u8]> = objects
        .values()
        .copied()
        .filter(|body| is_pages(body) && names(body, b"/Parent").next().is_none())
        .collect();
    match roots.as_slice() {
        [root] => count_of(root),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pdf(objects: &[&str]) -> Vec<u8> {
        let mut out = String::from("%PDF-1.4\n%\u{e2}\u{e3}\n");
        for (index, body) in objects.iter().enumerate() {
            out.push_str(&format!("{} 0 obj\n{body}\nendobj\n", index + 1));
        }
        out.push_str("trailer\n<< /Root 1 0 R >>\n%%EOF\n");
        out.into_bytes()
    }

    #[test]
    fn reads_the_count_from_the_catalog_page_tree() {
        let bytes = pdf(&[
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
            "<< /Type /Page /Parent 2 0 R >>",
            "<< /Type /Page /Parent 2 0 R >>",
        ]);
        assert_eq!(pdf_page_count(&bytes), Some(2));
    }

    #[test]
    fn nested_page_trees_use_the_root_count() {
        let bytes = pdf(&[
            "<</Type/Catalog/Pages 2 0 R>>",
            "<</Type/Pages/Kids[3 0 R]/Count 7>>",
            "<</Type/Pages/Parent 2 0 R/Kids[]/Count 7>>",
        ]);
        assert_eq!(pdf_page_count(&bytes), Some(7));
    }

    #[test]
    fn without_a_catalog_one_parentless_root_still_counts() {
        let bytes = pdf(&[
            "<< /Type /Pages /Count 3 /Kids [] >>",
            "<< /Type /Pages /Parent 1 0 R /Count 1 >>",
        ]);
        assert_eq!(pdf_page_count(&bytes), Some(3));
    }

    #[test]
    fn a_later_revision_of_an_object_wins() {
        let mut bytes = pdf(&[
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [] /Count 1 >>",
        ]);
        bytes.extend_from_slice(b"2 0 obj\n<< /Type /Pages /Kids [] /Count 5 >>\nendobj\n%%EOF\n");
        assert_eq!(pdf_page_count(&bytes), Some(5));
    }

    #[test]
    fn unreliable_files_give_no_count() {
        assert_eq!(pdf_page_count(b"not a pdf /Type /Pages /Count 3"), None);
        // Compressed object streams hide the page tree.
        assert_eq!(
            pdf_page_count(&pdf(&["<< /Type /ObjStm /N 3 /First 10 >>"])),
            None
        );
        // Two candidate roots and no catalog.
        assert_eq!(
            pdf_page_count(&pdf(&[
                "<< /Type /Pages /Count 3 >>",
                "<< /Type /Pages /Count 4 >>"
            ])),
            None
        );
        // `/Pagesx` is a different name, and zero pages is not a count.
        assert_eq!(
            pdf_page_count(&pdf(&["<< /Type /Pagesx /Count 3 >>"])),
            None
        );
        assert_eq!(pdf_page_count(&pdf(&["<< /Type /Pages /Count 0 >>"])), None);
    }
}
