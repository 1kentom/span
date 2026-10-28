//! Language Server Protocol client foundation for the Span editor.
//!
//! Provides an async LSP client with stdio transport, byte-correct Content-Length framing,
//! request/response correlation, document synchronization with UTF-16 position handling,
//! and support for server notifications and server-initiated requests.
//!
//! This implementation follows the Language Server Protocol 3.17 specification.
//! Technical references:
//! - LSP 3.17 specification: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/
//! - Microsoft JSON language server: https://github.com/microsoft/vscode-json-languageserver

mod client;
mod document;
mod error;
mod protocol;
pub mod servers;
mod transport;

pub use client::{LspClient, ServerEvent};
pub use document::{DocumentRegistry, TrackedDocument};
pub use error::{LspError, Result};
pub use lsp_types;
pub use protocol::RequestId;

#[cfg(test)]
mod tests;
