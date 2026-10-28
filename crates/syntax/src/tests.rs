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

const JAVA_SAMPLE: &str = "package demo;\n\n/** Docs. */\n@Deprecated\npublic class Größe {\n    // note\n    private int zähler = 42;\n    String name = \"Span 😀\";\n\n    public void run() {\n        System.out.println(name);\n        return;\n    }\n}\n";

fn java_kinds(source: &str, needle: &str) -> Vec<String> {
    let snapshot = analyze("Main.java", source);
    let byte = source.find(needle).unwrap_or(usize::MAX);
    assert_ne!(byte, usize::MAX, "{needle} missing");
    let from = source[..byte].encode_utf16().count() as u32;
    let to = from + needle.encode_utf16().count() as u32;
    snapshot
        .highlights
        .iter()
        .filter(|span| span.from < to && span.to > from)
        .map(|span| span.kind.clone())
        .collect()
}

#[test]
fn java_is_detected_and_reports_its_language_name() {
    for path in ["Main.java", "Main.JAVA", "Old.jav"] {
        assert_eq!(analyze(path, "class A {}\n").language, "java", "{path}");
    }
}

#[test]
fn java_highlights_cover_the_main_token_classes() {
    let has = |needle: &str, capture: &str| {
        let kinds = java_kinds(JAVA_SAMPLE, needle);
        assert!(
            kinds.iter().any(|kind| kind.contains(capture)),
            "{needle} expected {capture}, got {kinds:?}"
        );
    };
    has("class", "keyword");
    has("public", "keyword");
    has("return", "controlKeyword");
    has("Deprecated", "annotation");
    has("\"Span", "string");
    has("42", "number");
    has("// note", "comment");
    has("/** Docs. */", "docComment");
    has("println", "method");
    has("int", "type");
}

#[test]
fn java_unicode_identifiers_and_emoji_keep_utf16_offsets() {
    let source = JAVA_SAMPLE;
    let snapshot = analyze("Main.java", source);
    let units = source.encode_utf16().count() as u32;
    assert!(snapshot
        .highlights
        .iter()
        .all(|span| span.from < span.to && span.to <= units));
    let byte = source.find("42").unwrap_or(0);
    let from = source[..byte].encode_utf16().count() as u32;
    assert!(snapshot
        .highlights
        .iter()
        .any(|span| span.from == from && span.to == from + 2 && span.kind.contains("number")));
    assert!(!snapshot.folds.is_empty());
}

#[test]
fn java_incremental_edits_match_a_fresh_parse() {
    let mut cached = SyntaxEngine::new();
    let versions = [
        JAVA_SAMPLE.to_owned(),
        JAVA_SAMPLE.replace("42", "4200").replace("Größe", "Grösse"),
        JAVA_SAMPLE
            .replace("\"Span 😀\"", "\"日本\"")
            .replace("// note", "/* é */"),
        String::new(),
        "class B { void f() { g(1); } }\n".to_owned(),
    ];
    for (revision, source) in versions.iter().enumerate() {
        let actual = cached
            .highlight("Main.java", source, revision as u32, None)
            .unwrap_or_else(|error| panic!("{error}"));
        let expected = SyntaxEngine::new()
            .highlight("Main.java", source, revision as u32, None)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(actual, expected, "revision {revision}");
    }
}

