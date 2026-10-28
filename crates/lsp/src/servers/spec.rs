//! Shared data types for the server catalog, installer and manager.

use serde_json::Value;
use std::path::PathBuf;

/// Stable identifier of a supported language server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ServerId {
    Vtsls,
    Html,
    Css,
    Json,
    RustAnalyzer,
    Basedpyright,
    Jdtls,
}

/// A runtime a server needs on the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Runtime {
    Node,
    Java,
    /// Server ships as a self-contained native binary.
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeRequirement {
    pub runtime: Runtime,
    /// Minimum major version, taken from the pinned release documentation.
    pub min_major: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactKind {
    /// npm tarball (`.tgz`) installed without running lifecycle scripts.
    NpmTarball,
    TarGz,
    Gz,
    Zip,
}

/// One pinned, integrity-checked download.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Artifact {
    pub url: String,
    /// Lowercase hex SHA-256 of the downloaded file.
    pub sha256: String,
    pub kind: ArtifactKind,
    /// Path of the entry point relative to the extraction directory.
    pub entry: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallPlan {
    pub version: String,
    /// Every artifact needed (a server may have several npm packages).
    pub artifacts: Vec<Artifact>,
}

/// Explicit argument-array launch description. Never shell-interpolated.
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct ServerSpec {
    pub id: ServerId,
    pub display_name: &'static str,
    /// LSP language ids this server handles.
    pub language_ids: &'static [&'static str],
    /// File extensions (lowercase, no dot).
    pub extensions: &'static [&'static str],
    /// Project root marker files, nearest ancestor wins.
    pub root_markers: &'static [&'static str],
    pub runtime: RuntimeRequirement,
    /// Initialization options sent in `initialize`.
    pub initialization_options: Value,
}
