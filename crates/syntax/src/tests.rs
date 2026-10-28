use super::*;

fn analyze(path: &str, source: &str) -> SyntaxSnapshot {
    match SyntaxEngine::new().highlight(path, source, 7, None) {
        Ok(snapshot) => snapshot,
        Err(error) => panic!("{path}: {error}"),
    }
}

#[test]
fn supplied_grammars_produce_captures_and_structural_folds() {
    let samples = [
        (
            "main.ts",
            "function greet(name: string) {\n  return `Hi ${name}`;\n}\n",
            "function",
        ),
        (
            "main.js",
            "function greet(name) {\n  return name + 'hi';\n}\n",
            "function",
        ),
        (
            "main.json",
            "{\n  \"name\": \"Span\",\n  \"enabled\": true\n}\n",
            "string",
        ),
        (
            "main.md",
            "# Span\n\nSome **bold** and `code`.\n\n```rust\nfn main() {}\n```\n",
            "text.title",
        ),
        (
            "main.rs",
            "fn main() {\n    let name = \"Span\";\n    println!(\"{name}\");\n}\n",
            "function",
        ),
        (
            "main.py",
            "def greet(name):\n    value = 'Span'\n    return value\n",
            "function",
        ),
    ];
    for (path, source, capture) in samples {
        let snapshot = analyze(path, source);
        assert_eq!(snapshot.revision, 7);
        assert!(!snapshot.highlights.is_empty(), "{path} highlights");
        assert!(
            snapshot
                .highlights
                .iter()
                .any(|span| span.kind.contains(capture)),
            "{path} capture {capture}: {:?}",
            snapshot.highlights
        );
        assert!(!snapshot.folds.is_empty(), "{path} folds");
        let units = source.encode_utf16().count() as u32;
        assert!(
            snapshot
                .highlights
                .iter()
                .all(|span| span.from < span.to && span.to <= units),
            "{path} offsets"
        );
        assert!(
            snapshot
                .folds
                .iter()
                .all(|fold| fold.from < fold.to && fold.to <= units),
            "{path} folds offsets"
        );
        assert!(!snapshot.truncated, "{path} was unexpectedly truncated");
    }
}

#[test]
fn tsx_and_jsx_queries_handle_component_names() {
    for path in ["component.tsx", "component.jsx"] {
        let snapshot = analyze(path, "const view = <Panel title=\"Span\">hello</Panel>;\n");
        assert!(
            snapshot
                .highlights
                .iter()
                .any(|span| span.kind == "attribute"),
            "{path}: {:?}",
            snapshot.highlights
        );
    }
}

#[test]
fn markdown_inline_captures_do_not_highlight_fenced_code_as_prose() {
    let source = "**bold** and `inline`\n\n```text\n**literal**\n```\n";
    let snapshot = analyze("notes.md", source);
    let fence = source.find("**literal**").unwrap_or(0) as u32;
    assert!(snapshot
        .highlights
        .iter()
        .any(|span| span.kind.contains("strong")));
    assert!(!snapshot
        .highlights
        .iter()
        .any(|span| span.kind.contains("strong") && span.from >= fence));
}

#[test]
fn unicode_offsets_round_trip_every_character_boundary() {
    let source = "aé日😀Z\r\n\t🙂";
    let offsets = Offsets::new(source);
    for (byte, _) in source
        .char_indices()
        .chain(std::iter::once((source.len(), '\0')))
    {
        let units = source[..byte].encode_utf16().count() as u32;
        assert_eq!(offsets.utf16(byte), units, "byte {byte}");
        assert_eq!(offsets.byte(units), Some(byte), "units {units}");
    }
    assert_eq!(offsets.byte(4), None, "surrogate interior must be rejected");
    assert_eq!(offsets.byte(100), None);
}

#[test]
fn highlight_offsets_use_utf16_after_emoji() {
    let source = "const emoji = '😀'; const café = 42;";
    let snapshot = analyze("unicode.js", source);
    let byte = source.find("42").unwrap_or(0);
    let from = source[..byte].encode_utf16().count() as u32;
    assert!(snapshot
        .highlights
        .iter()
        .any(|span| span.from == from && span.to == from + 2 && span.kind == "number"));
}

