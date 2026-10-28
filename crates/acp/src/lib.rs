//! Native ACP subprocess client. The agent runs with the user's OS privileges.
//! ACP filesystem callbacks use editor buffers and require review before edits apply.
mod compatibility;
mod launch;
mod managed;
mod npm_bin;
mod registry;
mod service;
mod types;
pub use managed::remove_installed_agent;
pub use registry::{fetch_registry, install_registry_agent, list_installed_agents};
pub use service::{AgentService, EventSink};
pub use types::*;
