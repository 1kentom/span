//! Native ACP subprocess client. The agent runs with the user's OS privileges.
//! ACP filesystem callbacks use editor buffers and require review before edits apply.
mod adapter;
mod launch;
mod manager;
mod registry;
mod service;
pub mod tools;
mod types;
pub use adapter::agent_presets;
pub use manager::{
    AgentControl, ConnectionInfo, PendingKind, PendingRequest, SessionEndHook, SessionEvent,
    SessionEventSink, SessionInfo, SessionKey, SessionManager, SessionOrigin, Subscription,
    DEPTH_EXCEEDED,
};
pub use registry::{fetch_registry, install_registry_agent, list_installed_agents};
pub use service::{AgentService, EventSink};
pub use types::*;
