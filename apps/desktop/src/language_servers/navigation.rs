//! IPC types and protocol mapping for code navigation: references, symbols, call and
//! type hierarchy, highlights, signature help, rename, and read-only source previews.
//!
//! All positions and ranges are UTF-16 (the encoding negotiated with every server).
//! Locations inside the workspace are workspace relative; everything else, including
//! `jdt://` class files and files under `node_modules`, is flagged `external` and is only
//! ever read, never opened as a buffer or sent to a server with `didOpen`.

use super::dto::{self, display_path, LanguageServerId, LocationDto, LspErrorDto, RangeDto};
use super::dto::{PositionDto, TextEditDto};
use super::paths;
use base64::Engine;
use serde::{Deserialize, Serialize};
use span_lsp::lsp_types::{self as lsp, OneOf};
use span_lsp::servers::ServerId;
use specta::Type;
use std::path::{Component, Path, PathBuf};

/// Largest file (or class file source) `lsp_read_source` will read.
pub const MAX_SOURCE_BYTES: u64 = 1024 * 1024;
/// Largest `context_lines` honoured on each side of the range.
pub const MAX_CONTEXT_LINES: u32 = 400;
/// Hard cap on the lines of one snippet, whatever the range spans.
pub const MAX_SNIPPET_LINES: usize = 1200;
/// Merged workspace symbol results are cut to this many.
pub const MAX_WORKSPACE_SYMBOLS: usize = 200;
/// Document symbol trees are cut to this many nodes.
pub const MAX_DOCUMENT_SYMBOLS: usize = 5000;
/// Reference lists are cut to this many.
pub const MAX_REFERENCES: usize = 5000;
const MAX_TOKEN_BYTES: usize = 256 * 1024;
const MAX_URI_BYTES: usize = 4096;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/// Mirrors LSP `SymbolKind` (File = 1 ... TypeParameter = 26).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SymbolKindDto {
    File,
    Module,
    Namespace,
    Package,
    Class,
    Method,
    Property,
    Field,
    Constructor,
    Enum,
    Interface,
    Function,
    Variable,
    Constant,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Key,
    Null,
    EnumMember,
    Struct,
    Event,
    Operator,
    TypeParameter,
}

impl SymbolKindDto {
    pub fn from_number(n: u64) -> Self {
        use SymbolKindDto::*;
        match n {
            1 => File,
            2 => Module,
            3 => Namespace,
            4 => Package,
            5 => Class,
            6 => Method,
            7 => Property,
            8 => Field,
            9 => Constructor,
            10 => Enum,
            11 => Interface,
            12 => Function,
            13 => Variable,
            14 => Constant,
            15 => String,
            16 => Number,
            17 => Boolean,
            18 => Array,
            19 => Object,
            20 => Key,
            21 => Null,
            22 => EnumMember,
            23 => Struct,
            24 => Event,
            25 => Operator,
            26 => TypeParameter,
            _ => Variable,
        }
    }
}

