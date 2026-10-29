//! The editor's authoritative text and workspace services.
//! UI undo/redo owns history and submits inverse edits through `edit_buffer`.
mod attachment;
mod buffer;
mod format;
mod format_native;
mod fs_ops;
mod git;
mod images;
mod java_run;
mod proposal_diff;
mod recent;
mod run_config;
mod run_detection;
mod search;
mod session;
mod session_meta;
mod settings;
mod tools;
mod transcript_export;
mod uploads;
pub mod version;
mod workspace;

pub use attachment::{SavedAttachment, MAX_ATTACHMENT_BYTES};
pub use buffer::{BufferRevision, BufferSnapshot, EditProposal, ProposalHunk, TextEdit};
pub use format::{
    native_program_path, resolve_program, run_formatter, run_formatter_cancellable, FormatRequest,
    FormatResult,
};
pub use git::{
    GitChange, GitCommit, GitCommitResult, GitContext, GitDiff, GitDiffSide, GitHistoryPage,
    GitHistoryQuery, GitRepository, GitService, GitStatus,
};
pub use images::RasterImage;
pub use recent::{RecentProject, RecentProjectStore};
pub use run_config::{DetectedRunTask, PreparedRun, RunCatalog, RunConfiguration};
pub use search::{CancellationToken, SearchMatch, SearchQuery, WorkspaceSearch};
pub use session::{MarkdownView, SessionGroup, SessionPanels, SessionState, SessionStore};
pub use session_meta::{
    patch_for_file_stats, patch_for_model_selected, patch_for_turn_complete, patch_for_turn_start,
    patches_for_delegation, workspace_hash, workspace_key, AgentUse, FileChangeStats, ModelUse,
    ModelUsePatch, SessionLink, SessionMeta, SessionMetaPatch, SessionMetaStore, SessionParent,
    SESSION_META_MAX_BYTES, SESSION_META_MAX_SESSIONS, SESSION_META_SCHEMA_VERSION,
};
pub use settings::{
    AgentSettings, AutoSaveMode, DelegationSettings, LanguageServerSettings, RunToolsSettings,
    Settings, SettingsScope, Theme, UpdateSettings, COMMAND_IDS, LANGUAGE_SERVER_IDS,
    SYNTAX_THEMES, SYNTAX_TOKEN_IDS,
};
pub use tools::{list_tools, ToolInfo};
pub use transcript_export::{redact_paths, transcript_to_markdown, Transcript, TranscriptItem};
pub use uploads::{
    content_fingerprint, is_valid_upload_id, open_refusal, sniff_upload,
    workspace_key as uploads_workspace_key, ExternalCopy, Upload, UploadChunk, UploadKind,
    UploadLimits, UploadOrigin, UploadSource, UploadStore, UploadUsage, MAX_UPLOADS_TOTAL_BYTES,
    MAX_UPLOAD_BYTES, MAX_UPLOAD_COUNT, MAX_UPLOAD_READ_BYTES,
};
pub use workspace::{atomic_write, CoreWorkspace, FileEntry, Workspace};

use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("{operation} {path}: {source}")]
    Io {
        operation: &'static str,
        path: String,
        source: std::io::Error,
    },
    #[error("Path is outside the workspace: {0}")]
    OutsideWorkspace(String),
    #[error("This is library source, not a file in your project: {0}")]
    LibrarySource(String),
    #[error("Invalid path: it contains a NUL character")]
    InvalidPath,
    #[error("Expected revision {expected}, current revision is {actual}")]
    StaleRevision { expected: u64, actual: u64 },
    #[error("Invalid edit: {0}")]
    InvalidEdit(String),
    #[error("File changed on disk. Reload or compare before saving: {0}")]
    SaveConflict(String),
    #[error("Buffer is not open: {0}")]
    BufferNotOpen(String),
    #[error("Unknown edit proposal: {0}")]
    UnknownProposal(String),
    #[error("Settings: {0}")]
    Settings(String),
    #[error("Formatter: {0}")]
    Formatter(String),
    #[error("Run configuration: {0}")]
    RunConfiguration(String),
    #[error("Git: {0}")]
    Git(String),
    #[error("Search: {0}")]
    Search(String),
    #[error("Attachment rejected: {0}")]
    Attachment(String),
    #[error("Upload: {0}")]
    Upload(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;
fn io_error(operation: &'static str, path: &Path, source: std::io::Error) -> CoreError {
    CoreError::Io {
        operation,
        path: path.display().to_string(),
        source,
    }
}
