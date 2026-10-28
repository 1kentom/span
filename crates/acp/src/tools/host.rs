//! The span-agents servers of the user's lead sessions, one per session.
//!
//! The desktop asks this host to open or restore a lead session. When
//! delegation or run tools are enabled, a server is started first, its entry
//! is offered in that one `session/new` or `session/load` only, and the server
//! is bound to the session once the agent returns its id. The server stops
//! when the session leaves the manager (close, delete, disconnect, process
//! exit).
use super::{transport_for, DecisionRecord, DelegationEvent, DelegationStatus, DelegationTask};
use super::{ToolServer, ToolServerConfig};
use crate::{SessionKey, SessionManager, SessionOrigin};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

/// Running servers keyed by lead session.
#[derive(Clone, Default)]
pub struct LeadServers {
    servers: Arc<Mutex<HashMap<SessionKey, ToolServer>>>,
}

/// What happened to delegation for a session the host opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeadDelegation {
    /// Delegation was not requested.
    Off,
    /// The tools were offered to the session.
    Attached,
    /// Delegation was requested but the agent cannot use the server.
    Unavailable(String),
}

impl LeadServers {
    fn servers(&self) -> MutexGuard<'_, HashMap<SessionKey, ToolServer>> {
        self.servers.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Whether the agent on `connection_id` can use the server, with the
    /// reason to show when it cannot.
    pub fn availability(manager: &SessionManager, connection_id: &str) -> Result<(), String> {
        let connection = manager
            .connection(connection_id)
            .filter(|c| c.open)
            .ok_or("Unknown or disconnected connection")?;
        let features = connection
            .features
            .ok_or("The agent has not finished initialize")?;
        transport_for(&features).map(|_| ())
    }

    /// Start a server when any tool capability is requested and the agent
    /// supports it. `Ok(None)` means no server; the second value says why.
    async fn prepare(
        manager: &SessionManager,
        connection_id: &str,
        config: Option<ToolServerConfig>,
    ) -> Result<(Option<ToolServer>, LeadDelegation), String> {
        let Some(config) = config else {
            return Ok((None, LeadDelegation::Off));
        };
        if let Err(reason) = Self::availability(manager, connection_id) {
            emit_unavailable(manager, connection_id, &config, &reason);
            return Ok((None, LeadDelegation::Unavailable(reason)));
        }
        let server = ToolServer::start(manager, connection_id, config).await?;
        Ok((Some(server), LeadDelegation::Attached))
    }

    /// Open a user session on `connection_id`. With `config`, the session
    /// gets the enabled Span tools when its agent advertises MCP over HTTP;
    /// otherwise it is opened without them and the reason is returned (and
    /// emitted as [`DelegationEvent::Unavailable`]). Other sessions on the
    /// connection, including delegated children, never get the entry.
    pub async fn open_lead(
        &self,
        manager: &SessionManager,
        connection_id: &str,
        config: Option<ToolServerConfig>,
    ) -> Result<(SessionKey, LeadDelegation), String> {
        let (server, outcome) = Self::prepare(manager, connection_id, config).await?;
        let entries = server
            .as_ref()
            .map(|s| vec![s.mcp_server_json()])
            .unwrap_or_default();
        let key = manager
            .open_session_with(connection_id, None, SessionOrigin::User, entries)
            .await?;
        if let Some(server) = server {
            self.attach(manager, key.clone(), server)?;
        }
        Ok((key, outcome))
    }

    /// Restore an earlier session (`session/load`) as a lead. ACP does not
    /// keep MCP servers across a load, so a fresh server and token are
    /// offered in this load only.
    pub async fn load_lead(
        &self,
        manager: &SessionManager,
        connection_id: &str,
        session_id: &str,
        config: Option<ToolServerConfig>,
    ) -> Result<(SessionKey, LeadDelegation), String> {
        let service = manager
            .service(connection_id)
            .ok_or("Unknown or disconnected connection")?;
        let key = SessionKey::new(connection_id, session_id);
        // Loading a session that already has a running server offers that
        // same server again, so the agent's MCP connection keeps working.
        let existing = self
            .servers()
            .get(&key)
            .filter(|s| s.running())
            .map(ToolServer::mcp_server_json);
        let (server, outcome, entries) = match existing {
            Some(entry) => (None, LeadDelegation::Attached, vec![entry]),
            None => {
                let (server, outcome) = Self::prepare(manager, connection_id, config).await?;
                let entries = server
                    .as_ref()
                    .map(|s| vec![s.mcp_server_json()])
                    .unwrap_or_default();
                (server, outcome, entries)
            }
        };
        service
            .load_session_with(session_id.to_owned(), entries)
            .await?;
        manager.adopt(key.clone(), SessionOrigin::User)?;
        if let Some(server) = server {
            self.attach(manager, key.clone(), server)?;
        }
        Ok((key, outcome))
    }

