//! Native ACP subprocess client. The agent runs with the user's OS privileges.
//! ACP filesystem callbacks use editor buffers and require review before edits apply.
mod launch;
mod manager;
mod registry;
mod service;
mod types;
pub use manager::{
    AgentControl, PendingKind, PendingRequest, SessionEvent, SessionEventSink, SessionInfo,
    SessionKey, SessionManager, SessionOrigin,
};
pub use registry::{fetch_registry, install_registry_agent, list_installed_agents};
pub use service::{AgentService, EventSink};
pub use types::*;