impl From<lsp::SymbolKind> for SymbolKindDto {
    fn from(kind: lsp::SymbolKind) -> Self {
        let n = serde_json::to_value(kind)
            .ok()
            .and_then(|v| v.as_u64())
            .unwrap_or(13);
        Self::from_number(n)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SymbolDto {
    pub name: String,
    pub kind: SymbolKindDto,
    pub detail: Option<String>,
    pub range: RangeDto,
    pub selection_range: RangeDto,
    pub children: Vec<SymbolDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSymbolDto {
    pub name: String,
    pub kind: SymbolKindDto,
    pub container_name: Option<String>,
    pub location: LocationDto,
}

/// A call hierarchy item. `token` is opaque: it carries the server item (including its
/// private `data`) and which server and root produced it, and goes back unchanged into
/// `lsp_call_hierarchy_incoming` and `lsp_call_hierarchy_outgoing`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallHierarchyItemDto {
    pub name: String,
    pub kind: SymbolKindDto,
    pub detail: Option<String>,
    pub location: LocationDto,
    pub selection_range: RangeDto,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IncomingCallDto {
    pub from: CallHierarchyItemDto,
    pub from_ranges: Vec<RangeDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingCallDto {
    pub to: CallHierarchyItemDto,
    pub from_ranges: Vec<RangeDto>,
}

/// Same shape as [`CallHierarchyItemDto`], for `lsp_type_hierarchy_*`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TypeHierarchyItemDto {
    pub name: String,
    pub kind: SymbolKindDto,
    pub detail: Option<String>,
    pub location: LocationDto,
    pub selection_range: RangeDto,
    pub token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DocumentHighlightKindDto {
    Text,
    Read,
    Write,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocumentHighlightDto {
    pub range: RangeDto,
    pub kind: DocumentHighlightKindDto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ParameterInformationDto {
    pub label: String,
    /// UTF-16 offsets of the parameter inside the signature label, when known.
    pub label_start: Option<u32>,
    pub label_end: Option<u32>,
    pub documentation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SignatureInformationDto {
    pub label: String,
    pub documentation: Option<String>,
    pub parameters: Vec<ParameterInformationDto>,
    pub active_parameter: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SignatureHelpDto {
    pub signatures: Vec<SignatureInformationDto>,
    pub active_signature: Option<u32>,
    pub active_parameter: Option<u32>,
}

/// Result of `lsp_prepare_rename`. `range` is `None` when the server uses its default
/// identifier behaviour (the UI then selects the word under the cursor).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrepareRenameDto {
    pub range: Option<RangeDto>,
    pub placeholder: Option<String>,
    pub default_behavior: bool,
}

/// Edits of one file, in UTF-16 positions of the file as the server saw it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileEditsDto {
    /// Workspace relative, or absolute / server URI when `external`.
    pub path: String,
    /// The file is outside the workspace or a library file: the UI must not apply it.
    pub external: bool,
    pub edits: Vec<TextEditDto>,
}

/// A rename result. Nothing is applied here: the UI applies it through the buffer edit
/// path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEditDto {
    pub files: Vec<FileEditsDto>,
    /// File create, rename and delete operations the server sent anyway. Span declares
    /// no resource operation support and never performs them.
    pub skipped_operations: u32,
}

/// A read-only excerpt of a source file, for peek and hover previews.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SourceSnippetDto {
    pub path: String,
    pub display_path: String,
    pub language: String,
    /// Zero based line number of the first line of `text`.
    pub start_line: u32,
    pub text: String,
    /// The requested range, in line numbers of the whole file (subtract `start_line`).
    pub highlight_range: RangeDto,
    pub external: bool,
    pub read_only: bool,
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

const LIBRARY_DIRS: [&str; 3] = ["node_modules", "site-packages", ".venv"];

fn is_library_path(relative: &str) -> bool {
    relative
        .split(['/', '\\'])
        .any(|part| LIBRARY_DIRS.contains(&part))
}

/// `jdt://contents/java.base/java.lang/String.class?=...` shown as
/// `java.base/java.lang/String.class`. For a Maven or Gradle jar the jar file name leads the
/// path (`x.jar/javafx.fxml/FXMLLoader.java`) and is dropped here, the UI shows it as secondary text.
/// The query holds encoded project information and is never shown. Display only: the URI itself
/// is passed to the server untouched.
fn nice_uri(uri: &str) -> String {
    let rest = uri.split_once("://").map(|(_, r)| r).unwrap_or(uri);
    let rest = rest.strip_prefix("contents/").unwrap_or(rest);
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    match rest.split_once('/') {
        Some((first, tail))
            if !tail.is_empty()
                && (first.ends_with(".jar")
                    || first.ends_with(".jmod")
                    || first.ends_with(".zip")) =>
        {
            tail.to_owned()
        }
        _ => rest.to_owned(),
    }
}

/// Map a protocol URI and range to a location. Never drops a location: a URI that is not a
/// readable file path (`jdt:`, `jar:`, ...) is kept verbatim and marked external.
pub fn locate(root: &Path, uri: &str, range: lsp::Range) -> LocationDto {
    let range: RangeDto = range.into();
    if let Ok(url) = tauri::Url::parse(uri) {
        if url.scheme() == "file" {
            if let Ok(path) = url.to_file_path() {
                let shown = display_path(root, &path);
                let inside =
                    paths::is_inside_text(&root.to_string_lossy(), &path.to_string_lossy());
                let external = !inside || is_library_path(&shown);
                return LocationDto {
                    display_path: shown.clone(),
                    path: shown,
                    range,
                    external,
                };
            }
        }
    }
    LocationDto {
        path: uri.to_owned(),
        display_path: nice_uri(uri),
        range,
        external: true,
    }
}

pub fn map_locations(root: &Path, locations: Option<Vec<lsp::Location>>) -> Vec<LocationDto> {
    locations
        .unwrap_or_default()
        .into_iter()
        .take(MAX_REFERENCES)
        .map(|l| locate(root, l.uri.as_str(), l.range))
        .collect()
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

fn nested_symbol(symbol: lsp::DocumentSymbol, budget: &mut usize) -> Option<SymbolDto> {
    if *budget == 0 {
        return None;
    }
    *budget -= 1;
    let children = symbol
        .children
        .unwrap_or_default()
        .into_iter()
        .filter_map(|c| nested_symbol(c, budget))
        .collect();
    Some(SymbolDto {
        name: symbol.name,
        kind: symbol.kind.into(),
        detail: symbol.detail,
        range: symbol.range.into(),
        selection_range: symbol.selection_range.into(),
        children,
    })
}

/// Hierarchical `DocumentSymbol[]` and flat `SymbolInformation[]` both become a tree
/// (flat input yields a list of leaves).
pub fn map_document_symbols(response: Option<lsp::DocumentSymbolResponse>) -> Vec<SymbolDto> {
    let mut budget = MAX_DOCUMENT_SYMBOLS;
    match response {
        None => Vec::new(),
        Some(lsp::DocumentSymbolResponse::Nested(symbols)) => symbols
            .into_iter()
            .filter_map(|s| nested_symbol(s, &mut budget))
            .collect(),
        Some(lsp::DocumentSymbolResponse::Flat(symbols)) => symbols
            .into_iter()
            .take(MAX_DOCUMENT_SYMBOLS)
            .map(|s| SymbolDto {
                name: s.name,
                kind: s.kind.into(),
                detail: s.container_name,
                range: s.location.range.into(),
                selection_range: s.location.range.into(),
                children: Vec::new(),
            })
            .collect(),
    }
}

pub fn map_workspace_symbols(
    root: &Path,
    response: Option<lsp::WorkspaceSymbolResponse>,
) -> Vec<WorkspaceSymbolDto> {
    match response {
        None => Vec::new(),
        Some(lsp::WorkspaceSymbolResponse::Flat(symbols)) => symbols
            .into_iter()
            .map(|s| WorkspaceSymbolDto {
                name: s.name,
                kind: s.kind.into(),
                container_name: s.container_name,
                location: locate(root, s.location.uri.as_str(), s.location.range),
            })
            .collect(),
        Some(lsp::WorkspaceSymbolResponse::Nested(symbols)) => symbols
            .into_iter()
            .map(|s| {
                let location = match s.location {
                    OneOf::Left(l) => locate(root, l.uri.as_str(), l.range),
                    // Lazy location: only the file is known until the server resolves it.
                    OneOf::Right(l) => locate(root, l.uri.as_str(), lsp::Range::default()),
                };
                WorkspaceSymbolDto {
                    name: s.name,
                    kind: s.kind.into(),
                    container_name: s.container_name,
                    location,
                }
            })
            .collect(),
    }
}

/// Interleave per-server lists so one noisy server cannot crowd out the rest, then cap.
pub fn merge_workspace_symbols(lists: Vec<Vec<WorkspaceSymbolDto>>) -> Vec<WorkspaceSymbolDto> {
    let mut iters: Vec<_> = lists.into_iter().map(|l| l.into_iter()).collect();
    let mut merged = Vec::new();
    'outer: loop {
        let mut any = false;
        for it in iters.iter_mut() {
            if let Some(next) = it.next() {
                any = true;
                merged.push(next);
                if merged.len() >= MAX_WORKSPACE_SYMBOLS {
                    break 'outer;
                }
            }
        }
        if !any {
            break;
        }
    }
    merged
}

// ---------------------------------------------------------------------------
// Hierarchy items and their opaque tokens
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct TokenPayload {
    kind: String,
    server: LanguageServerId,
    root: String,
    item: serde_json::Value,
}

pub const CALL_KIND: &str = "call";
pub const TYPE_KIND: &str = "type";

fn encode_token(kind: &str, server: ServerId, root: &Path, item: serde_json::Value) -> String {
    let payload = TokenPayload {
        kind: kind.to_owned(),
        server: server.into(),
        root: root.to_string_lossy().into_owned(),
        item,
    };
    let bytes = serde_json::to_vec(&payload).unwrap_or_default();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Where a hierarchy item came from and the raw server item.
pub struct DecodedToken {
    pub server: ServerId,
    pub root: PathBuf,
    pub item: serde_json::Value,
}

pub fn decode_token(token: &str, kind: &str) -> Result<DecodedToken, LspErrorDto> {
    let bad = || LspErrorDto::other("invalid hierarchy item token");
    if token.len() > MAX_TOKEN_BYTES {
        return Err(bad());
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token)
        .map_err(|_| bad())?;
    let payload: TokenPayload = serde_json::from_slice(&bytes).map_err(|_| bad())?;
    if payload.kind != kind {
        return Err(bad());
    }
    Ok(DecodedToken {
        server: payload.server.into(),
        root: PathBuf::from(payload.root),
        item: payload.item,
    })
}

pub fn map_call_item(
    workspace: &Path,
    server: ServerId,
    root: &Path,
    item: lsp::CallHierarchyItem,
) -> CallHierarchyItemDto {
    let raw = serde_json::to_value(&item).unwrap_or(serde_json::Value::Null);
    CallHierarchyItemDto {
        name: item.name,
        kind: item.kind.into(),
        detail: item.detail,
        location: locate(workspace, item.uri.as_str(), item.range),
        selection_range: item.selection_range.into(),
        token: encode_token(CALL_KIND, server, root, raw),
    }
}

pub fn map_type_item(
    workspace: &Path,
    server: ServerId,
    root: &Path,
    item: lsp::TypeHierarchyItem,
) -> TypeHierarchyItemDto {
    let raw = serde_json::to_value(&item).unwrap_or(serde_json::Value::Null);
    TypeHierarchyItemDto {
        name: item.name,
        kind: item.kind.into(),
        detail: item.detail,
        location: locate(workspace, item.uri.as_str(), item.range),
        selection_range: item.selection_range.into(),
        token: encode_token(TYPE_KIND, server, root, raw),
    }
}

pub fn map_incoming(
    workspace: &Path,
    server: ServerId,
    root: &Path,
    calls: Option<Vec<lsp::CallHierarchyIncomingCall>>,
) -> Vec<IncomingCallDto> {
    calls
        .unwrap_or_default()
        .into_iter()
        .map(|c| IncomingCallDto {
            from: map_call_item(workspace, server, root, c.from),
            from_ranges: c.from_ranges.into_iter().map(Into::into).collect(),
        })
        .collect()
}

pub fn map_outgoing(
    workspace: &Path,
    server: ServerId,
    root: &Path,
    calls: Option<Vec<lsp::CallHierarchyOutgoingCall>>,
) -> Vec<OutgoingCallDto> {
    calls
        .unwrap_or_default()
        .into_iter()
        .map(|c| OutgoingCallDto {
            to: map_call_item(workspace, server, root, c.to),
            from_ranges: c.from_ranges.into_iter().map(Into::into).collect(),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Highlights, signature help, rename
// ---------------------------------------------------------------------------

pub fn map_highlights(
    highlights: Option<Vec<lsp::DocumentHighlight>>,
) -> Vec<DocumentHighlightDto> {
    highlights
        .unwrap_or_default()
        .into_iter()
        .map(|h| DocumentHighlightDto {
            range: h.range.into(),
            kind: match h.kind {
                Some(k) if k == lsp::DocumentHighlightKind::READ => DocumentHighlightKindDto::Read,
                Some(k) if k == lsp::DocumentHighlightKind::WRITE => {
                    DocumentHighlightKindDto::Write
                }
                _ => DocumentHighlightKindDto::Text,
            },
        })
        .collect()
}

fn documentation(doc: Option<lsp::Documentation>) -> Option<String> {
    let text = match doc? {
        lsp::Documentation::String(s) => s,
        lsp::Documentation::MarkupContent(m) => m.value,
    };
    (!text.trim().is_empty()).then_some(text)
}

/// The UTF-16 slice `[start, end)` of `text`.
pub fn utf16_slice(text: &str, start: u32, end: u32) -> Option<String> {
    let mut out = String::new();
    let mut at = 0u32;
    for ch in text.chars() {
        let next = at + ch.len_utf16() as u32;
        if at >= start && next <= end {
            out.push(ch);
        }
        at = next;
    }
    (start <= end && end <= at).then_some(out)
}

fn utf16_offset_of(text: &str, needle: &str) -> Option<(u32, u32)> {
    let byte = text.find(needle)?;
    let start = text[..byte].encode_utf16().count() as u32;
    Some((start, start + needle.encode_utf16().count() as u32))
}

fn map_parameter(signature: &str, p: lsp::ParameterInformation) -> ParameterInformationDto {
    let (label, offsets) = match p.label {
        lsp::ParameterLabel::LabelOffsets([start, end]) => (
            utf16_slice(signature, start, end).unwrap_or_default(),
            Some((start, end)),
        ),
        lsp::ParameterLabel::Simple(text) => {
            let offsets = utf16_offset_of(signature, &text);
            (text, offsets)
        }
    };
    ParameterInformationDto {
        label,
        label_start: offsets.map(|o| o.0),
        label_end: offsets.map(|o| o.1),
        documentation: documentation(p.documentation),
    }
}

pub fn map_signature_help(help: Option<lsp::SignatureHelp>) -> Option<SignatureHelpDto> {
    let help = help?;
    if help.signatures.is_empty() {
        return None;
    }
    Some(SignatureHelpDto {
        signatures: help
            .signatures
            .into_iter()
            .map(|s| SignatureInformationDto {
                parameters: s
                    .parameters
                    .unwrap_or_default()
                    .into_iter()
                    .map(|p| map_parameter(&s.label, p))
                    .collect(),
                documentation: documentation(s.documentation),
                active_parameter: s.active_parameter,
                label: s.label,
            })
            .collect(),
        active_signature: help.active_signature,
        active_parameter: help.active_parameter,
    })
}

pub fn map_prepare_rename(
    response: Option<lsp::PrepareRenameResponse>,
) -> Option<PrepareRenameDto> {
    Some(match response? {
        lsp::PrepareRenameResponse::Range(range) => PrepareRenameDto {
            range: Some(range.into()),
            placeholder: None,
            default_behavior: false,
        },
        lsp::PrepareRenameResponse::RangeWithPlaceholder { range, placeholder } => {
            PrepareRenameDto {
                range: Some(range.into()),
                placeholder: Some(placeholder),
                default_behavior: false,
            }
        }
        lsp::PrepareRenameResponse::DefaultBehavior { .. } => PrepareRenameDto {
            range: None,
            placeholder: None,
            default_behavior: true,
        },
    })
}

/// A `WorkspaceEdit` as per file edit lists. Both `changes` and `documentChanges` are
/// understood; resource operations are counted, not mapped.
pub fn map_workspace_edit(root: &Path, edit: Option<lsp::WorkspaceEdit>) -> WorkspaceEditDto {
    let mut files: Vec<(String, bool, Vec<lsp::TextEdit>)> = Vec::new();
    let mut skipped = 0u32;
    let mut add = |uri: &str, edits: Vec<lsp::TextEdit>| {
        let loc = locate(root, uri, lsp::Range::default());
        match files.iter_mut().find(|f| f.0 == loc.path) {
            Some(file) => file.2.extend(edits),
            None => files.push((loc.path, loc.external, edits)),
        }
    };
    if let Some(edit) = edit {
        for (uri, edits) in edit.changes.unwrap_or_default() {
            add(uri.as_str(), edits);
        }
        let mut document_edit = |e: lsp::TextDocumentEdit| {
            let edits = e
                .edits
                .into_iter()
                .map(|e| match e {
                    OneOf::Left(edit) => edit,
                    OneOf::Right(annotated) => annotated.text_edit,
                })
                .collect();
            add(e.text_document.uri.as_str(), edits);
        };
        match edit.document_changes {
            None => {}
            Some(lsp::DocumentChanges::Edits(edits)) => {
                edits.into_iter().for_each(&mut document_edit)
            }
            Some(lsp::DocumentChanges::Operations(ops)) => {
                for op in ops {
                    match op {
                        lsp::DocumentChangeOperation::Edit(e) => document_edit(e),
                        lsp::DocumentChangeOperation::Op(_) => skipped += 1,
                    }
                }
            }
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    WorkspaceEditDto {
        files: files
            .into_iter()
            .map(|(path, external, edits)| FileEditsDto {
                path,
                external,
                edits: dto::map_edits(Some(edits)),
            })
            .collect(),
        skipped_operations: skipped,
    }
}

// ---------------------------------------------------------------------------
// Source previews
// ---------------------------------------------------------------------------

/// What a `LocationDto` resolved to after validation.
#[derive(Debug, PartialEq, Eq)]
pub enum ResolvedSource {
    /// A regular file. `external` is also true for library files inside the workspace.
    File { path: PathBuf, external: bool },
    /// A `jdt:` class file URI, read through JDT LS.
    Jdt(String),
}

const EXTERNAL_EXTENSIONS: [&str; 41] = [
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc", "rs", "py", "pyi",
    "java", "kt", "scala", "c", "h", "cc", "cpp", "hpp", "cs", "go", "rb", "php", "swift", "html",
    "htm", "css", "scss", "less", "md", "txt", "toml", "yaml", "yml", "xml", "gradle", "vue",
    "svelte", "lock",
];
const DENIED_DIRS: [&str; 6] = [".ssh", ".gnupg", ".aws", ".kube", ".docker", ".git"];

fn external_allowed(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    let known = ext
        .as_deref()
        .is_some_and(|e| EXTERNAL_EXTENSIONS.contains(&e));
    let denied = path.components().any(|c| match c {
        Component::Normal(n) => n
            .to_str()
            .is_some_and(|n| DENIED_DIRS.contains(&n.to_ascii_lowercase().as_str())),
        _ => false,
    });
    known && !denied
}

fn refuse(message: impl Into<String>) -> LspErrorDto {
    LspErrorDto::other(message)
}

/// Validate the location a preview was asked for. Pure path logic plus `canonicalize`;
/// nothing is read here.
///
/// * A location not marked `external` must resolve inside the workspace (after resolving
///   `..` and symlinks), otherwise it is refused.
/// * An `external` file must be absolute (or already inside the workspace), a known
///   source file type, and outside credential directories.
/// * `jdt:` URIs are handed back for JDT LS; every other URI scheme is refused.
pub fn resolve_source(
    workspace: &Path,
    location: &LocationDto,
) -> Result<ResolvedSource, LspErrorDto> {
    let raw = location.path.as_str();
    if raw.is_empty() || raw.len() > MAX_URI_BYTES || raw.contains('\0') {
        return Err(refuse("invalid source path"));
    }
    let mut candidate = PathBuf::from(raw);
    if let Some((scheme, _)) = raw.split_once("://") {
        match scheme {
            "jdt" => return Ok(ResolvedSource::Jdt(raw.to_owned())),
            "file" => {
                candidate = tauri::Url::parse(raw)
                    .ok()
                    .and_then(|u| u.to_file_path().ok())
                    .ok_or_else(|| refuse("invalid file URI"))?;
            }
            other => return Err(refuse(format!("unsupported source scheme {other:?}"))),
        }
    }
    let was_absolute = candidate.is_absolute();
    let joined = if was_absolute {
        paths::normalize_path(&candidate)
    } else {
        paths::join_normalized(workspace, &candidate.to_string_lossy())
    };
    let canonical = joined
        .canonicalize()
        .map_err(|_| refuse("source file not found"))?;
    let canonical_workspace = workspace
        .canonicalize()
        .map_err(|_| refuse("workspace not found"))?;
    let inside = canonical.starts_with(&canonical_workspace);
    let library = inside
        && is_library_path(
            &canonical
                .strip_prefix(&canonical_workspace)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
        );
    if inside {
        return Ok(ResolvedSource::File {
            path: canonical,
            external: library || location.external,
        });
    }
    if !location.external {
        return Err(refuse("path is outside the workspace"));
    }
    if !was_absolute {
        return Err(refuse("external sources need an absolute path"));
    }
    if !external_allowed(&canonical) {
        return Err(refuse(
            "this file type cannot be previewed outside the workspace",
        ));
    }
    Ok(ResolvedSource::File {
        path: canonical,
        external: true,
    })
}

/// Read a regular text file of at most [`MAX_SOURCE_BYTES`]. Refuses directories,
/// oversize files, binary data and invalid UTF-8.
pub fn read_text_file(path: &Path) -> Result<String, LspErrorDto> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|_| refuse("source file cannot be opened"))?;
    let meta = file
        .metadata()
        .map_err(|_| refuse("source file cannot be inspected"))?;
    if !meta.is_file() {
        return Err(refuse("not a regular file"));
    }
    if meta.len() > MAX_SOURCE_BYTES {
        return Err(refuse("source file is larger than 1 MiB"));
    }
    // The size can change between the check and the read: bound the read itself.
    let mut bytes = Vec::new();
    file.take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| refuse("source file cannot be read"))?;
    check_text(bytes)
}

/// Text from bytes: no NUL, valid UTF-8, within the size cap.
pub fn check_text(bytes: Vec<u8>) -> Result<String, LspErrorDto> {
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err(refuse("source is larger than 1 MiB"));
    }
    if bytes.contains(&0) {
        return Err(refuse("not a text file"));
    }
    String::from_utf8(bytes).map_err(|_| refuse("not a UTF-8 text file"))
}

/// `(start_line, text, highlight)` for `range` with `context` lines on each side. The
/// context is clamped to [`MAX_CONTEXT_LINES`] and the snippet to [`MAX_SNIPPET_LINES`].
pub fn snippet(
    text: &str,
    range: RangeDto,
    context: u32,
) -> Result<(u32, String, RangeDto), LspErrorDto> {
    let lines: Vec<&str> = text.split('\n').collect();
    let total = lines.len() as u32;
    if range.start.line >= total || range.end.line < range.start.line {
        return Err(refuse("range is outside the file"));
    }
    let context = context.min(MAX_CONTEXT_LINES);
    let first = range.start.line.saturating_sub(context);
    let last = range
        .end
        .line
        .saturating_add(context)
        .min(total - 1)
        .min(first.saturating_add(MAX_SNIPPET_LINES as u32 - 1));
    let body = lines[first as usize..=last as usize]
        .iter()
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect::<Vec<_>>()
        .join("\n");
    let highlight = RangeDto {
        start: PositionDto {
            line: range.start.line,
            character: range.start.character,
        },
        end: PositionDto {
            line: range.end.line.min(last),
            character: if range.end.line > last {
                0
            } else {
                range.end.character
            },
        },
    };
    Ok((first, body, highlight))
}

#[cfg(test)]
mod tests;