/// Asserts that every span touching the `nth` whole-word occurrence of `needle`
/// has `kind`, ignoring spans that strictly contain it (the editor paints the
/// innermost span last, so a container never changes the visible colour).
#[track_caller]
fn expect_token(path: &str, source: &str, needle: &str, nth: usize, kind: &str) {
    let snapshot = analyze(path, source);
    let word = |byte: usize| {
        let ident = |c: char| c.is_alphanumeric() || c == '_';
        let before = source[..byte].chars().next_back();
        let after = source[byte + needle.len()..].chars().next();
        !(needle.starts_with(ident) && before.is_some_and(ident))
            && !(needle.ends_with(ident) && after.is_some_and(ident))
    };
    let byte = source
        .match_indices(needle)
        .filter(|(byte, _)| word(*byte))
        .nth(nth)
        .map(|(byte, _)| byte)
        .unwrap_or_else(|| panic!("{needle} #{nth} missing"));
    let from = source[..byte].encode_utf16().count() as u32;
    let to = from + needle.encode_utf16().count() as u32;
    let touching: Vec<(u32, u32, &str)> = snapshot
        .highlights
        .iter()
        .filter(|span| span.from < to && span.to > from)
        .map(|span| (span.from, span.to, span.kind.as_str()))
        .collect();
    let contains =
        |span: &&(u32, u32, &str)| span.0 <= from && span.1 >= to && (span.0 < from || span.1 > to);
    let inner: Vec<_> = touching
        .iter()
        .filter(|span| !contains(span))
        .copied()
        .collect();
    let kinds = if inner.is_empty() { touching } else { inner };
    assert!(
        !kinds.is_empty() && kinds.iter().all(|(_, _, found)| *found == kind),
        "{path}: {needle} #{nth} expected {kind}, got {kinds:?}"
    );
}

const JAVA_FX: &str = r#"package com.example.app;

import javafx.fxml.FXML;
import javafx.scene.control.ButtonType;
import static java.lang.Math.PI;
import java.util.*;

/** Controller docs. */
public class MainController implements Initializable {
    private static final int MAX_ITEMS = 10;
    @FXML
    private ListView<String> items;

    @SuppressWarnings("unchecked")
    public <T extends Comparable<T>> T pick(List<T> values, int index) {
        values.forEach(value -> System.out.println(value));
        Runnable r = this::refresh;
        String block = """
            text
            """;
        return values.get(index);
    }

    interface Handler {}
    enum Mode { FAST }
}
"#;

#[test]
fn java_imports_distinguish_package_path_class_and_keyword() {
    let p = "Main.java";
    let s = JAVA_FX;
    expect_token(p, s, "import", 0, "keyword");
    expect_token(p, s, "package", 0, "keyword");
    expect_token(p, s, "com.example.app", 0, "namespace");
    expect_token(p, s, "javafx.fxml", 0, "importPath");
    expect_token(p, s, "FXML", 0, "class");
    expect_token(p, s, "javafx.scene.control", 0, "importPath");
    expect_token(p, s, "ButtonType", 0, "class");
    expect_token(p, s, "static", 0, "keyword");
    expect_token(p, s, "java.lang", 0, "importPath");
    expect_token(p, s, "Math", 0, "class");
    expect_token(p, s, "PI", 0, "constant");
    expect_token(p, s, "java.util", 0, "importPath");
}

#[test]
fn java_declarations_members_and_literals_use_distinct_tokens() {
    let p = "Main.java";
    let s = JAVA_FX;
    expect_token(p, s, "@FXML", 0, "annotation");
    expect_token(p, s, "@SuppressWarnings", 0, "annotation");
    expect_token(p, s, "/** Controller docs. */", 0, "docComment");
    expect_token(p, s, "MainController", 0, "class");
    expect_token(p, s, "Initializable", 0, "interface");
    expect_token(p, s, "MAX_ITEMS", 0, "constant");
    expect_token(p, s, "int", 0, "type");
    expect_token(p, s, "10", 0, "number");
    expect_token(p, s, "ListView", 0, "class");
    expect_token(p, s, "items", 0, "property");
    expect_token(p, s, "T", 0, "typeParameter");
    expect_token(p, s, "pick", 0, "method");
    expect_token(p, s, "values", 0, "parameter");
    expect_token(p, s, "value", 0, "parameter");
    expect_token(p, s, "->", 0, "operator");
    expect_token(p, s, "System", 0, "class");
    expect_token(p, s, "println", 0, "method");
    expect_token(p, s, "::", 0, "operator");
    expect_token(p, s, "refresh", 0, "method");
    expect_token(p, s, "this", 0, "keyword");
    expect_token(p, s, "return", 0, "controlKeyword");
    expect_token(p, s, "Handler", 0, "interface");
    expect_token(p, s, "Mode", 0, "enum");
    expect_token(p, s, "FAST", 0, "constant");
    expect_token(p, s, "\"unchecked\"", 0, "string");
    expect_token(p, s, "text", 0, "string");
}