    /// Bind `server` to `lead` and stop it when the session ends.
    pub fn attach(
        &self,
        manager: &SessionManager,
        lead: SessionKey,
        server: ToolServer,
    ) -> Result<(), String> {
        server.bind(manager, lead.clone())?;
        let sink = server.events();
        let host = self.clone();
        let ended = lead.clone();
        manager.on_session_end(
            &lead,
            Box::new(move || {
                if let Some(server) = host.servers().remove(&ended) {
                    server.shutdown();
                    if let Some(sink) = &sink {
                        sink(DelegationEvent::Detached { lead: ended });
                    }
                }
            }),
        )?;
        let agent_name = manager
            .connection(&lead.connection_id)
            .map(|c| c.agent_name)
            .unwrap_or_default();
        if let Some(sink) = server.events() {
            sink(DelegationEvent::Attached {
                lead: lead.clone(),
                agent_name,
            });
        }
        if let Some(previous) = self.servers().insert(lead, server) {
            previous.shutdown();
        }
        Ok(())
    }

    /// True when `lead` has a running server.
    pub fn attached(&self, lead: &SessionKey) -> bool {
        self.servers().get(lead).is_some_and(ToolServer::running)
    }

    /// Tasks of one lead, or of every lead when `lead` is `None`.
    pub fn tasks(&self, lead: Option<&SessionKey>) -> Vec<DelegationTask> {
        self.servers()
            .iter()
            .filter(|(key, _)| lead.is_none_or(|l| l == *key))
            .flat_map(|(_, server)| server.tasks())
            .collect()
    }

    /// The user stops one task (see [`ToolServer::cancel_task`]). Task ids
    /// repeat across leads, so pass the `lead` the UI shows; without one the
    /// id must be unique among running servers.
    pub fn cancel_task(&self, lead: Option<&SessionKey>, task_id: &str) -> Result<(), String> {
        let servers = self.servers();
        let mut found = servers
            .iter()
            .filter(|(key, _)| lead.is_none_or(|l| l == *key))
            .map(|(_, server)| server)
            .filter(|server| server.has_task(task_id));
        let server = found.next().ok_or("Unknown task")?;
        if found.next().is_some() {
            return Err("Several sessions have this task id".into());
        }
        server.cancel_task(task_id)
    }

    /// Decisions one lead recorded.
    pub fn decisions(&self, lead: &SessionKey) -> Vec<DecisionRecord> {
        self.servers()
            .get(lead)
            .map(ToolServer::decisions)
            .unwrap_or_default()
    }

    /// Delegation state for `connection_id` and its current `lead`.
    pub fn status(
        &self,
        manager: &SessionManager,
        connection_id: &str,
        lead: Option<&SessionKey>,
        enabled: bool,
    ) -> DelegationStatus {
        let availability = Self::availability(manager, connection_id);
        let attached = lead.is_some_and(|l| self.attached(l));
        let reason = match (&availability, enabled, attached) {
            (Err(reason), _, _) => Some(reason.clone()),
            (Ok(()), false, _) => {
                Some("Delegation is turned off (agents.delegation.enabled).".into())
            }
            (Ok(()), true, false) => Some(
                "Delegation applies to sessions started or restored after it was turned on.".into(),
            ),
            (Ok(()), true, true) => None,
        };
        DelegationStatus {
            enabled,
            available: availability.is_ok(),
            reason,
            lead: lead.cloned(),
            attached,
            tasks: lead.map(|l| self.tasks(Some(l))).unwrap_or_default(),
            decisions: lead.map(|l| self.decisions(l)).unwrap_or_default(),
        }
    }

    /// Stop every server (children are cancelled).
    pub fn shutdown_all(&self) {
        let servers: Vec<ToolServer> = self.servers().drain().map(|(_, s)| s).collect();
        for server in servers {
            server.shutdown();
        }
    }
}

fn emit_unavailable(
    manager: &SessionManager,
    connection_id: &str,
    config: &ToolServerConfig,
    reason: &str,
) {
    if let Some(sink) = &config.events {
        sink(DelegationEvent::Unavailable {
            connection_id: connection_id.to_owned(),
            agent_name: manager
                .connection(connection_id)
                .map(|c| c.agent_name)
                .unwrap_or_default(),
            reason: reason.to_owned(),
        });
    }
}
