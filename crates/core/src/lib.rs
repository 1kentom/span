//! The editor's authoritative text and workspace services.
//! UI undo/redo owns history and submits inverse edits through `edit_buffer`.
mod buffer;
mod format;
mod fs_ops;
mod images;
mod proposal_diff;
mod recent;
mod search;
mod session;
mod settings;
mod tools;
mod workspace;

pub use buffer::{BufferRevision, BufferSnapshot, EditProposal, ProposalHunk, TextEdit};
pub use format::{
    native_program_path, resolve_program, run_formatter, FormatRequest, FormatResult,
};
pub use images::RasterImage;
pub use recent::{RecentProject, RecentProjectStore};
pub use search::{CancellationToken, SearchMatch, SearchQuery, WorkspaceSearch};
pub use session::{MarkdownView, SessionGroup, SessionPanels, SessionState, SessionStore};
pub use settings::{AutoSaveMode, Settings, SettingsScope, Theme};
pub use tools::{list_tools, ToolInfo};
pub use workspace::{CoreWorkspace, FileEntry, Workspace};

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
    #[error("Search: {0}")]
    Search(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;
fn io_error(operation: &'static str, path: &Path, source: std::io::Error) -> CoreError {
    CoreError::Io {
        operation,
        path: path.display().to_string(),
        source,
    }
}