const TS_SAMPLE: &str = r#"import React, { useState } from "react";
import * as path from "node:path";
export { bar } from "./bar";

@Component({ selector: "x" })
export class Service<T> extends Base implements Handler {
  name: string = "a";
  run(count: number): Promise<T> { return this.load(count); }
}
interface Handler { id: number }
enum Mode { Fast, Slow }
namespace Util {}
const MAX = 3;
const view = <Panel title="x"><div className="a" /></Panel>;
const tpl = `hi ${name}`;
"#;

#[test]
fn typescript_samples_distinguish_modules_types_and_decorators() {
    let p = "main.tsx";
    let s = TS_SAMPLE;
    expect_token(p, s, "import", 0, "keyword");
    expect_token(p, s, "\"react\"", 0, "importPath");
    expect_token(p, s, "\"./bar\"", 0, "importPath");
    expect_token(p, s, "path", 0, "namespace");
    expect_token(p, s, "@Component", 0, "annotation");
    expect_token(p, s, "Service", 0, "class");
    expect_token(p, s, "Base", 0, "class");
    expect_token(p, s, "Handler", 0, "interface");
    expect_token(p, s, "Handler", 1, "interface");
    expect_token(p, s, "Mode", 0, "enum");
    expect_token(p, s, "Fast", 0, "constant");
    expect_token(p, s, "Util", 0, "namespace");
    expect_token(p, s, "T", 0, "typeParameter");
    expect_token(p, s, "string", 0, "type");
    expect_token(p, s, "count", 0, "parameter");
    expect_token(p, s, "run", 0, "method");
    expect_token(p, s, "name", 0, "property");
    expect_token(p, s, "MAX", 0, "constant");
    expect_token(p, s, "Panel", 0, "class");
    expect_token(p, s, "div", 0, "tag");
    expect_token(p, s, "className", 0, "attribute");
    expect_token(p, s, "return", 0, "controlKeyword");
    expect_token(p, s, "`hi ", 0, "string");
}

const RUST_SAMPLE: &str = r#"use std::collections::HashMap;
use std::{fmt, io::Read};

#[derive(Debug)]
pub struct Config<'a, T> { name: &'a str, value: T }
pub trait Handler { fn handle(&self, input: u32) -> bool; }
enum Mode { Fast }
const LIMIT: usize = 4;
impl Handler for Config<'_, u8> {
    fn handle(&self, input: u32) -> bool { println!("x"); input > 1 }
}
fn main() { let map: HashMap<String, i32> = HashMap::new(); }
"#;

#[test]
fn rust_samples_distinguish_use_paths_traits_macros_and_lifetimes() {
    let p = "main.rs";
    let s = RUST_SAMPLE;
    expect_token(p, s, "use", 0, "keyword");
    expect_token(p, s, "std::collections", 0, "importPath");
    expect_token(p, s, "HashMap", 0, "class");
    expect_token(p, s, "fmt", 0, "importPath");
    expect_token(p, s, "Read", 0, "class");
    expect_token(p, s, "#[derive(Debug)]", 0, "annotation");
    expect_token(p, s, "'a", 0, "label");
    expect_token(p, s, "Config", 0, "class");
    expect_token(p, s, "T", 0, "typeParameter");
    expect_token(p, s, "Handler", 0, "interface");
    expect_token(p, s, "Handler", 1, "interface");
    expect_token(p, s, "Mode", 0, "enum");
    expect_token(p, s, "Fast", 0, "constant");
    expect_token(p, s, "LIMIT", 0, "constant");
    expect_token(p, s, "usize", 0, "type");
    expect_token(p, s, "println!", 0, "macro");
    expect_token(p, s, "input", 0, "parameter");
    expect_token(p, s, "handle", 0, "method");
    expect_token(p, s, "main", 0, "function");
    expect_token(p, s, "name", 0, "property");
}

