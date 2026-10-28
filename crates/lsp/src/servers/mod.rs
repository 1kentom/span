//! Language server integration: catalog, installation and lifecycle.
//!
//! Ownership of submodules (see the PR description):
//! - `spec`: shared data types (this file's contract, change only by agreement)
//! - `catalog`: pinned server definitions and runtime detection
//! - `install`: download, integrity verification, cache and updates
//! - `manager`: lazy start, reuse, restart and shutdown on top of `LspClient`

pub mod cache;
pub mod catalog;
pub mod install;
pub mod manager;
pub mod runtime;
pub mod spec;

pub use spec::{
    Artifact, ArtifactKind, InstallPlan, LaunchSpec, Runtime, RuntimeRequirement, ServerId,
    ServerSpec,
};
