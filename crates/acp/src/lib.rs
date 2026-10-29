//! Native ACP subprocess client. The agent runs with the user's OS privileges.
//! ACP filesystem callbacks use editor buffers and require review before edits apply.
mod adapter;
mod background;
mod compatibility;
mod delegated;
mod health;
mod launch;
mod managed;
mod manager;
mod npm_bin;
mod process;
mod registry;
mod service;
pub mod tools;
mod types;
pub mod update;
pub use adapter::agent_presets;
pub use background::{BackgroundAgents, BackgroundState, Ensured, LaunchFn, LaunchFuture};
pub use delegated::{
    end_delegated_session, ended_delegated_sessions, is_delegated_session, open_delegated_sessions,
    record_delegated_session, set_delegated_ledger, sweep_delegated_sessions, Ended,
};
pub use health::{
    AgentHealth, HealthEnabled, HealthMonitor, HealthPolicy, HealthSink, HealthState, HealthTarget,
    HealthTargets, HEALTH_CHECK_INTERVAL, HEALTH_PROMPT, HEALTH_TITLE_PREFIX,
};
pub use managed::remove_installed_agent;
pub use manager::{
    AgentControl, ConnectionInfo, LiveSession, PendingKind, PendingRequest, PromptError,
    SessionActivity, SessionEndHook, SessionEvent, SessionEventSink, SessionInfo, SessionKey,
    SessionManager, SessionOrigin, SessionRuntimeState, SessionStateSink, SessionStates,
    Subscription, DEPTH_EXCEEDED, PROMPT_ALREADY_RUNNING,
};
pub use registry::{fetch_registry, install_registry_agent, list_installed_agents};
pub use service::{
    is_health_title, is_hidden_session, remember_hidden_sessions, AgentService, EventSink,
};
pub use types::*;
