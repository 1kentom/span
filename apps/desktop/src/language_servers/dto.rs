//! IPC types for the language server service. Small own types, mapped from `lsp_types`,
//! so the generated bindings stay stable and independent of the protocol crate.

use serde::{Deserialize, Serialize};
use span_lsp::lsp_types::{
    self as lsp, CompletionResponse, DiagnosticSeverity, GotoDefinitionResponse, HoverContents,
    InsertTextFormat, MarkedString, NumberOrString,
};
use span_lsp::servers::manager::{ManagerError, ServerState};
use span_lsp::servers::ServerId;
use specta::Type;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum LanguageServerId {
    Vtsls,
    Html,
    Css,
    Json,
    RustAnalyzer,
    Basedpyright,
    Jdtls,
}

impl From<ServerId> for LanguageServerId {
    fn from(id: ServerId) -> Self {
        match id {
            ServerId::Vtsls => Self::Vtsls,
            ServerId::Html => Self::Html,
            ServerId::Css => Self::Css,
            ServerId::Json => Self::Json,
            ServerId::RustAnalyzer => Self::RustAnalyzer,
            ServerId::Basedpyright => Self::Basedpyright,
            ServerId::Jdtls => Self::Jdtls,
        }
    }
}

impl From<LanguageServerId> for ServerId {
    fn from(id: LanguageServerId) -> Self {
        match id {
            LanguageServerId::Vtsls => Self::Vtsls,
            LanguageServerId::Html => Self::Html,
            LanguageServerId::Css => Self::Css,
            LanguageServerId::Json => Self::Json,
            LanguageServerId::RustAnalyzer => Self::RustAnalyzer,
            LanguageServerId::Basedpyright => Self::Basedpyright,
            LanguageServerId::Jdtls => Self::Jdtls,
        }
    }
}

/// Settings key of a server (`languageServers.enabled`).
pub fn settings_key(id: ServerId) -> &'static str {
    match id {
        ServerId::Vtsls => "vtsls",
        ServerId::Html => "html",
        ServerId::Css => "css",
        ServerId::Json => "json",
        ServerId::RustAnalyzer => "rust-analyzer",
        ServerId::Basedpyright => "basedpyright",
        ServerId::Jdtls => "jdtls",
    }
}

/// UTF-16 based LSP position (`character` counts UTF-16 code units, like CodeMirror).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PositionDto {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RangeDto {
    pub start: PositionDto,
    pub end: PositionDto,
}

impl From<lsp::Position> for PositionDto {
    fn from(p: lsp::Position) -> Self {
        Self {
            line: p.line,
            character: p.character,
        }
    }
}

impl From<PositionDto> for lsp::Position {
    fn from(p: PositionDto) -> Self {
        Self::new(p.line, p.character)
    }
}

impl From<lsp::Range> for RangeDto {
    fn from(r: lsp::Range) -> Self {
        Self {
            start: r.start.into(),
            end: r.end.into(),
        }
    }
}

impl From<RangeDto> for lsp::Range {
    fn from(r: RangeDto) -> Self {
        Self::new(r.start.into(), r.end.into())
    }
}

/// A replacement of `range` (positions in the document the response is stamped with).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextEditDto {
    pub range: RangeDto,
    pub new_text: String,
}

