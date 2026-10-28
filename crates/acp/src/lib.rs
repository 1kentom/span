//! Native ACP subprocess client. The agent runs with the user's OS privileges.
//! ACP filesystem callbacks use editor buffers and require review before edits apply.
mod adapter;
mod compatibility;
mod launch;
mod managed;
mod manager;
mod npm_bin;
mod registry;
mod service;
pub mod tools;
mod types;
pub mod update;
pub use adapter::agent_presets;
pub use managed::remove_installed_agent;
pub use manager::{
    AgentControl, ConnectionInfo, PendingKind, PendingRequest, SessionEndHook, SessionEvent,
    SessionEventSink, SessionInfo, SessionKey, SessionManager, SessionOrigin, Subscription,
    DEPTH_EXCEEDED,
};
pub use registry::{fetch_registry, install_registry_agent, list_installed_agents};
pub use service::{AgentService, EventSink};
pub use types::*;
