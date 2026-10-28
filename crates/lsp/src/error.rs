//! Error types for LSP client operations.

use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum LspError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Process exited: {0}")]
    ProcessExited(String),

    #[error("Protocol error: {0}")]
    Protocol(String),

    #[error("Invalid header: {0}")]
    InvalidHeader(String),

    #[error("Request timeout")]
    Timeout,

    #[error("Request cancelled")]
    Cancelled,

    #[error("Server error {code}: {message}")]
    ServerError {
        code: i64,
        message: String,
        data: Option<Value>,
    },

    #[error("Document version mismatch: expected {expected}, got {actual}")]
    VersionMismatch { expected: i32, actual: i32 },

    #[error("Document not tracked: {0}")]
    DocumentNotTracked(String),

    #[error("Client shutdown")]
    Shutdown,
}

pub type Result<T> = std::result::Result<T, LspError>;
