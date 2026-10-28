//! Incremental Tree-sitter analysis with UTF-16 coordinates for the editor.
//!
//! Run `SyntaxEngine::highlight` on a blocking worker. Parsing has a time budget,
//! source size and output are bounded, and cached trees are edited before reuse.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::HashMap,
    ops::{ControlFlow, Range},
    path::Path,
    time::{Duration, Instant},
};
use tree_sitter::{
    InputEdit, Language, Node, ParseOptions, Parser, Point, Query, QueryCursor, QueryCursorOptions,
    StreamingIterator, Tree,
};

const MAX_SOURCE_BYTES: usize = 8 * 1024 * 1024;
const MAX_CACHED_DOCUMENTS: usize = 8;
const MAX_CACHE_BYTES: usize = 24 * 1024 * 1024;
const MAX_HIGHLIGHTS: usize = 20_000;
const MAX_FOLDS: usize = 5_000;
const MAX_GUIDE_LINES: usize = 10_000;
const MAX_VISITED_NODES: usize = 200_000;
const PARSE_BUDGET: Duration = Duration::from_millis(400);
const QUERY_BUDGET: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct SyntaxRange {
    pub from: u32,
    pub to: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct HighlightSpan {
    pub from: u32,
    pub to: u32,
    /// Tree-sitter capture name, for example `keyword` or `function.method`.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct FoldRange {
    pub from: u32,
    pub to: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct IndentGuide {
    /// Zero-based document line.
    pub line: u32,
    /// Visual columns, using a four-column tab stop.
    pub columns: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxSnapshot {
    pub revision: u32,
    pub language: String,
    pub highlights: Vec<HighlightSpan>,
    pub folds: Vec<FoldRange>,
    pub indent_guides: Vec<IndentGuide>,
    /// True when output limits or the query time budget were reached.
    pub truncated: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SyntaxError {
    #[error("syntax analysis for {path}: source exceeds the 8 MiB limit")]
    SourceTooLarge { path: String },
    #[error("syntax analysis for {path}: UTF-16 viewport range is invalid")]
    InvalidRange { path: String },
    #[error("syntax analysis for {path}: parser configuration failed: {message}")]
    Language { path: String, message: String },
    #[error("syntax analysis for {path}: highlight query failed: {message}")]
    Query { path: String, message: String },
    #[error("syntax analysis for {path}: parsing exceeded the time budget")]
    Cancelled { path: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum LanguageId {
    TypeScript,
    Tsx,
    JavaScript,
    Json,
    Markdown,
    Rust,
    Python,
    Java,
}

impl LanguageId {
    fn from_path(path: &str) -> Option<Self> {
        let extension = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
        match extension.as_str() {
            "ts" | "mts" | "cts" => Some(Self::TypeScript),
            "tsx" => Some(Self::Tsx),
            "js" | "jsx" | "mjs" | "cjs" => Some(Self::JavaScript),
            "json" => Some(Self::Json),
            "md" | "markdown" | "mdown" => Some(Self::Markdown),
            "rs" => Some(Self::Rust),
            "py" | "pyi" => Some(Self::Python),
            "java" | "jav" => Some(Self::Java),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::TypeScript | Self::Tsx => "typescript",
            Self::JavaScript => "javascript",
            Self::Json => "json",
            Self::Markdown => "markdown",
            Self::Rust => "rust",
            Self::Python => "python",
            Self::Java => "java",
        }
    }

    fn grammar(self) -> Language {
        match self {
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Self::Json => tree_sitter_json::LANGUAGE.into(),
            Self::Markdown => tree_sitter_md::LANGUAGE.into(),
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
            Self::Python => tree_sitter_python::LANGUAGE.into(),
            Self::Java => tree_sitter_java::LANGUAGE.into(),
        }
    }

    fn query_source(self) -> String {
        match self {
            Self::TypeScript => format!(
                "{}\n{}",
                tree_sitter_javascript::HIGHLIGHT_QUERY,
                tree_sitter_typescript::HIGHLIGHTS_QUERY
            ),
            Self::Tsx => format!(
                "{}\n{}\n{}",
                tree_sitter_javascript::HIGHLIGHT_QUERY,
                tree_sitter_javascript::JSX_HIGHLIGHT_QUERY,
                tree_sitter_typescript::HIGHLIGHTS_QUERY
            ),
            Self::JavaScript => format!(
                "{}\n{}",
                tree_sitter_javascript::HIGHLIGHT_QUERY,
                tree_sitter_javascript::JSX_HIGHLIGHT_QUERY
            ),
            Self::Json => tree_sitter_json::HIGHLIGHTS_QUERY.to_owned(),
            Self::Markdown => tree_sitter_md::HIGHLIGHT_QUERY_BLOCK.to_owned(),
            Self::Rust => tree_sitter_rust::HIGHLIGHTS_QUERY.to_owned(),
            Self::Python => tree_sitter_python::HIGHLIGHTS_QUERY.to_owned(),
            Self::Java => tree_sitter_java::HIGHLIGHTS_QUERY.to_owned(),
        }
    }
}

struct Document {
    language: LanguageId,
    parser: Parser,
    tree: Option<Tree>,
    text: String,
    used: u64,
}

/// Stateful parser cache. Serialize access on a blocking worker, never on the UI thread.
#[derive(Default)]
pub struct SyntaxEngine {
    documents: HashMap<String, Document>,
    queries: HashMap<LanguageId, Query>,
    markdown_inline_query: Option<Query>,
    clock: u64,
}

impl SyntaxEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn invalidate(&mut self, path: &str) {
        self.documents.remove(path);
    }

    pub fn clear(&mut self) {
        self.documents.clear();
    }

    /// Analyze a complete document and optionally return only the visible range.
    /// `range`, highlights and folds use UTF-16 code units, as CodeMirror does.
    /// Unsupported file extensions produce an empty plain-text syntax snapshot.
    pub fn highlight(
        &mut self,
        path: &str,
        text: &str,
        revision: u32,
        range: Option<SyntaxRange>,
    ) -> Result<SyntaxSnapshot, SyntaxError> {
        if text.len() > MAX_SOURCE_BYTES {
            self.invalidate(path);
            return Err(SyntaxError::SourceTooLarge {
                path: path.to_owned(),
            });
        }
        let offsets = Offsets::new(text);
        let visible = offsets
            .byte_range(range)
            .ok_or_else(|| SyntaxError::InvalidRange {
                path: path.to_owned(),
            })?;
        let Some(language) = LanguageId::from_path(path) else {
            self.invalidate(path);
            return Ok(SyntaxSnapshot {
                revision,
                language: "text".to_owned(),
                highlights: Vec::new(),
                folds: Vec::new(),
                indent_guides: Vec::new(),
                truncated: false,
            });
        };
        if let std::collections::hash_map::Entry::Vacant(entry) = self.queries.entry(language) {
            let query =
                Query::new(&language.grammar(), &language.query_source()).map_err(|error| {
                    SyntaxError::Query {
                        path: path.to_owned(),
                        message: error.to_string(),
                    }
                })?;
            entry.insert(query);
        }
        self.clock = self.clock.wrapping_add(1);
        let mut document = match self.documents.remove(path) {
            Some(document) if document.language == language => document,
            _ => {
                let mut parser = Parser::new();
                parser.set_language(&language.grammar()).map_err(|error| {
                    SyntaxError::Language {
                        path: path.to_owned(),
                        message: error.to_string(),
                    }
                })?;
                Document {
                    language,
                    parser,
                    tree: None,
                    text: String::new(),
                    used: self.clock,
                }
            }
        };
        if document.tree.is_none() || document.text != text {
            if let Some(tree) = document.tree.as_mut() {
                tree.edit(&replacement_edit(&document.text, text));
            }
            let started = Instant::now();
            let mut cancel = |_: &tree_sitter::ParseState| {
                if started.elapsed() >= PARSE_BUDGET {
                    ControlFlow::Break(())
                } else {
                    ControlFlow::Continue(())
                }
            };
            let bytes = text.as_bytes();
            let mut input = |offset: usize, _: Point| &bytes[offset.min(bytes.len())..];
            document.tree = document.parser.parse_with_options(
                &mut input,
                document.tree.as_ref(),
                Some(ParseOptions::new().progress_callback(&mut cancel)),
            );
            if document.tree.is_none() {
                // A cancelled parser can retain unfinished work. Discard it along
                // with the edited tree instead of resuming against different text.
                return Err(SyntaxError::Cancelled {
                    path: path.to_owned(),
                });
            }
            document.text = text.to_owned();
        }
        document.used = self.clock;
        let Some(tree) = document.tree.as_ref() else {
            return Err(SyntaxError::Cancelled {
                path: path.to_owned(),
            });
        };
        let Some(query) = self.queries.get(&language) else {
            return Err(SyntaxError::Query {
                path: path.to_owned(),
                message: "query cache unavailable".to_owned(),
            });
        };
        let mut snapshot = SyntaxSnapshot {
            revision,
            language: language.name().to_owned(),
            highlights: Vec::new(),
            folds: Vec::new(),
            indent_guides: Vec::new(),
            truncated: false,
        };
        collect_highlights(query, tree, text, &offsets, visible.clone(), &mut snapshot);
        collect_structure(
            tree.root_node(),
            text,
            &offsets,
            visible.clone(),
            &mut snapshot,
        );
        collect_guides(text, visible.clone(), &mut snapshot);
        if language == LanguageId::Markdown {
            self.markdown_inline(path, tree, text, &offsets, visible, &mut snapshot)?;
        }
        snapshot
            .highlights
            .sort_unstable_by(|a, b| (a.from, a.to, &a.kind).cmp(&(b.from, b.to, &b.kind)));
        snapshot.highlights.dedup();
        snapshot
            .folds
            .sort_unstable_by_key(|fold| (fold.from, fold.to));
        snapshot.folds.dedup();
        self.documents.insert(path.to_owned(), document);
        self.trim_cache();
        Ok(snapshot)
    }

    fn markdown_inline(
        &mut self,
        path: &str,
        block_tree: &Tree,
        text: &str,
        offsets: &Offsets,
        visible: Range<usize>,
        snapshot: &mut SyntaxSnapshot,
    ) -> Result<(), SyntaxError> {
        let language: Language = tree_sitter_md::INLINE_LANGUAGE.into();
        if self.markdown_inline_query.is_none() {
            self.markdown_inline_query = Some(
                Query::new(&language, tree_sitter_md::HIGHLIGHT_QUERY_INLINE).map_err(|error| {
                    SyntaxError::Query {
                        path: path.to_owned(),
                        message: error.to_string(),
                    }
                })?,
            );
        }
        // The inline grammar must see only inline nodes, excluding fenced code.
        let mut ranges = Vec::new();
        let mut cursor = block_tree.walk();
        let mut visited = 0;
        loop {
            let node = cursor.node();
            visited += 1;
            if visited > MAX_VISITED_NODES {
                snapshot.truncated = true;
                break;
            }
            if node.kind() == "inline"
                && node.end_byte() > visible.start
                && node.start_byte() < visible.end
            {
                ranges.push(node.range());
            } else if cursor.goto_first_child() {
                continue;
            }
            while !cursor.goto_next_sibling() {
                if !cursor.goto_parent() {
                    break;
                }
            }
            if cursor.node().id() == block_tree.root_node().id() {
                break;
            }
        }
        if ranges.is_empty() {
            return Ok(());
        }
        let mut parser = Parser::new();
        parser
            .set_language(&language)
            .map_err(|error| SyntaxError::Language {
                path: path.to_owned(),
                message: error.to_string(),
            })?;
        parser
            .set_included_ranges(&ranges)
            .map_err(|error| SyntaxError::Language {
                path: path.to_owned(),
                message: error.to_string(),
            })?;
        let started = Instant::now();
        let mut cancel = |_: &tree_sitter::ParseState| {
            if started.elapsed() >= PARSE_BUDGET {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        };
        let bytes = text.as_bytes();
        let mut input = |offset: usize, _: Point| &bytes[offset.min(bytes.len())..];
        if let (Some(tree), Some(query)) = (
            parser.parse_with_options(
                &mut input,
                None,
                Some(ParseOptions::new().progress_callback(&mut cancel)),
            ),
            self.markdown_inline_query.as_ref(),
        ) {
            collect_highlights(query, &tree, text, offsets, visible, snapshot);
        } else {
            snapshot.truncated = true;
        }
        Ok(())
    }

    fn trim_cache(&mut self) {
        while self.documents.len() > MAX_CACHED_DOCUMENTS
            || self
                .documents
                .values()
                .map(|entry| entry.text.len())
                .sum::<usize>()
                > MAX_CACHE_BYTES
        {
            let oldest = self
                .documents
                .iter()
                .min_by_key(|(_, entry)| entry.used)
                .map(|(path, _)| path.clone());
            if let Some(path) = oldest {
                self.documents.remove(&path);
            } else {
                break;
            }
        }
    }
}

fn collect_highlights(
    query: &Query,
    tree: &Tree,
    text: &str,
    offsets: &Offsets,
    visible: Range<usize>,
    snapshot: &mut SyntaxSnapshot,
) {
    if visible.is_empty() {
        return;
    }
    let mut cursor = QueryCursor::new();
    cursor.set_match_limit(512);
    cursor.set_byte_range(visible.clone());
    let started = Instant::now();
    let mut timed_out = false;
    let mut cancel = |_: &tree_sitter::QueryCursorState| {
        if started.elapsed() >= QUERY_BUDGET {
            timed_out = true;
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    };
    {
        let mut captures = cursor.captures_with_options(
            query,
            tree.root_node(),
            text.as_bytes(),
            QueryCursorOptions::new().progress_callback(&mut cancel),
        );
        while let Some((matched, index)) = captures.next() {
            if snapshot.highlights.len() >= MAX_HIGHLIGHTS {
                snapshot.truncated = true;
                break;
            }
            let capture = matched.captures()[*index];
            let from = capture.node.start_byte().max(visible.start);
            let to = capture.node.end_byte().min(visible.end);
            if from < to {
                let kind = query.capture_names()[capture.index as usize];
                snapshot.highlights.push(HighlightSpan {
                    from: offsets.utf16(from),
                    to: offsets.utf16(to),
                    kind: kind.to_owned(),
                });
            }
        }
    }
    snapshot.truncated |= timed_out || cursor.did_exceed_match_limit();
}

fn collect_structure(
    root: Node<'_>,
    text: &str,
    offsets: &Offsets,
    visible: Range<usize>,
    snapshot: &mut SyntaxSnapshot,
) {
    let mut cursor = root.walk();
    let mut visited = 0;
    let started = Instant::now();
    loop {
        let node = cursor.node();
        visited += 1;
        if visited > MAX_VISITED_NODES || started.elapsed() > QUERY_BUDGET {
            snapshot.truncated = true;
            break;
        }
        if node.end_byte() > visible.start && node.start_byte() < visible.end {
            let python_compound = matches!(
                node.kind(),
                "function_definition"
                    | "class_definition"
                    | "if_statement"
                    | "for_statement"
                    | "while_statement"
                    | "try_statement"
                    | "with_statement"
                    | "match_statement"
            ) && text[node.start_byte()..node.end_byte()]
                .split('\n')
                .next()
                .is_some_and(|line| line.trim_end().ends_with(':'));
            let indented_block =
                node.kind() == "block" && text.as_bytes().get(node.start_byte()) != Some(&b'{');
            if (foldable(node.kind()) || python_compound)
                && !indented_block
                && node.end_position().row > node.start_position().row
            {
                // Retain the opening line and closing delimiter when collapsed.
                let first_line_end = text[node.start_byte()..node.end_byte()]
                    .find('\n')
                    .map(|relative| node.start_byte() + relative);
                if let Some(from) = first_line_end {
                    let to = if matches!(
                        text.as_bytes().get(node.end_byte().saturating_sub(1)),
                        Some(b'}' | b']' | b')')
                    ) {
                        node.end_byte().saturating_sub(1)
                    } else {
                        node.end_byte()
                    };
                    if from < to && text.is_char_boundary(to) {
                        if snapshot.folds.len() >= MAX_FOLDS {
                            snapshot.truncated = true;
                            break;
                        }
                        snapshot.folds.push(FoldRange {
                            from: offsets.utf16(from),
                            to: offsets.utf16(to),
                        });
                    }
                }
            }
            if cursor.goto_first_child() {
                continue;
            }
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return;
            }
        }
    }
}

fn foldable(kind: &str) -> bool {
    matches!(
        kind,
        "block"
            | "statement_block"
            | "class_body"
            | "object"
            | "object_type"
            | "array"
            | "enum_body"
            | "declaration_list"
            | "field_declaration_list"
            | "match_block"
            | "arguments"
            | "parameters"
            | "formal_parameters"
            | "type_arguments"
            | "tuple"
            | "list"
            | "dictionary"
            | "set"
            | "string"
            | "string_literal"
            | "raw_string_literal"
            | "template_string"
            | "block_comment"
            | "comment"
            | "section"
            | "fenced_code_block"
            | "indented_code_block"
            | "list_item"
            | "block_quote"
    )
}

fn collect_guides(text: &str, visible: Range<usize>, snapshot: &mut SyntaxSnapshot) {
    let mut start = 0;
    for (line, content) in text.split_inclusive('\n').enumerate() {
        let end = start + content.len();
        if start >= visible.end {
            break;
        }
        if end > visible.start {
            if snapshot.indent_guides.len() >= MAX_GUIDE_LINES {
                snapshot.truncated = true;
                break;
            }
            let mut column = 0;
            for ch in content.chars() {
                match ch {
                    ' ' => column += 1,
                    '\t' => column += 4 - column % 4,
                    _ => break,
                }
            }
            // Avoid allocating pathological amounts for a single indented line.
            if column > 512 {
                snapshot.truncated = true;
            }
            let columns = (4..=column.min(512)).step_by(4).collect();
            snapshot.indent_guides.push(IndentGuide {
                line: line as u32,
                columns,
            });
        }
        start = end;
    }
}

/// Compact Unicode correction table. ASCII files allocate no per-byte mapping.
struct NonAscii {
    byte_start: usize,
    byte_end: usize,
    unit_start: u32,
    unit_end: u32,
}

struct Offsets {
    unicode: Vec<NonAscii>,
    bytes: usize,
    units: u32,
}

impl Offsets {
    fn new(text: &str) -> Self {
        let mut unicode = Vec::new();
        let mut units = 0;
        for (byte, ch) in text.char_indices() {
            let next = units + ch.len_utf16() as u32;
            if !ch.is_ascii() {
                unicode.push(NonAscii {
                    byte_start: byte,
                    byte_end: byte + ch.len_utf8(),
                    unit_start: units,
                    unit_end: next,
                });
            }
            units = next;
        }
        Self {
            unicode,
            bytes: text.len(),
            units,
        }
    }

    fn utf16(&self, byte: usize) -> u32 {
        let index = self.unicode.partition_point(|ch| ch.byte_end <= byte);
        let correction = index
            .checked_sub(1)
            .map(|previous| {
                self.unicode[previous].byte_end as u32 - self.unicode[previous].unit_end
            })
            .unwrap_or(0);
        byte as u32 - correction
    }

    fn byte_range(&self, range: Option<SyntaxRange>) -> Option<Range<usize>> {
        let Some(range) = range else {
            return Some(0..self.bytes);
        };
        if range.from > range.to || range.to > self.units {
            return None;
        }
        Some(self.byte(range.from)?..self.byte(range.to)?)
    }

    fn byte(&self, unit: u32) -> Option<usize> {
        if unit > self.units {
            return None;
        }
        let index = self.unicode.partition_point(|ch| ch.unit_end <= unit);
        let correction = index
            .checked_sub(1)
            .map(|previous| {
                self.unicode[previous].byte_end as u32 - self.unicode[previous].unit_end
            })
            .unwrap_or(0);
        if let Some(next) = self.unicode.get(index) {
            if unit > next.unit_start {
                return None;
            }
            if unit == next.unit_start {
                return Some(next.byte_start);
            }
        }
        Some(unit as usize + correction as usize)
    }
}

fn replacement_edit(old: &str, new: &str) -> InputEdit {
    let mut start = old
        .bytes()
        .zip(new.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(start) || !new.is_char_boundary(start) {
        start -= 1;
    }
    let mut suffix = old[start..]
        .bytes()
        .rev()
        .zip(new[start..].bytes().rev())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(old.len() - suffix) || !new.is_char_boundary(new.len() - suffix) {
        suffix -= 1;
    }
    let old_end = old.len() - suffix;
    let new_end = new.len() - suffix;
    InputEdit {
        start_byte: start,
        old_end_byte: old_end,
        new_end_byte: new_end,
        start_position: point(old, start),
        old_end_position: point(old, old_end),
        new_end_position: point(new, new_end),
    }
}

fn point(text: &str, byte: usize) -> Point {
    let prefix = &text[..byte];
    let row = prefix.bytes().filter(|byte| *byte == b'\n').count();
    let column = prefix
        .rfind('\n')
        .map_or(byte, |newline| byte - newline - 1);
    Point::new(row, column)
}

#[cfg(test)]
mod tests;