const PYTHON_SAMPLE: &str = r#"import os.path
from collections.abc import Mapping as M
from . import sibling

@dataclass(frozen=True)
class Config(Base):
    """Doc string."""
    LIMIT = 3

    def run(self, count: int = 1) -> None:
        print(f"{count}")
        return self.value.strip()
"#;

#[test]
fn python_samples_distinguish_modules_decorators_and_classes() {
    let p = "main.py";
    let s = PYTHON_SAMPLE;
    expect_token(p, s, "import", 0, "keyword");
    expect_token(p, s, "os.path", 0, "importPath");
    expect_token(p, s, "collections.abc", 0, "importPath");
    expect_token(p, s, "Mapping", 0, "class");
    expect_token(p, s, "@dataclass", 0, "annotation");
    expect_token(p, s, "Config", 0, "class");
    expect_token(p, s, "Base", 0, "class");
    expect_token(p, s, "\"\"\"Doc string.\"\"\"", 0, "docComment");
    expect_token(p, s, "LIMIT", 0, "constant");
    expect_token(p, s, "run", 0, "method");
    expect_token(p, s, "self", 0, "keyword");
    expect_token(p, s, "count", 0, "parameter");
    expect_token(p, s, "print", 0, "function");
    expect_token(p, s, "strip", 0, "method");
    expect_token(p, s, "return", 0, "controlKeyword");
}

#[test]
fn json_keys_and_values_use_property_string_boolean_and_constant() {
    let s = "{\n  \"name\": \"Span\",\n  \"on\": true,\n  \"n\": null,\n  \"c\": 3 // x\n}\n";
    expect_token("a.json", s, "\"name\"", 0, "property");
    expect_token("a.json", s, "\"Span\"", 0, "string");
    expect_token("a.jsonc", s, "true", 0, "boolean");
    expect_token("a.json", s, "null", 0, "constant");
    expect_token("a.json", s, "3", 0, "number");
    expect_token("a.jsonc", s, "// x", 0, "comment");
}

#[test]
fn every_capture_in_every_query_maps_to_a_token() {
    let samples = [
        ("a.ts", "let x = 1;"),
        ("a.tsx", "let x = 1;"),
        ("a.js", "let x = 1;"),
        ("a.json", "{}"),
        ("a.rs", "fn main() {}"),
        ("a.py", "x = 1"),
        ("a.java", "class A {}"),
    ];
    let mut engine = SyntaxEngine::new();
    for (path, source) in samples {
        engine
            .highlight(path, source, 0, None)
            .unwrap_or_else(|error| panic!("{path}: {error}"));
    }
    assert_eq!(engine.queries.len(), 7, "one query per language id");
    for (language, compiled) in &engine.queries {
        for name in compiled.query.capture_names() {
            let (base, _) = tokens::split_cover(name);
            assert!(
                tokens::capture_token(base).is_some() || tokens::IGNORED_CAPTURES.contains(&base),
                "{language:?}: capture @{name} has no token mapping"
            );
        }
    }
}

#[test]
fn later_patterns_win_and_cover_captures_replace_inner_spans() {
    let spans = |source: &str| analyze("Main.java", source).highlights;
    let source = "import a.b.C;\n";
    let found = spans(source);
    assert!(found
        .iter()
        .any(|s| s.from == 7 && s.to == 10 && s.kind == "importPath"));
    assert!(
        !found
            .iter()
            .any(|s| s.from >= 7 && s.to <= 10 && s.kind != "importPath"),
        "{found:?}"
    );
    let mut sorted = found.clone();
    sorted.sort_by_key(|s| (s.from, s.to));
    sorted.dedup_by_key(|s| (s.from, s.to));
    assert_eq!(sorted.len(), found.len(), "one span per range: {found:?}");
}