impl From<lsp::TextEdit> for TextEditDto {
    fn from(e: lsp::TextEdit) -> Self {
        Self {
            range: e.range.into(),
            new_text: e.new_text,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum InsertTextFormatDto {
    PlainText,
    Snippet,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CompletionItemDto {
    pub label: String,
    /// LSP `CompletionItemKind` number (1 Text ... 25 TypeParameter).
    pub kind: Option<u32>,
    pub detail: Option<String>,
    /// Text to insert when no `text_edit` is given (falls back to the label).
    pub insert_text: String,
    pub insert_text_format: InsertTextFormatDto,
    pub text_edit: Option<TextEditDto>,
    pub sort_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CompletionListDto {
    pub is_incomplete: bool,
    pub items: Vec<CompletionItemDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HoverDto {
    pub markdown: String,
    pub range: Option<RangeDto>,
}

/// `path` is workspace relative with forward slashes when inside the workspace,
/// otherwise the absolute path (or the server URI, for `jdt:` class files). `external`
/// marks everything outside the workspace and library files inside it (`node_modules`):
/// those are read only and never become buffers. `display_path` is what to show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocationDto {
    pub path: String,
    pub range: RangeDto,
    pub external: bool,
    pub display_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticSeverityDto {
    Error,
    Warning,
    Information,
    Hint,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticDto {
    pub severity: Option<DiagnosticSeverityDto>,
    pub message: String,
    pub range: RangeDto,
    pub source: Option<String>,
    pub code: Option<String>,
}

/// What a ready server advertised, as reported by `lsp_status`. A request the server did
/// not advertise answers `Unsupported` without reaching it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesDto {
    pub completion: bool,
    pub hover: bool,
    pub definition: bool,
    pub formatting: bool,
    pub range_formatting: bool,
    pub rename: bool,
    /// `renameProvider.prepareProvider`.
    pub prepare_rename: bool,
    pub references: bool,
    pub implementation: bool,
    pub type_definition: bool,
    pub declaration: bool,
    pub document_symbol: bool,
    pub workspace_symbol: bool,
    pub call_hierarchy: bool,
    /// Not part of `lsp_types::ServerCapabilities`: filled from the raw `initialize`
    /// result by the service (always false from `From<&ServerCapabilities>`).
    pub type_hierarchy: bool,
    pub document_highlight: bool,
    pub signature_help: bool,
}

fn provider<T>(value: &Option<lsp::OneOf<bool, T>>) -> bool {
    match value {
        None | Some(lsp::OneOf::Left(false)) => false,
        Some(_) => true,
    }
}

impl From<&lsp::ServerCapabilities> for CapabilitiesDto {
    fn from(c: &lsp::ServerCapabilities) -> Self {
        Self {
            completion: c.completion_provider.is_some(),
            hover: match &c.hover_provider {
                None | Some(lsp::HoverProviderCapability::Simple(false)) => false,
                Some(_) => true,
            },
            definition: provider(&c.definition_provider),
            formatting: provider(&c.document_formatting_provider),
            range_formatting: provider(&c.document_range_formatting_provider),
            rename: provider(&c.rename_provider),
            prepare_rename: matches!(
                &c.rename_provider,
                Some(lsp::OneOf::Right(lsp::RenameOptions {
                    prepare_provider: Some(true),
                    ..
                }))
            ),
            references: provider(&c.references_provider),
            implementation: !matches!(
                &c.implementation_provider,
                None | Some(lsp::ImplementationProviderCapability::Simple(false))
            ),
            type_definition: !matches!(
                &c.type_definition_provider,
                None | Some(lsp::TypeDefinitionProviderCapability::Simple(false))
            ),
            declaration: !matches!(
                &c.declaration_provider,
                None | Some(lsp::DeclarationCapability::Simple(false))
            ),
            document_symbol: provider(&c.document_symbol_provider),
            workspace_symbol: provider(&c.workspace_symbol_provider),
            call_hierarchy: !matches!(
                &c.call_hierarchy_provider,
                None | Some(lsp::CallHierarchyServerCapability::Simple(false))
            ),
            type_hierarchy: false,
            document_highlight: provider(&c.document_highlight_provider),
            signature_help: c.signature_help_provider.is_some(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LanguageServerStateDto {
    NotStarted,
    Starting,
    Ready,
    Crashed,
    Stopped,
    Disabled,
    Installing,
    /// Nothing is downloaded until `lsp_install` is called (or auto install is on).
    #[serde(rename_all = "camelCase")]
    NeedsInstall {
        version: String,
        size_hint: Option<u64>,
    },
    /// Retry with `lsp_install`.
    #[serde(rename_all = "camelCase")]
    InstallFailed {
        reason: String,
        retryable: bool,
    },
    /// Process start or `initialize` failed. Retry with `lsp_restart`.
    #[serde(rename_all = "camelCase")]
    StartFailed {
        reason: String,
    },
    /// Node.js or a JDK is missing or too old. Fix the host or the override setting,
    /// then `lsp_restart`.
    #[serde(rename_all = "camelCase")]
    RuntimeMissing {
        runtime: String,
        required_version: u32,
        found: Vec<String>,
    },
}

impl From<&ServerState> for LanguageServerStateDto {
    fn from(state: &ServerState) -> Self {
        match state {
            ServerState::Starting => Self::Starting,
            ServerState::Ready => Self::Ready,
            ServerState::Failed(reason) => Self::StartFailed {
                reason: reason.clone(),
            },
            ServerState::Crashed => Self::Crashed,
            ServerState::Stopped => Self::Stopped,
        }
    }
}

/// Typed errors of every `lsp_*` command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LspErrorDto {
    NotReady {
        message: String,
    },
    Unsupported {
        message: String,
    },
    #[serde(rename_all = "camelCase")]
    NeedsInstall {
        server: LanguageServerId,
        version: String,
        size_hint: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    InstallFailed {
        server: LanguageServerId,
        reason: String,
        retryable: bool,
    },
    #[serde(rename_all = "camelCase")]
    StartFailed {
        server: LanguageServerId,
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    RuntimeMissing {
        server: LanguageServerId,
        runtime: String,
        required_version: u32,
        found: Vec<String>,
    },
    ServerCrashed {
        message: String,
    },
    Cancelled,
    /// The document changed, closed, or the server restarted or the workspace changed
    /// before the reply arrived. The reply was dropped.
    Stale,
    Other {
        message: String,
    },
}

impl LspErrorDto {
    pub fn other(message: impl Into<String>) -> Self {
        Self::Other {
            message: message.into(),
        }
    }
}

impl From<ManagerError> for LspErrorDto {
    fn from(error: ManagerError) -> Self {
        match error {
            ManagerError::NotStarted => Self::NotReady {
                message: "language server is not running".into(),
            },
            ManagerError::NotReady(state) => Self::NotReady {
                message: format!("language server is not ready: {state:?}"),
            },
            ManagerError::Unsupported(what) => Self::Unsupported {
                message: format!("language server does not support {what}"),
            },
            ManagerError::ServerCrashed(message) => Self::ServerCrashed { message },
            ManagerError::Cancelled => Self::Cancelled,
            other => Self::Other {
                message: other.to_string(),
            },
        }
    }
}

/// Every `lsp_*` reply is stamped with what it was computed against.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LspResponse<T> {
    /// Buffer revision of the document the reply refers to.
    pub revision: u64,
    /// Server epoch (incremented on every restart of that server).
    pub epoch: u64,
    pub data: T,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatusDto {
    pub server: LanguageServerId,
    pub root: Option<String>,
    pub state: LanguageServerStateDto,
    pub installed: bool,
    pub enabled: bool,
    pub version: String,
    pub epoch: u64,
    /// Only known while the server is ready.
    pub capabilities: Option<CapabilitiesDto>,
    /// Human name, e.g. "Java (Eclipse JDT LS)".
    pub display_name: String,
    /// Human language names the server covers.
    pub languages: Vec<String>,
    /// Size of the installed files on disk, when installed.
    pub installed_size_bytes: Option<u64>,
    /// The runtime the server needs (Node.js or a JDK), with what was found.
    pub runtime: Option<super::intel::RuntimeDto>,
    /// Plain-language sentence for failed states.
    pub failure_reason: Option<String>,
    /// The technical error behind `failure_reason`.
    pub failure_details: Option<String>,
    /// Per-workspace trust for servers that execute project build code.
    pub trust: super::intel::TrustDto,
    /// Work the server reports it is doing (indexing, importing), for late subscribers.
    pub activity: Vec<super::intel::ActivityDto>,
    /// Overall progress while this server is installing.
    pub install: Option<super::intel::InstallStatusDto>,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum InstallPhase {
    Started,
    AlreadyInstalled,
    WaitingForLock,
    Downloading,
    Reused,
    Verifying,
    Extracting,
    Finalizing,
    Finished,
    Failed,
    /// The user cancelled; the server is back to needing an install.
    Cancelled,
}

// ---------------------------------------------------------------------------
// Mapping from protocol results
// ---------------------------------------------------------------------------

pub fn map_completion(response: Option<CompletionResponse>) -> CompletionListDto {
    let (is_incomplete, items) = match response {
        None => (false, Vec::new()),
        Some(CompletionResponse::Array(items)) => (false, items),
        Some(CompletionResponse::List(list)) => (list.is_incomplete, list.items),
    };
    CompletionListDto {
        is_incomplete,
        items: items.into_iter().map(map_completion_item).collect(),
    }
}

fn number(value: &impl Serialize) -> Option<u32> {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())
}

pub fn map_completion_item(item: lsp::CompletionItem) -> CompletionItemDto {
    let text_edit = item.text_edit.map(|edit| match edit {
        lsp::CompletionTextEdit::Edit(edit) => edit.into(),
        // Insert mode: replace only the text before the cursor.
        lsp::CompletionTextEdit::InsertAndReplace(edit) => TextEditDto {
            range: edit.insert.into(),
            new_text: edit.new_text,
        },
    });
    CompletionItemDto {
        insert_text: item.insert_text.unwrap_or_else(|| item.label.clone()),
        insert_text_format: if item.insert_text_format == Some(InsertTextFormat::SNIPPET) {
            InsertTextFormatDto::Snippet
        } else {
            InsertTextFormatDto::PlainText
        },
        kind: item.kind.as_ref().and_then(number),
        detail: item.detail,
        label: item.label,
        text_edit,
        sort_text: item.sort_text,
    }
}

fn marked(value: MarkedString) -> String {
    match value {
        MarkedString::String(text) => text,
        MarkedString::LanguageString(code) => {
            format!("```{}\n{}\n```", code.language, code.value)
        }
    }
}

pub fn map_hover(hover: Option<lsp::Hover>) -> Option<HoverDto> {
    let hover = hover?;
    let markdown = match hover.contents {
        HoverContents::Scalar(value) => marked(value),
        HoverContents::Array(values) => values
            .into_iter()
            .map(marked)
            .collect::<Vec<_>>()
            .join("\n\n"),
        HoverContents::Markup(markup) => match markup.kind {
            lsp::MarkupKind::Markdown => markup.value,
            // Plain text must not be interpreted as markdown.
            lsp::MarkupKind::PlainText => format!("```text\n{}\n```", markup.value),
        },
    };
    if markdown.trim().is_empty() {
        return None;
    }
    Some(HoverDto {
        markdown,
        range: hover.range.map(Into::into),
    })
}

/// Workspace relative path (forward slashes) inside `root`, else the absolute path.
pub fn display_path(root: &Path, path: &Path) -> String {
    super::paths::display_path_text(&root.to_string_lossy(), &path.to_string_lossy())
}

fn location(root: &Path, uri: &lsp::Uri, range: lsp::Range) -> Option<LocationDto> {
    Some(super::navigation::locate(root, uri.as_str(), range))
}

pub fn map_definition(root: &Path, response: Option<GotoDefinitionResponse>) -> Vec<LocationDto> {
    match response {
        None => Vec::new(),
        Some(GotoDefinitionResponse::Scalar(l)) => {
            location(root, &l.uri, l.range).into_iter().collect()
        }
        Some(GotoDefinitionResponse::Array(list)) => list
            .into_iter()
            .filter_map(|l| location(root, &l.uri, l.range))
            .collect(),
        Some(GotoDefinitionResponse::Link(links)) => links
            .into_iter()
            .filter_map(|l| location(root, &l.target_uri, l.target_selection_range))
            .collect(),
    }
}

pub fn map_diagnostic(d: lsp::Diagnostic) -> DiagnosticDto {
    let severity = d.severity.map(|s| {
        if s == DiagnosticSeverity::ERROR {
            DiagnosticSeverityDto::Error
        } else if s == DiagnosticSeverity::WARNING {
            DiagnosticSeverityDto::Warning
        } else if s == DiagnosticSeverity::INFORMATION {
            DiagnosticSeverityDto::Information
        } else {
            DiagnosticSeverityDto::Hint
        }
    });
    DiagnosticDto {
        severity,
        message: d.message,
        range: d.range.into(),
        source: d.source,
        code: d.code.map(|c| match c {
            NumberOrString::Number(n) => n.to_string(),
            NumberOrString::String(s) => s,
        }),
    }
}

/// Edits sorted by start, as the UI applies them against one document version.
pub fn map_edits(edits: Option<Vec<lsp::TextEdit>>) -> Vec<TextEditDto> {
    let mut edits: Vec<TextEditDto> = edits
        .unwrap_or_default()
        .into_iter()
        .map(Into::into)
        .collect();
    edits.sort_by_key(|e| (e.range.start.line, e.range.start.character));
    edits
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn from<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> T {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn completion_array_and_list_map_to_dtos() {
        let list: CompletionResponse = from(json!({
            "isIncomplete": true,
            "items": [
                {"label": "foo", "kind": 3, "detail": "fn foo()", "sortText": "0",
                 "insertTextFormat": 2, "insertText": "foo($1)",
                 "textEdit": {"range": {"start": {"line": 1, "character": 2},
                                        "end": {"line": 1, "character": 4}}, "newText": "foo($1)"}},
                {"label": "bar"},
                {"label": "baz", "textEdit": {"newText": "baz",
                    "insert": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 1}},
                    "replace": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 5}}}}
            ]
        }));
        let dto = map_completion(Some(list));
        assert!(dto.is_incomplete);
        assert_eq!(dto.items.len(), 3);
        let foo = &dto.items[0];
        assert_eq!(foo.kind, Some(3));
        assert_eq!(foo.insert_text_format, InsertTextFormatDto::Snippet);
        assert_eq!(foo.insert_text, "foo($1)");
        assert_eq!(foo.text_edit.as_ref().unwrap().range.end.character, 4);
        assert_eq!(foo.sort_text.as_deref(), Some("0"));
        let bar = &dto.items[1];
        assert_eq!(bar.insert_text, "bar", "label is the fallback insert text");
        assert_eq!(bar.insert_text_format, InsertTextFormatDto::PlainText);
        assert!(bar.text_edit.is_none());
        let baz = &dto.items[2];
        assert_eq!(baz.text_edit.as_ref().unwrap().range.end.character, 1);

        let array: CompletionResponse = from(json!([{"label": "x"}]));
        assert!(!map_completion(Some(array)).is_incomplete);
        assert!(map_completion(None).items.is_empty());
    }

    #[test]
    fn hover_contents_become_markdown() {
        let markup = map_hover(Some(from(
            json!({"contents": {"kind": "markdown", "value": "**hi**"}}),
        )));
        assert_eq!(markup.unwrap().markdown, "**hi**");
        let plain = map_hover(Some(from(
            json!({"contents": {"kind": "plaintext", "value": "a *b*"}}),
        )));
        assert_eq!(plain.unwrap().markdown, "```text\na *b*\n```");
        let legacy = map_hover(Some(from(json!({"contents": [
            "text", {"language": "rust", "value": "fn x()"}]}))));
        assert_eq!(legacy.unwrap().markdown, "text\n\n```rust\nfn x()\n```");
        assert!(map_hover(Some(from(json!({"contents": "  "})))).is_none());
        assert!(map_hover(None).is_none());
    }

    #[test]
    fn definition_paths_are_workspace_relative() {
        let root = std::env::temp_dir().join("span-dto-root");
        let inside = tauri::Url::from_file_path(root.join("src/a b.rs")).unwrap();
        let outside =
            tauri::Url::from_file_path(std::env::temp_dir().join("elsewhere/c.rs")).unwrap();
        let range =
            json!({"start": {"line": 1, "character": 2}, "end": {"line": 1, "character": 5}});
        let response: GotoDefinitionResponse = from(json!([
            {"uri": inside.as_str(), "range": range},
            {"uri": outside.as_str(), "range": range},
        ]));
        let locations = map_definition(&root, Some(response));
        assert_eq!(locations[0].path, "src/a b.rs");
        assert_eq!(locations[0].range.start.line, 1);
        assert!(locations[1].path.ends_with("elsewhere/c.rs"));
        assert!(std::path::Path::new(&locations[1].path).is_absolute());
        assert!(map_definition(&root, None).is_empty());
    }

    #[test]
    fn diagnostics_and_edits_map() {
        let d: lsp::Diagnostic = from(json!({
            "range": {"start": {"line": 0, "character": 1}, "end": {"line": 0, "character": 3}},
            "severity": 2, "code": 7, "source": "ts", "message": "careful"}));
        let dto = map_diagnostic(d);
        assert_eq!(dto.severity, Some(DiagnosticSeverityDto::Warning));
        assert_eq!(dto.code.as_deref(), Some("7"));
        assert_eq!(dto.source.as_deref(), Some("ts"));
        let d: lsp::Diagnostic = from(json!({
            "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 0}},
            "code": "E1", "message": "m"}));
        let dto = map_diagnostic(d);
        assert_eq!(dto.severity, None);
        assert_eq!(dto.code.as_deref(), Some("E1"));

        let edits: Vec<lsp::TextEdit> = from(json!([
            {"range": {"start": {"line": 3, "character": 0}, "end": {"line": 3, "character": 1}}, "newText": "b"},
            {"range": {"start": {"line": 1, "character": 4}, "end": {"line": 1, "character": 4}}, "newText": "a"},
        ]));
        let mapped = map_edits(Some(edits));
        assert_eq!(mapped[0].new_text, "a");
        assert_eq!(mapped[1].range.start.line, 3);
    }

    #[test]
    fn manager_errors_map_to_typed_errors() {
        assert_eq!(
            LspErrorDto::from(ManagerError::Cancelled),
            LspErrorDto::Cancelled
        );
        assert!(matches!(
            LspErrorDto::from(ManagerError::ServerCrashed("x".into())),
            LspErrorDto::ServerCrashed { .. }
        ));
        assert!(matches!(
            LspErrorDto::from(ManagerError::Unsupported("hover".into())),
            LspErrorDto::Unsupported { .. }
        ));
        assert!(matches!(
            LspErrorDto::from(ManagerError::NotReady(ServerState::Starting)),
            LspErrorDto::NotReady { .. }
        ));
    }

    #[test]
    fn capabilities_reflect_advertised_providers() {
        let caps: lsp::ServerCapabilities = from(json!({
            "completionProvider": {}, "hoverProvider": true, "definitionProvider": false,
            "documentFormattingProvider": {"workDoneProgress": false},
            "renameProvider": true}));
        let dto = CapabilitiesDto::from(&caps);
        assert!(dto.completion && dto.hover && dto.formatting && dto.rename);
        assert!(!dto.definition && !dto.range_formatting && !dto.references);
    }
}