#[test]
fn incremental_unicode_replacements_match_a_fresh_parse() {
    let mut cached = SyntaxEngine::new();
    let versions = [
        "fn main() {\n    let x = \"😀\";\n}\n",
        "fn main() {\n    let xy = \"日🙂\";\n    if true {\n        call();\n    }\n}\n",
        "fn main() {\n    let xy = 42;\n}\n",
        "",
        "fn new() {\n    // é\n}\n",
    ];
    for (revision, source) in versions.into_iter().enumerate() {
        let actual = cached
            .highlight("main.rs", source, revision as u32, None)
            .unwrap_or_else(|error| panic!("{error}"));
        let expected = SyntaxEngine::new()
            .highlight("main.rs", source, revision as u32, None)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(actual, expected, "revision {revision}");
        let tree = &cached.documents["main.rs"].tree;
        assert!(tree
            .as_ref()
            .is_some_and(|tree| tree.root_node().end_byte() == source.len()));
    }
}

#[test]
fn viewport_limits_output_and_rejects_split_surrogate() {
    let source = "const first = '😀';\n    const second = 42;\n";
    let byte = source.find("    const").unwrap_or(0);
    let from = source[..byte].encode_utf16().count() as u32;
    let to = source.encode_utf16().count() as u32;
    let mut engine = SyntaxEngine::new();
    let snapshot = engine
        .highlight("main.js", source, 2, Some(SyntaxRange { from, to }))
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(snapshot
        .highlights
        .iter()
        .all(|span| span.from >= from && span.to <= to));
    assert_eq!(
        snapshot.indent_guides,
        vec![IndentGuide {
            line: 1,
            columns: vec![4]
        }]
    );
    let emoji_start = source[..source.find('😀').unwrap_or(0)]
        .encode_utf16()
        .count() as u32;
    assert!(matches!(
        engine.highlight(
            "main.js",
            source,
            2,
            Some(SyntaxRange {
                from: emoji_start + 1,
                to
            })
        ),
        Err(SyntaxError::InvalidRange { .. })
    ));
    let empty = engine
        .highlight("main.js", source, 2, Some(SyntaxRange { from: 0, to: 0 }))
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(empty.highlights.is_empty());
}

#[test]
fn parse_edit_points_and_boundaries_handle_crlf_and_multibyte_prefixes() {
    let old = "a\r\né😀z\n";
    let new = "a\r\né🙂z\n";
    let edit = replacement_edit(old, new);
    assert_eq!(edit.start_byte, 5);
    assert_eq!(edit.start_position, Point::new(1, 2));
    assert_eq!(edit.old_end_byte, 9);
    assert_eq!(edit.new_end_byte, 9);
}

#[test]
fn large_and_unsupported_documents_have_explicit_behavior() {
    let mut engine = SyntaxEngine::new();
    assert!(matches!(
        engine.highlight("huge.rs", &"x".repeat(MAX_SOURCE_BYTES + 1), 0, None),
        Err(SyntaxError::SourceTooLarge { .. })
    ));
    let snapshot = analyze("README.txt", "some plain text");
    assert_eq!(snapshot.language, "text");
    assert!(snapshot.highlights.is_empty());
}

#[test]
fn cache_is_bounded_and_invalidates_closed_documents() {
    let mut engine = SyntaxEngine::new();
    for index in 0..MAX_CACHED_DOCUMENTS + 3 {
        engine
            .highlight(&format!("{index}.rs"), "fn main() {}", 0, None)
            .unwrap_or_else(|error| panic!("{error}"));
    }
    assert_eq!(engine.documents.len(), MAX_CACHED_DOCUMENTS);
    assert!(!engine.documents.contains_key("0.rs"));
    engine.invalidate("10.rs");
    assert!(!engine.documents.contains_key("10.rs"));
    engine.clear();
    assert!(engine.documents.is_empty());
}

#[test]
fn output_is_capped_for_dense_documents() {
    let source = "let item = 42;\n".repeat(MAX_HIGHLIGHTS / 4);
    let snapshot = analyze("dense.js", &source);
    assert!(snapshot.truncated);
    assert!(snapshot.highlights.len() <= MAX_HIGHLIGHTS);
    assert!(snapshot.indent_guides.len() <= MAX_GUIDE_LINES);
}
