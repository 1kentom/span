//! The span-agents MCP server: a minimal MCP Streamable HTTP endpoint on
//! 127.0.0.1, one per lead session.
//!
//! Targets MCP 2025-11-25 (the last initialize-based revision, also
//! accepting 2025-06-18 and 2025-03-26 clients):
//! https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
//! Implemented: POST of single JSON-RPC messages to `/mcp`; `initialize`,
//! `ping`, `tools/list`, `tools/call`; `notifications/progress` on a
//! request scoped SSE stream when the call carries `_meta.progressToken`
//! and the client accepts `text/event-stream`. Not implemented: GET streams
//! (405), sessions (`MCP-Session-Id`), resumability, batching, and the
//! sessionless 2026-07-28 revision (requests that declare it get a 400 that
//! dual-era clients treat as a legacy server).
use super::result::{self, inside_workspace, FailureReason, ResultInput};
use super::tasks::{DecisionRecord, Registry, TaskStatus};
use super::{
    hints_for, transport_for, BudgetRequest, DelegationEvent, DelegationTask, DelegationTranscript,
    RunConfigurationEntry, RunToolBackend, ToolServerConfig,
};
use crate::{
    AgentControl, BackgroundState, ConnectionInfo, InstalledAgent, PromptAttachment, SessionEvent,
    SessionKey, SessionManager, Subscription,
};
use agent_client_protocol::schema::v1::{HttpHeader, McpServer, McpServerHttp};
use serde::Deserialize;
use serde_json::{json, Value};
use span_core::RunConfiguration;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};

pub const SERVER_NAME: &str = "span-agents";
/// Supported MCP revisions, newest first.
pub const MCP_PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];
const ENDPOINT: &str = "/mcp";
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(10);

struct RpcError {
    code: i64,
    message: String,
}

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError {
        code: -32602,
        message: message.into(),
    }
}

struct Shared {
    lead_connection: String,
    lead_name: String,
    lead_accepts_images: bool,
    port: u16,
    token: String,
    root: PathBuf,
    config: ToolServerConfig,
    registry: Registry,
    control: Mutex<Option<AgentControl>>,
    editor: Mutex<Option<Arc<crate::EditorTools>>>,
    /// Holds registry and manager enqueue together so tasks of one child
    /// are registered in the order the manager runs them.
    order: Mutex<()>,
    shutdown: watch::Sender<bool>,
    subscription: Mutex<Option<Subscription>>,
}

/// One running span-agents server. Dropping it stops the server and
/// cancels the children it started.
pub struct ToolServer {
    shared: Arc<Shared>,
    url: String,
}

impl std::fmt::Debug for ToolServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the token.
        f.debug_struct("ToolServer")
            .field("url", &self.url)
            .field("lead_connection", &self.shared.lead_connection)
            .finish_non_exhaustive()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

impl ToolServer {
    /// Start a server for a lead on `lead_connection`, before its session
    /// exists (the URL and token go into that session's `session/new`).
    /// Fails, with the reason to show the user, when the lead agent does
    /// not advertise MCP over HTTP.
    pub async fn start(
        manager: &SessionManager,
        lead_connection: &str,
        config: ToolServerConfig,
    ) -> Result<ToolServer, String> {
        let connection = manager
            .connection(lead_connection)
            .filter(|c| c.open)
            .ok_or("Unknown or disconnected lead connection")?;
        let features = connection
            .features
            .ok_or("The lead agent has not finished initialize")?;
        transport_for(&features)?;
        // Before binding, so a missing random source leaves no open port.
        let token = random_hex(32)?;
        let root = PathBuf::from(
            config
                .workspace
                .lock()
                .map_err(|_| "Workspace lock poisoned")?
                .workspace()
                .root,
        );
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("Bind span-agents server: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("span-agents address: {e}"))?
            .port();
        let (shutdown, _) = watch::channel(false);
        let shared = Arc::new(Shared {
            lead_connection: lead_connection.to_owned(),
            lead_name: connection.agent_name,
            lead_accepts_images: features.image,
            port,
            token,
            root,
            config,
            registry: Registry::default(),
            control: Mutex::new(None),
            editor: Mutex::new(None),
            order: Mutex::new(()),
            shutdown,
            subscription: Mutex::new(None),
        });
        let weak: Weak<Shared> = Arc::downgrade(&shared);
        let subscription = manager.subscribe(Arc::new(move |event: SessionEvent| {
            if let Some(shared) = weak.upgrade() {
                shared.on_event(&event);
            }
        }));
        *lock(&shared.subscription) = Some(subscription);
        tokio::spawn(accept_loop(
            listener,
            Arc::downgrade(&shared),
            shared.shutdown.subscribe(),
        ));
        tokio::spawn(budget_loop(
            Arc::downgrade(&shared),
            shared.shutdown.subscribe(),
        ));
        Ok(ToolServer {
            url: format!("http://127.0.0.1:{port}{ENDPOINT}"),
            shared,
        })
    }

    /// Attach the lead session once the agent created it. The server stops
    /// when that session ends.
    pub fn bind(&self, manager: &SessionManager, lead: SessionKey) -> Result<(), String> {
        if lead.connection_id != self.shared.lead_connection {
            return Err("The lead session is on a different connection".into());
        }
        let control = manager.agent_control(lead)?;
        if let Some(access) = self.shared.config.editor_tools.clone() {
            let key = control.caller();
            let service = manager
                .service(&key.connection_id)
                .ok_or("Review agent disconnected")?;
            *lock(&self.shared.editor) =
                Some(Arc::new(service.editor_tools(&key.session_id, access)?));
        }
        let weak = Arc::downgrade(&self.shared);
        control.on_caller_end(Box::new(move || {
            if let Some(shared) = weak.upgrade() {
                shared.stop();
            }
        }))?;
        *lock(&self.shared.control) = Some(control);
        Ok(())
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    /// The `mcpServers` entry for the lead's `session/new`. It carries the
    /// bearer token: callers must not log it.
    pub fn mcp_server(&self) -> McpServer {
        McpServer::Http(
            McpServerHttp::new(SERVER_NAME, self.url.clone()).headers(vec![HttpHeader::new(
                "Authorization",
                format!("Bearer {}", self.shared.token),
            )]),
        )
    }

    /// [`Self::mcp_server`] as ACP JSON, the form `AgentService` takes.
    pub fn mcp_server_json(&self) -> Value {
        serde_json::to_value(self.mcp_server()).unwrap_or(Value::Null)
    }

    pub fn decisions(&self) -> Vec<DecisionRecord> {
        self.shared.registry.decisions()
    }

    /// The event sink this server reports to.
    pub fn events(&self) -> Option<super::DelegationEventSink> {
        self.shared.config.events.clone()
    }

    /// The bound lead session, if any.
    pub fn lead(&self) -> Option<SessionKey> {
        lock(&self.shared.control)
            .as_ref()
            .map(|c| c.caller().clone())
    }

    /// Every task this server started, oldest first.
    pub fn tasks(&self) -> Vec<DelegationTask> {
        let Some(lead) = self.lead() else {
            return Vec::new();
        };
        let second = self.shared.second();
        self.shared
            .registry
            .task_ids()
            .into_iter()
            .filter_map(|id| self.task(&lead, id, second))
            .collect()
    }

    /// One task with everything its child wrote so far (bounded by the
    /// registry), for the user opening the child session from its card.
    pub fn transcript(&self, task_id: &str) -> Option<DelegationTranscript> {
        let lead = self.lead()?;
        let text = self
            .shared
            .registry
            .view(task_id, self.shared.second())?
            .task
            .text;
        let task = self.task(&lead, task_id.to_owned(), self.shared.second())?;
        Some(DelegationTranscript { task, text })
    }

    fn task(&self, lead: &SessionKey, task_id: String, second: Duration) -> Option<DelegationTask> {
        let view = self.shared.registry.view(&task_id, second)?;
        Some(DelegationTask {
            artifacts: self
                .shared
                .artifacts(&view.task)
                .into_iter()
                .map(|(artifact, _)| artifact)
                .collect(),
            result_summary: view.task.summary(),
            progress_text: view.task.progress_text(),
            started_at_ms: view.task.started_at_ms,
            finished_at_ms: view.task.finished_at_ms,
            budget_used: view.usage,
            task_id,
            lead: lead.clone(),
            child: view.task.key,
            agent_name: view.task.agent,
            status: view.task.status.as_str().into(),
            stop_reason: view.task.stop_reason,
            reason: view.task.reason,
            detail: view.task.detail,
        })
    }

    /// Whether this server started `task_id`.
    pub fn has_task(&self, task_id: &str) -> bool {
        self.shared.registry.task_key(task_id).is_some()
    }

    /// The user stops one task: its child and everything below it are
    /// cancelled and the task ends as `failed` with reason `cancelled`.
    /// Only the desktop's user command calls this; it is not a tool. Refused
    /// when the task already finished.
    pub fn cancel_task(&self, task_id: &str) -> Result<(), String> {
        let control = self.shared.control().map_err(|e| e.message)?;
        let key = self.shared.registry.cancel_by_user(task_id)?;
        control.cancel(&key)
    }

    /// False once the server stopped (explicitly, or because the lead ended).
    pub fn running(&self) -> bool {
        !*self.shared.shutdown.borrow()
    }

    pub fn revoke_editor_tools(&self) {
        if let Some(editor) = lock(&self.shared.editor).take() {
            editor.revoke();
        }
    }

    /// Stop serving and cancel every child this server started.
    pub fn shutdown(&self) {
        self.shared.stop();
    }
}

impl Drop for ToolServer {
    fn drop(&mut self) {
        self.shared.stop();
    }
}

impl Shared {
    fn control(&self) -> Result<AgentControl, RpcError> {
        lock(&self.control).clone().ok_or(RpcError {
            code: -32603,
            message: "The lead session is not ready or has ended".into(),
        })
    }

    fn second(&self) -> Duration {
        self.config.policy.second
    }

    fn emit(&self, event: DelegationEvent) {
        if let Some(sink) = &self.config.events {
            sink(event);
        }
    }

    /// Files a finished task changed or was asked to save, read now.
    fn artifacts(&self, task: &super::tasks::Task) -> Vec<(result::Artifact, Vec<u8>)> {
        if !task.status.finished() {
            return Vec::new();
        }
        let mut paths = task.changed.clone();
        if let Some(path) = &task.save_to {
            if !paths.contains(path) {
                paths.push(path.clone());
            }
        }
        paths
            .iter()
            .filter_map(|p| result::read_artifact(&self.config.workspace, &self.root, p))
            .collect()
    }

    fn stop(&self) {
        if *self.shutdown.borrow() {
            return;
        }
        self.shutdown.send_replace(true);
        if let Some(editor) = lock(&self.editor).take() {
            editor.revoke();
        }
        let control = lock(&self.control).take();
        if let Some(control) = control {
            for child in self.registry.children() {
                self.registry.stopping(
                    &child,
                    FailureReason::Cancelled,
                    "the lead session ended".into(),
                );
                let _ = control.cancel(&child);
            }
        }
        lock(&self.subscription).take();
    }

    fn on_event(&self, event: &SessionEvent) {
        let control = lock(&self.control).clone();
        if let (Some(request), Some(control)) =
            (self.registry.child_request(event), control.as_ref())
        {
            self.emit(DelegationEvent::ChildPermission {
                lead: control.caller().clone(),
                connection_id: request.key.connection_id.clone(),
                session_id: request.key.session_id.clone(),
                child: request.key,
                task_id: request.task_id,
                agent_name: request.agent,
                request_id: request.request_id,
                request_kind: request.request_kind.into(),
            });
        }
        let breach = self.registry.observe(event, self.second(), |key| {
            control.as_ref().is_some_and(|c| c.permission_rejected(key))
        });
        if let (Some((key, _, _)), Some(control)) = (breach, control) {
            let _ = control.cancel(&key);
        }
    }

    fn check_budgets(&self) {
        let breaches = self.registry.breaches(self.second());
        if breaches.is_empty() {
            return;
        }
        if let Ok(control) = self.control() {
            for (key, _, _) in breaches {
                let _ = control.cancel(&key);
            }
        }
    }

    /// Register a task, call `registered` with its id, then hand its prompt
    /// to the manager, in that order, then wait for it in the background.
    /// `registered` runs before the prompt is queued, so an event it emits
    /// precedes every event the child can produce for this task.
    fn run_task(
        self: &Arc<Self>,
        control: &AgentControl,
        child: &SessionKey,
        save_to: Option<String>,
        text: String,
        attachments: Vec<PromptAttachment>,
        registered: impl FnOnce(&str),
    ) -> Result<String, String> {
        let (task_id, done) = {
            let _order = lock(&self.order);
            let task_id = self.registry.start_task(child, save_to, self.second())?;
            registered(&task_id);
            match control.enqueue(child, text, attachments) {
                Ok(done) => (task_id, done),
                Err(error) => {
                    self.registry.finish(&task_id, Err(error.clone()));
                    if let Some(view) = self.registry.view(&task_id, self.second()) {
                        self.emit(DelegationEvent::TaskFinished {
                            lead: control.caller().clone(),
                            child: child.clone(),
                            task_id,
                            status: view.task.status.as_str().into(),
                            reason: view.task.reason,
                        });
                    }
                    return Err(error);
                }
            }
        };
        let shared = Arc::downgrade(self);
        let (lead, child, id) = (control.caller().clone(), child.clone(), task_id.clone());
        tokio::spawn(async move {
            let result = done
                .await
                .unwrap_or_else(|_| Err("The session ended before the turn finished".into()));
            let Some(shared) = shared.upgrade() else {
                return;
            };
            shared.registry.finish(&id, result);
            if let Some(view) = shared.registry.view(&id, shared.second()) {
                shared.emit(DelegationEvent::TaskFinished {
                    lead,
                    child,
                    task_id: id,
                    status: view.task.status.as_str().into(),
                    reason: view.task.reason,
                });
            }
        });
        Ok(task_id)
    }
}

async fn accept_loop(listener: TcpListener, shared: Weak<Shared>, mut stop: watch::Receiver<bool>) {
    loop {
        let accepted = tokio::select! {
            _ = stop.changed() => break,
            accepted = listener.accept() => accepted,
        };
        let Ok((stream, peer)) = accepted else {
            continue;
        };
        if !peer.ip().is_loopback() {
            continue;
        }
        let Some(server) = shared.upgrade() else {
            break;
        };
        let mut stop = stop.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = stop.changed() => {}
                _ = handle_connection(server, stream) => {}
            }
        });
    }
}

async fn budget_loop(shared: Weak<Shared>, mut stop: watch::Receiver<bool>) {
    let second = match shared.upgrade() {
        Some(shared) => shared.second(),
        None => return,
    };
    let mut ticks = tokio::time::interval(second);
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            _ = ticks.tick() => {}
        }
        match shared.upgrade() {
            Some(shared) => shared.check_budgets(),
            None => break,
        }
    }
}

struct Request {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

async fn read_request(stream: &mut TcpStream) -> Result<Request, (u16, &'static str)> {
    let mut buffer = Vec::with_capacity(4096);
    let header_end = loop {
        if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break end;
        }
        if buffer.len() > MAX_HEADER_BYTES {
            return Err((431, "Request headers too large"));
        }
        let mut chunk = [0u8; 4096];
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|_| (400, "Unreadable request"))?;
        if read == 0 {
            return Err((400, "Connection closed"));
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = std::str::from_utf8(&buffer[..header_end]).map_err(|_| (400, "Bad headers"))?;
    let mut lines = head.split("\r\n");
    let mut start = lines.next().unwrap_or_default().split(' ');
    let method = start.next().unwrap_or_default().to_owned();
    let target = start.next().unwrap_or_default().to_owned();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let mut rest = buffer[header_end + 4..].to_vec();
    let find = |name: &str| {
        headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
    };
    let body =
        if find("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked")) {
            read_chunked(stream, rest).await?
        } else {
            let length: usize = match find("content-length") {
                Some(value) => value.parse().map_err(|_| (400, "Bad Content-Length"))?,
                None => 0,
            };
            if length > MAX_BODY_BYTES {
                return Err((413, "Request body too large"));
            }
            while rest.len() < length {
                let mut chunk = vec![0u8; (length - rest.len()).min(64 * 1024)];
                let read = stream
                    .read(&mut chunk)
                    .await
                    .map_err(|_| (400, "Unreadable body"))?;
                if read == 0 {
                    return Err((400, "Truncated body"));
                }
                rest.extend_from_slice(&chunk[..read]);
            }
            rest.truncate(length);
            rest
        };
    Ok(Request {
        method,
        target,
        headers,
        body,
    })
}

async fn read_chunked(
    stream: &mut TcpStream,
    mut data: Vec<u8>,
) -> Result<Vec<u8>, (u16, &'static str)> {
    let mut body = Vec::new();
    loop {
        let line_end = loop {
            if let Some(end) = data.windows(2).position(|w| w == b"\r\n") {
                break end;
            }
            read_more(stream, &mut data).await?;
        };
        let size_text = std::str::from_utf8(&data[..line_end]).map_err(|_| (400, "Bad chunk"))?;
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| (400, "Bad chunk size"))?;
        data.drain(..line_end + 2);
        if size == 0 {
            return Ok(body);
        }
        if body.len() + size > MAX_BODY_BYTES {
            return Err((413, "Request body too large"));
        }
        while data.len() < size + 2 {
            read_more(stream, &mut data).await?;
        }
        body.extend_from_slice(&data[..size]);
        data.drain(..size + 2);
    }
}

async fn read_more(stream: &mut TcpStream, data: &mut Vec<u8>) -> Result<(), (u16, &'static str)> {
    let mut chunk = [0u8; 4096];
    let read = stream
        .read(&mut chunk)
        .await
        .map_err(|_| (400, "Unreadable body"))?;
    if read == 0 {
        return Err((400, "Truncated body"));
    }
    data.extend_from_slice(&chunk[..read]);
    Ok(())
}

fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    }
}

async fn respond(
    stream: &mut TcpStream,
    status: u16,
    extra: &[(&str, String)],
    body: Option<Value>,
) {
    let body = body.map(|b| b.to_string()).unwrap_or_default();
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\nConnection: close\r\nContent-Length: {}\r\n",
        status_text(status),
        body.len()
    );
    if !body.is_empty() {
        head.push_str("Content-Type: application/json\r\n");
    }
    for (name, value) in extra {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn tokens_match(given: &str, expected: &str) -> bool {
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn handle_connection(shared: Arc<Shared>, mut stream: TcpStream) {
    let request = match tokio::time::timeout(READ_TIMEOUT, read_request(&mut stream)).await {
        Ok(Ok(request)) => request,
        Ok(Err((status, message))) => {
            respond(
                &mut stream,
                status,
                &[],
                Some(rpc_error(Value::Null, -32600, message)),
            )
            .await;
            return;
        }
        Err(_) => return,
    };
    let path = request.target.split('?').next().unwrap_or_default();
    if path != ENDPOINT {
        respond(&mut stream, 404, &[], None).await;
        return;
    }
    let port = shared.port;
    let local = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    // DNS rebinding: a browser page can reach loopback but sends its own Origin and Host.
    if let Some(origin) = request.header("origin") {
        let allowed = local.iter().any(|host| origin == format!("http://{host}"));
        if !allowed {
            respond(
                &mut stream,
                403,
                &[],
                Some(rpc_error(Value::Null, -32600, "Origin not allowed")),
            )
            .await;
            return;
        }
    }
    if !request
        .header("host")
        .is_some_and(|host| local.iter().any(|l| l == host))
    {
        respond(
            &mut stream,
            403,
            &[],
            Some(rpc_error(Value::Null, -32600, "Host not allowed")),
        )
        .await;
        return;
    }
    let authorized = request
        .header("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| tokens_match(token.trim(), &shared.token));
    if !authorized {
        respond(
            &mut stream,
            401,
            &[("WWW-Authenticate", "Bearer realm=\"span-agents\"".into())],
            Some(rpc_error(
                Value::Null,
                -32001,
                "Missing or invalid bearer token",
            )),
        )
        .await;
        return;
    }
    if request.method != "POST" {
        respond(&mut stream, 405, &[("Allow", "POST".into())], None).await;
        return;
    }
    if let Some(version) = request.header("mcp-protocol-version") {
        if !MCP_PROTOCOL_VERSIONS.contains(&version) {
            let body = json!({"jsonrpc": "2.0", "id": Value::Null, "error": {
                "code": -32600,
                "message": "Unsupported MCP-Protocol-Version",
                "data": {"supported": MCP_PROTOCOL_VERSIONS, "requested": version},
            }});
            respond(&mut stream, 400, &[], Some(body)).await;
            return;
        }
    }
    let message: Value = match serde_json::from_slice(&request.body) {
        Ok(message) => message,
        Err(_) => {
            respond(
                &mut stream,
                400,
                &[],
                Some(rpc_error(Value::Null, -32700, "Parse error")),
            )
            .await;
            return;
        }
    };
    if !message.is_object() {
        respond(
            &mut stream,
            400,
            &[],
            Some(rpc_error(
                Value::Null,
                -32600,
                "Send one JSON-RPC message per request",
            )),
        )
        .await;
        return;
    }
    let id = message.get("id").cloned();
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let (Some(id), Some(method)) = (id, method) else {
        // Notifications and responses are accepted and need no reply.
        respond(&mut stream, 202, &[], None).await;
        return;
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let accepts_sse = request
        .header("accept")
        .is_some_and(|accept| accept.contains("text/event-stream"));
    let progress_token = params
        .get("_meta")
        .and_then(|meta| meta.get("progressToken"))
        .filter(|token| token.is_string() || token.is_number())
        .cloned();
    match (method.as_str(), progress_token) {
        ("tools/call", Some(token)) if accepts_sse => {
            stream_tool_call(shared, stream, id, params, token).await;
        }
        _ => {
            let reply = dispatch(&shared, &method, params, None).await;
            respond(&mut stream, 200, &[], Some(envelope(id, reply))).await;
        }
    }
}

fn envelope(id: Value, reply: Result<Value, RpcError>) -> Value {
    match reply {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err(error) => rpc_error(id, error.code, &error.message),
    }
}

/// Answer a `tools/call` on an SSE stream: progress notifications, then the
/// response, then the stream ends.
async fn stream_tool_call(
    shared: Arc<Shared>,
    stream: TcpStream,
    id: Value,
    params: Value,
    token: Value,
) {
    let (mut reader, mut writer) = stream.into_split();
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
    if writer.write_all(head.as_bytes()).await.is_err() {
        return;
    }
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let progress = Progress {
        token,
        tx,
        count: 0.0,
    };
    let call = dispatch(&shared, "tools/call", params, Some(progress));
    tokio::pin!(call);
    let mut closed = [0u8; 1];
    let reply = loop {
        tokio::select! {
            reply = &mut call => break reply,
            _ = reader.read(&mut closed) => {
                // The request body is already consumed. EOF means the client closed its stream.
                return;
            },
            Some(note) = rx.recv() => {
                let event = format!("event: message\ndata: {note}\n\n");
                if writer.write_all(event.as_bytes()).await.is_err() { return; }
            }
        }
    };
    while let Ok(note) = rx.try_recv() {
        let _ = writer
            .write_all(format!("event: message\ndata: {note}\n\n").as_bytes())
            .await;
    }
    let event = format!("event: message\ndata: {}\n\n", envelope(id, reply));
    let _ = writer.write_all(event.as_bytes()).await;
    let _ = writer.shutdown().await;
}

struct Progress {
    token: Value,
    tx: mpsc::UnboundedSender<Value>,
    count: f64,
}

impl Progress {
    fn send(&mut self, message: String) {
        // `progress` must increase with every notification.
        self.count += 1.0;
        let _ = self.tx.send(json!({
            "jsonrpc": "2.0",
            "method": "notifications/progress",
            "params": {"progressToken": self.token, "progress": self.count, "message": message},
        }));
    }
}

async fn dispatch(
    shared: &Arc<Shared>,
    method: &str,
    params: Value,
    progress: Option<Progress>,
) -> Result<Value, RpcError> {
    match method {
        "initialize" => {
            let asked = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let version = MCP_PROTOCOL_VERSIONS
                .iter()
                .find(|v| **v == asked)
                .copied()
                .unwrap_or(MCP_PROTOCOL_VERSIONS[0]);
            Ok(json!({
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": SERVER_NAME, "title": "Span agents", "version": env!("CARGO_PKG_VERSION")},
                "instructions": server_instructions(shared),
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tool_definitions_for(shared)})),
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            call_tool(shared, &name, arguments, progress).await
        }
        _ => Err(RpcError {
            code: -32601,
            message: format!("Method not found: {method}"),
        }),
    }
}

fn parse<T: for<'de> Deserialize<'de>>(arguments: Value) -> Result<T, RpcError> {
    serde_json::from_value(arguments).map_err(|e| invalid(format!("Invalid arguments: {e}")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DelegateArgs {
    agent: String,
    task: String,
    #[serde(default)]
    attachments: Vec<String>,
    expect: Option<String>,
    save_to: Option<String>,
    budget: Option<BudgetRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResultArgs {
    task_id: String,
    wait_seconds: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MessageArgs {
    session_id: String,
    connection_id: Option<String>,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelArgs {
    session_id: Option<String>,
    connection_id: Option<String>,
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecisionArgs {
    chosen: String,
    why: String,
    #[serde(default)]
    alternatives: Vec<String>,
}

async fn call_tool(
    shared: &Arc<Shared>,
    name: &str,
    arguments: Value,
    progress: Option<Progress>,
) -> Result<Value, RpcError> {
    match name {
        "read_buffer" => editor_read(shared, parse(arguments)?),
        "propose_edit" => editor_propose(shared, parse(arguments)?).await,
        "list_agents" if shared.config.delegation_enabled => list_agents(shared),
        "delegate" if shared.config.delegation_enabled => delegate(shared, parse(arguments)?).await,
        "get_result" if shared.config.delegation_enabled => {
            get_result(shared, parse(arguments)?, progress).await
        }
        "message" if shared.config.delegation_enabled => message(shared, parse(arguments)?),
        "cancel" if shared.config.delegation_enabled => cancel(shared, parse(arguments)?),
        "record_decision" if shared.config.delegation_enabled => {
            record_decision(shared, parse(arguments)?)
        }
        "run_configurations" => run_configurations(shared).await,
        "run_configuration_read" => run_configuration_read(shared, parse(arguments)?).await,
        "run_configuration_save" => {
            run_configuration_save(shared, parse(arguments)?, progress_sink(progress)).await
        }
        "run_configuration_delete" => {
            run_configuration_delete(shared, parse(arguments)?, progress_sink(progress)).await
        }
        "run_start" => run_start(shared, parse(arguments)?, progress_sink(progress)).await,
        "run_stop" => run_stop(shared, parse(arguments)?, progress_sink(progress)).await,
        "run_restart" => run_restart(shared, parse(arguments)?, progress_sink(progress)).await,
        "runs_list" => runs_list(shared).await,
        "run_output" => run_output(shared, parse(arguments)?).await,
        _ => Err(invalid(format!("Unknown tool: {name}"))),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EditorReadArgs {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EditorProposeArgs {
    path: String,
    content: String,
    expected_revision: u64,
    read_token: String,
}

fn editor_backend(shared: &Shared) -> Result<Arc<crate::EditorTools>, RpcError> {
    shared.control()?;
    lock(&shared.editor)
        .clone()
        .filter(|editor| editor.enabled())
        .ok_or_else(|| {
            invalid("Editor tools were not enabled for this review chat or consent was revoked")
        })
}

fn editor_read(shared: &Shared, args: EditorReadArgs) -> Result<Value, RpcError> {
    let editor = editor_backend(shared)?;
    Ok(match editor.read_buffer(&args.path) {
        Ok(read) => result::ok("Current editor buffer. Use its normalized path, revision and readToken for one proposal.".into(), serde_json::to_value(read).map_err(|_| invalid("Editor read could not be encoded"))?),
        Err(error) => json!({"content":[{"type":"text","text":error}],"isError":true}),
    })
}

async fn editor_propose(shared: &Shared, args: EditorProposeArgs) -> Result<Value, RpcError> {
    let editor = editor_backend(shared)?;
    // Dropping the proposal future cancels exactly its staged review through
    // the shared broker's RAII guard, including a user who never responds.
    let result = tokio::time::timeout(
        Duration::from_secs(120),
        editor.propose_edit(
            &args.path,
            args.content,
            args.expected_revision,
            &args.read_token,
        ),
    )
    .await;
    Ok(match result {
        Ok(Ok(outcome)) => result::ok("Editor content is in the buffer. This tool never calls Save; the user's configured AutoSave may apply after acceptance.".into(), serde_json::to_value(outcome).map_err(|_| invalid("Editor result could not be encoded"))?),
        Ok(Err(error)) => json!({"content":[{"type":"text","text":error}],"isError":true}),
        Err(_) => json!({"content":[{"type":"text","text":"Editor review timed out and was cancelled. No pending edit can apply later."}],"isError":true}),
    })
}

fn run_backend(shared: &Shared) -> Result<Arc<dyn RunToolBackend>, RpcError> {
    shared
        .config
        .run_tools
        .clone()
        .ok_or_else(|| invalid("Workspace run tools are disabled in the user's settings"))
}

fn progress_sink(progress: Option<Progress>) -> Option<super::RunToolProgress> {
    let progress = Arc::new(std::sync::Mutex::new(progress?));
    Some(Arc::new(move |message| {
        if let Ok(mut progress) = progress.lock() {
            progress.send(message);
        }
    }))
}

fn lead_key(shared: &Shared) -> Result<SessionKey, RpcError> {
    Ok(shared.control()?.caller().clone())
}

fn tool_error(error: String) -> RpcError {
    RpcError {
        code: -32000,
        message: error,
    }
}

fn configuration_view(entry: RunConfigurationEntry) -> Value {
    let configuration = entry.configuration;
    json!({
        "id": configuration.id,
        "name": configuration.name,
        "executable": configuration.executable,
        "args": configuration.args,
        "cwd": configuration.cwd,
        "environmentNames": configuration.env.keys().collect::<Vec<_>>(),
        "revision": entry.revision,
        "detected": entry.detected,
        "editable": !entry.detected,
    })
}

fn run_result(summary: String, content: Value) -> Result<Value, RpcError> {
    Ok(result::ok(summary, content))
}

async fn run_configurations(shared: &Shared) -> Result<Value, RpcError> {
    let backend = run_backend(shared)?;
    let lead = lead_key(shared)?;
    let catalog = backend
        .list_configurations(&lead)
        .await
        .map_err(tool_error)?;
    let saved = catalog
        .configurations
        .iter()
        .filter(|entry| !entry.detected)
        .count();
    let detected = catalog.configurations.len() - saved;
    let views: Vec<_> = catalog
        .configurations
        .into_iter()
        .map(configuration_view)
        .collect();
    run_result(
        format!("Workspace run configurations: {saved} saved, {detected} detected."),
        json!({"configurations": views, "revision": catalog.revision}),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunConfigurationIdArgs {
    id: String,
}

async fn run_configuration_read(
    shared: &Shared,
    args: RunConfigurationIdArgs,
) -> Result<Value, RpcError> {
    let backend = run_backend(shared)?;
    let lead = lead_key(shared)?;
    let entry = backend
        .read_configuration(&lead, &args.id)
        .await
        .map_err(tool_error)?
        .ok_or_else(|| {
            invalid("Run configuration was not found. Call run_configurations to refresh the list.")
        })?;
    run_result(
        format!("Run configuration {}.", entry.configuration.name),
        configuration_view(entry),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveRunConfigurationArgs {
    id: Option<String>,
    expected_revision: String,
    name: Option<String>,
    executable: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    /// Only keys in this map change. `null` removes one key. Omission keeps
    /// every existing value, which is never returned to the agent.
    env: Option<std::collections::BTreeMap<String, Option<String>>>,
}

async fn run_configuration_save(
    shared: &Shared,
    args: SaveRunConfigurationArgs,
    progress: Option<super::RunToolProgress>,
) -> Result<Value, RpcError> {
    let backend = run_backend(shared)?;
    let lead = lead_key(shared)?;
    let mut configuration = if let Some(id) = args.id.as_deref() {
        let entry = backend
            .read_configuration(&lead, id)
            .await
            .map_err(tool_error)?
            .ok_or_else(|| {
                invalid(
                    "Run configuration was not found. Call run_configurations to refresh the list.",
                )
            })?;
        if entry.detected {
            return Err(invalid("Detected tasks are read only. Save a copy first."));
        }
        if entry.revision != args.expected_revision {
            return Err(invalid(
                "Run configurations changed. Refresh the list and retry with its current revision.",
            ));
        }
        entry.configuration
    } else {
        if args.expected_revision.is_empty() {
            return Err(invalid(
                "expectedRevision from run_configurations is required",
            ));
        }
        if args.name.as_deref().is_none_or(str::is_empty)
            || args.executable.as_deref().is_none_or(str::is_empty)
        {
            return Err(invalid(
                "Creating a run configuration requires nonempty name and executable fields.",
            ));
        }
        RunConfiguration {
            id: String::new(),
            name: String::new(),
            executable: String::new(),
            args: Vec::new(),
            cwd: ".".into(),
            env: Default::default(),
        }
    };
    let has_patch = args.name.is_some()
        || args.executable.is_some()
        || args.args.is_some()
        || args.cwd.is_some()
        || args.env.is_some();
    if !has_patch {
        return Err(invalid(
            "Provide at least one configuration field to change.",
        ));
    }
    if let Some(name) = args.name {
        configuration.name = name;
    }
    if let Some(executable) = args.executable {
        configuration.executable = executable;
    }
    if let Some(arguments) = args.args {
        configuration.args = arguments;
    }
    if let Some(cwd) = args.cwd {
        configuration.cwd = cwd;
    }
    if let Some(environment) = args.env {
        for (key, value) in environment {
            match value {
                Some(value) => {
                    if is_redaction_marker(&value) {
                        return Err(invalid(
                            "Do not send redaction placeholders as environment values. Omit unchanged keys or send null to remove a key.",
                        ));
                    }
                    configuration.env.insert(key, value);
                }
                None => {
                    configuration.env.remove(&key);
                }
            }
        }
    }
    let entry = backend
        .save_configuration(&lead, configuration, args.expected_revision, progress)
        .await
        .map_err(tool_error)?;
    run_result(
        format!(
            "Saved run configuration {} after user approval.",
            entry.configuration.name
        ),
        configuration_view(entry),
    )
}

fn is_redaction_marker(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "<redacted>" | "[redacted]" | "(redacted)" | "[hidden]" | "<hidden>"
    ) || (normalized.chars().count() >= 4
        && normalized
            .chars()
            .all(|character| matches!(character, '*' | '•' | '●' | '█')))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunRevisionArgs {
    id: String,
    expected_revision: String,
}

async fn run_configuration_delete(
    shared: &Shared,
    args: RunRevisionArgs,
    progress: Option<super::RunToolProgress>,
) -> Result<Value, RpcError> {
    let backend = run_backend(shared)?;
    let lead = lead_key(shared)?;
    let value = backend
        .delete_configuration(&lead, &args.id, args.expected_revision, progress)
        .await
        .map_err(tool_error)?;
    run_result(
        "Deleted run configuration after user approval.".into(),
        value,
    )
}

async fn run_start(
    shared: &Shared,
    args: RunRevisionArgs,
    progress: Option<super::RunToolProgress>,
) -> Result<Value, RpcError> {
    let backend = run_backend(shared)?;
    let lead = lead_key(shared)?;
    let value = backend
        .start_run(&lead, &args.id, args.expected_revision, progress)
        .await
        .map_err(tool_error)?;
    run_result(
        "Started the saved run configuration after user approval.".into(),
        value,
    )
}

async fn run_stop(
    shared: &Shared,
    args: RunConfigurationIdArgs,
    progress: Option<super::RunToolProgress>,
) -> Result<Value, RpcError> {
    let backend = run_backend(shared)?;
    let lead = lead_key(shared)?;
    let value = backend
        .stop_run(&lead, &args.id, progress)
        .await
        .map_err(tool_error)?;
    run_result("Stopped the run after user approval.".into(), value)
}

async fn run_restart(
    shared: &Shared,
    args: RunConfigurationIdArgs,
    progress: Option<super::RunToolProgress>,
) -> Result<Value, RpcError> {
    let backend = run_backend(shared)?;
    let lead = lead_key(shared)?;
    let value = backend
        .restart_run(&lead, &args.id, progress)
        .await
        .map_err(tool_error)?;
    run_result(
        "Restarted the saved run configuration after user approval.".into(),
        value,
    )
}

async fn runs_list(shared: &Shared) -> Result<Value, RpcError> {
    let backend = run_backend(shared)?;
    let lead = lead_key(shared)?;
    let value = backend.list_runs(&lead).await.map_err(tool_error)?;
    run_result("Runs in the active workspace.".into(), value)
}

async fn run_output(shared: &Shared, args: RunConfigurationIdArgs) -> Result<Value, RpcError> {
    let backend = run_backend(shared)?;
    let lead = lead_key(shared)?;
    let value = backend
        .read_run_output(&lead, &args.id)
        .await
        .map_err(tool_error)?;
    run_result("Bounded output retained for this run.".into(), value)
}

const DELEGATION_INSTRUCTIONS: &str = "Delegate work to other agents in Span. list_agents shows every agent you can use: connected ones and installed ones that are ready to start. Delegate directly to any agent marked delegable; when it is not running, Span starts it in the background and delegate waits for the start. Do not ask the user to connect or open an agent first. delegate returns a taskId; poll get_result with waitSeconds up to 30 until status is completed or failed. Permission requests, questions and edit reviews from delegated agents go to the user, never to you.";

const RUN_TOOL_INSTRUCTIONS: &str = "Saved workspace run configuration tools are available. Run configuration changes, starts, stops and restarts require user approval. Environment values are hidden from configuration results. Raw run output is arbitrary and may contain anything the process prints.";

fn server_instructions(shared: &Shared) -> String {
    let mut instructions = match (
        shared.config.delegation_enabled,
        shared.config.run_tools.is_some(),
    ) {
        (true, true) => format!("{DELEGATION_INSTRUCTIONS} {RUN_TOOL_INSTRUCTIONS}"),
        (true, false) => DELEGATION_INSTRUCTIONS.into(),
        (false, true) => RUN_TOOL_INSTRUCTIONS.into(),
        (false, false) => String::new(),
    };
    if shared.config.editor_tools.is_some() {
        instructions.push_str(" Use read_buffer to read an existing workspace text file, then propose_edit with its exact normalized path, revision and readToken. propose_edit waits for the user's real review; rejection is an error. These tools never call Save; configured AutoSave may apply after acceptance. They never answer a permission or review decision.");
    }
    instructions
}

fn tool_definitions_for(shared: &Shared) -> Value {
    let mut tools = tool_definitions();
    if let Some(tools) = tools.as_array_mut() {
        if !shared.config.delegation_enabled {
            tools.retain(|tool| {
                tool.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.starts_with("run_"))
                    || tool.get("name").and_then(Value::as_str) == Some("runs_list")
            });
        }
        if shared.config.run_tools.is_some() {
            tools.extend(
                run_tool_definitions()
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
            );
        } else {
            tools.retain(|tool| {
                !tool
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.starts_with("run_"))
                    && tool.get("name").and_then(Value::as_str) != Some("runs_list")
            });
        }
        if shared
            .config
            .editor_tools
            .as_ref()
            .is_some_and(|access| access.allowed())
        {
            tools.extend(
                editor_tool_definitions()
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
            );
        }
    }
    tools
}

fn editor_tool_definitions() -> Value {
    json!([
        {"name":"read_buffer","title":"Read editor buffer","description":"Read an existing workspace UTF-8 text file from the current editor buffer, including unsaved edits. Returns normalized path, revision and a single-use readToken. Limited to 512 KiB. Does not create files.","inputSchema":{"type":"object","additionalProperties":false,"properties":{"path":{"type":"string","maxLength":4096}},"required":["path"]},"annotations":{"readOnlyHint":true,"openWorldHint":false}},
        {"name":"propose_edit","title":"Propose editor edit","description":"Propose replacement text for an existing file after read_buffer. Requires its exact normalized path, expectedRevision and single-use readToken. Waits for user review. Only accepted hunks enter the editor buffer; rejection, partial acceptance or conflict is an error. Never calls Save or approves its own change. Configured AutoSave may apply after acceptance.","inputSchema":{"type":"object","additionalProperties":false,"properties":{"path":{"type":"string","maxLength":4096},"content":{"type":"string","maxLength":524288},"expectedRevision":{"type":"integer","minimum":0},"readToken":{"type":"string","minLength":64,"maxLength":64}},"required":["path","content","expectedRevision","readToken"]},"annotations":{"readOnlyHint":false,"destructiveHint":false,"openWorldHint":false}}
    ])
}

fn list_agents(shared: &Shared) -> Result<Value, RpcError> {
    let control = shared.control()?;
    let max_depth = shared.config.policy.max_depth;
    let depth = control.depth().unwrap_or(0);
    let can_delegate = depth < max_depth;
    let background = shared.config.background.as_ref();
    let connected = control.agents();
    let mut agents = Vec::new();
    let mut lines = Vec::new();
    for agent in &connected {
        let reason = if !agent.open {
            Some("The agent process exited")
        } else if agent.features.is_none() {
            Some("The agent is still initializing")
        } else if !can_delegate {
            Some("Depth limit reached: this session cannot delegate")
        } else {
            None
        };
        let installed_id = background.and_then(|b| b.agent_for(&agent.connection_id));
        let hinted = hints_for(&agent.agent_name);
        lines.push(format!(
            "- {} (id {}{}){}{}",
            agent.agent_name,
            agent.connection_id,
            installed_id
                .as_deref()
                .map(|id| format!(", installed as {id}"))
                .unwrap_or_default(),
            if agent.connection_id == shared.lead_connection {
                ", your own agent"
            } else {
                ""
            },
            reason.map(|r| format!(": {r}")).unwrap_or_default(),
        ));
        agents.push(json!({
            "id": agent.connection_id,
            "name": agent.agent_name,
            "installedId": installed_id,
            "state": if agent.open { "connected" } else { "exited" },
            "connected": true,
            "isLead": agent.connection_id == shared.lead_connection,
            "reported": agent.features,
            "hinted": {"source": "span", "capabilities": hinted},
            "delegable": reason.is_none(),
            "reason": reason,
        }));
    }
    for installed in &shared.config.installed {
        let running = background.map(|b| b.state(&installed.id));
        let known = matches!(running, Some(BackgroundState::Connected(_)))
            || connected
                .iter()
                .any(|c| c.agent_name.eq_ignore_ascii_case(&installed.id));
        if known {
            continue;
        }
        let (state, delegable, reason) = match (&running, can_delegate) {
            (None, _) => (
                "not connected",
                false,
                "Installed but not running, and Span cannot start it for this session.".to_owned(),
            ),
            (Some(_), false) => (
                "ready to start",
                false,
                "Depth limit reached: this session cannot delegate".to_owned(),
            ),
            (Some(BackgroundState::Starting), true) => (
                "starting",
                true,
                "Span is starting it; delegate waits for the start.".to_owned(),
            ),
            (Some(BackgroundState::Unavailable(error)), true) => (
                "unavailable",
                true,
                format!("The last start failed ({error}); delegate tries again."),
            ),
            (Some(_), true) => (
                "ready to start",
                true,
                "Not running yet: delegate to it directly and Span starts it in the background. The user does not need to connect it.".to_owned(),
            ),
        };
        lines.push(format!("- {} (installed, {state}): {reason}", installed.id));
        agents.push(json!({
            "id": installed.id,
            "name": installed.id,
            "version": installed.version,
            "state": state,
            "connected": false,
            "isLead": false,
            "reported": Value::Null,
            "hinted": {"source": "span", "capabilities": hints_for(&installed.id)},
            "delegable": delegable,
            "reason": reason,
        }));
    }
    let structured = json!({
        "agents": agents,
        "maxDepth": max_depth,
        "callerDepth": depth,
        "canDelegate": can_delegate,
    });
    Ok(result::ok(
        format!(
            "Agents (reported capabilities come from the agent; hinted ones are maintained by Span):\n{}",
            lines.join("\n")
        ),
        structured,
    ))
}

fn compose_prompt(lead: &str, args: &DelegateArgs, save_to: Option<&str>) -> String {
    let mut text = args.task.trim().to_owned();
    if let Some(expect) = args.expect.as_deref().filter(|e| !e.trim().is_empty()) {
        text.push_str(&format!("\n\nExpected result: {}", expect.trim()));
    }
    if let Some(path) = save_to {
        text.push_str(&format!(
            "\n\nSave the result to the workspace file: {path}"
        ));
    }
    text.push_str(&format!(
        "\n\n(Delegated by {lead} through Span. Permission requests and edits go to the user for review.)"
    ));
    text
}

/// The running connection of an installed agent, started in the background
/// when needed. The UI sees `Starting` then `StartFinished` while Span waits
/// for the start. A failure comes back as the tool result for the lead.
async fn start_installed(
    shared: &Arc<Shared>,
    control: &AgentControl,
    installed: &InstalledAgent,
) -> Result<ConnectionInfo, Value> {
    let background = shared
        .config
        .background
        .as_ref()
        .expect("checked by the caller");
    let lead = control.caller().clone();
    let running = match background.state(&installed.id) {
        BackgroundState::Connected(connection) => Some(connection),
        _ => None,
    };
    if running.is_none() {
        shared.emit(DelegationEvent::Starting {
            lead: lead.clone(),
            agent_id: installed.id.clone(),
        });
    }
    let timeout = shared
        .second()
        .saturating_mul(shared.config.policy.launch_timeout_seconds.max(1) as u32);
    let started = background.ensure(installed, timeout).await;
    let target = started.as_ref().ok().and_then(|ensured| {
        control
            .agents()
            .into_iter()
            .find(|c| c.connection_id == ensured.connection_id)
    });
    let outcome = match (&started, target) {
        (Ok(ensured), Some(target)) => Ok((ensured.launched, target)),
        (Ok(_), None) => Err((
            FailureReason::AgentUnavailable,
            format!("{} started but its process exited", installed.id),
        )),
        (Err(error), _) => Err((start_failure(error), start_detail(&installed.id, error))),
    };
    if running.is_none() {
        let (connection_id, agent_name, launched, reason, detail) = match &outcome {
            Ok((launched, target)) => (
                Some(target.connection_id.clone()),
                Some(target.agent_name.clone()),
                *launched,
                None,
                None,
            ),
            Err((reason, detail)) => (None, None, false, Some(*reason), Some(detail.clone())),
        };
        shared.emit(DelegationEvent::StartFinished {
            lead,
            agent_id: installed.id.clone(),
            connection_id,
            agent_name,
            launched,
            reason,
            detail,
        });
    }
    outcome
        .map(|(_, target)| target)
        .map_err(|(reason, detail)| result::failure(&installed.id, reason, &detail))
}

/// Closed set reason for a failed background start.
fn start_failure(error: &str) -> FailureReason {
    match FailureReason::from_error(error) {
        FailureReason::Cancelled => FailureReason::AgentUnavailable,
        reason => reason,
    }
}

fn start_detail(agent: &str, error: &str) -> String {
    let lower = error.to_lowercase();
    if lower.contains("executable was not found") || lower.contains("no such file") {
        format!("{agent} is not installed where Span can run it: {error}")
    } else if lower.contains("timed out") {
        format!("{agent} did not start in time: {error}")
    } else if start_failure(error) == FailureReason::AuthRequired {
        format!("{agent} needs the user to sign in first: {error}")
    } else {
        format!("Span could not start {agent}: {error}")
    }
}

async fn delegate(shared: &Arc<Shared>, args: DelegateArgs) -> Result<Value, RpcError> {
    let control = shared.control()?;
    if args.task.trim().is_empty() {
        return Err(invalid("task must not be empty"));
    }
    let max_depth = shared.config.policy.max_depth;
    let depth = control.depth().unwrap_or(0);
    if depth >= max_depth {
        return Ok(result::failure(
            &args.agent,
            FailureReason::DepthExceeded,
            &format!(
                "this session is at depth {depth} and the delegation depth limit is {max_depth}; the user can raise it in Span's agent settings"
            ),
        ));
    }
    let connected = control.agents();
    let by_id: Vec<_> = connected
        .iter()
        .filter(|c| c.connection_id == args.agent)
        .collect();
    let by_name: Vec<_> = connected
        .iter()
        .filter(|c| c.agent_name.eq_ignore_ascii_case(&args.agent))
        .collect();
    let installed = shared
        .config
        .installed
        .iter()
        .find(|i| i.id.eq_ignore_ascii_case(&args.agent));
    let target = match (by_id.as_slice(), installed, by_name.as_slice()) {
        ([one], _, _) => (*one).clone(),
        ([], Some(installed), _) if shared.config.background.is_some() => {
            match start_installed(shared, &control, installed).await {
                Ok(target) => target,
                Err(failure) => return Ok(failure),
            }
        }
        ([], _, [one]) => (*one).clone(),
        ([], _, []) => {
            let detail = if installed.is_some() {
                "the agent is installed but not connected, and Span cannot start it for this session"
            } else {
                "no connected or installed agent has this id or name; call list_agents"
            };
            return Ok(result::failure(
                &args.agent,
                FailureReason::AgentUnavailable,
                detail,
            ));
        }
        _ => {
            return Err(invalid(
                "Several agents match this name. Pass the id from list_agents.",
            ));
        }
    };
    if !target.open || target.features.is_none() {
        return Ok(result::failure(
            &target.agent_name,
            FailureReason::AgentUnavailable,
            "the agent process exited or is still initializing",
        ));
    }
    let mut attachments = Vec::new();
    for path in &args.attachments {
        let (absolute, shown) = inside_workspace(&shared.root, path).map_err(invalid)?;
        if !absolute.exists() {
            return Err(invalid(format!("Attachment does not exist: {shown}")));
        }
        attachments.push(PromptAttachment::ResourceLink {
            uri: result::file_uri(&absolute),
            name: shown.clone(),
            mime_type: Some(result::mime_type(&shown).to_owned()),
            description: None,
        });
    }
    let save_to = match &args.save_to {
        Some(path) => Some(inside_workspace(&shared.root, path).map_err(invalid)?.1),
        None => None,
    };
    let child = match control
        .delegate_limited(&target.connection_id, max_depth)
        .await
    {
        Ok(child) => child,
        Err(error) => {
            return Ok(result::failure(
                &target.agent_name,
                FailureReason::from_error(&error),
                &error,
            ));
        }
    };
    let budget = shared
        .config
        .policy
        .budget
        .narrowed(args.budget.as_ref().unwrap_or(&BudgetRequest::default()));
    shared
        .registry
        .add_delegation(child.clone(), target.agent_name.clone(), budget.clone());
    let weak = Arc::downgrade(shared);
    let gone = child.clone();
    let _ = control.on_session_end(
        &child,
        Box::new(move || {
            if let Some(shared) = weak.upgrade() {
                shared.registry.session_gone(&gone);
            }
        }),
    );
    let text = compose_prompt(&shared.lead_name, &args, save_to.as_deref());
    // The UI learns which child belongs to which task before the child's
    // prompt is queued, so no child event can arrive first.
    let announce = |task_id: &str| {
        shared.emit(DelegationEvent::Delegated {
            lead: control.caller().clone(),
            child: child.clone(),
            task_id: task_id.to_owned(),
            agent_name: target.agent_name.clone(),
        });
    };
    let task_id = match shared.run_task(&control, &child, save_to, text, attachments, announce) {
        Ok(id) => id,
        Err(error) => {
            return Ok(result::failure(
                &target.agent_name,
                FailureReason::from_error(&error),
                &error,
            ));
        }
    };
    Ok(result::ok(
        format!(
            "Delegated to {} as {task_id}. Poll get_result with this taskId.",
            target.agent_name
        ),
        json!({
            "status": "running",
            "taskId": task_id,
            "agent": target.agent_name,
            "connectionId": child.connection_id,
            "sessionId": child.session_id,
            "budget": budget,
        }),
    ))
}

fn task_result(shared: &Shared, task_id: &str) -> Result<Value, RpcError> {
    let view = shared
        .registry
        .view(task_id, shared.second())
        .ok_or_else(|| invalid(format!("Unknown taskId: {task_id}")))?;
    let task = &view.task;
    let artifacts = shared.artifacts(task);
    let progress = (!task.status.finished()).then(|| {
        json!({
            "activity": task.activity,
            "events": task.events,
            "elapsedSeconds": view.usage.elapsed_seconds,
            "waitingForUser": view.waiting_for_user > 0,
        })
    });
    Ok(result::tool_result(ResultInput {
        task_id,
        status: task.status.as_str(),
        agent: &task.agent,
        connection_id: &task.key.connection_id,
        session_id: &task.key.session_id,
        stop_reason: task.stop_reason.as_deref(),
        reason: task.reason,
        detail: task.detail.as_deref(),
        text: &task.text,
        artifacts,
        usage: Some(view.usage.clone()),
        spent_tokens: view.spent_tokens,
        max_tokens: view.max_tokens,
        progress,
        lead_accepts_images: shared.lead_accepts_images,
        image_preview_cap: shared.config.policy.image_preview_bytes,
    }))
}

async fn get_result(
    shared: &Arc<Shared>,
    args: ResultArgs,
    mut progress: Option<Progress>,
) -> Result<Value, RpcError> {
    let policy = &shared.config.policy;
    let wait = args
        .wait_seconds
        .unwrap_or(0.0)
        .clamp(0.0, policy.max_wait_seconds as f64);
    let second = policy.second;
    let deadline = Instant::now() + second.mul_f64(wait);
    let interval = second * policy.progress_interval_seconds.max(1) as u32;
    let mut changes = shared.registry.watch();
    let mut next_progress = Instant::now();
    loop {
        let view = shared
            .registry
            .view(&args.task_id, second)
            .ok_or_else(|| invalid(format!("Unknown taskId: {}", args.task_id)))?;
        let now = Instant::now();
        if view.task.status.finished() || now >= deadline {
            break;
        }
        if let Some(progress) = progress.as_mut() {
            if now >= next_progress {
                let waiting = if view.waiting_for_user > 0 {
                    ", waiting for the user"
                } else {
                    ""
                };
                progress.send(format!(
                    "{}: {} ({} s, {} updates{waiting})",
                    view.task.agent,
                    view.task.activity,
                    view.usage.elapsed_seconds,
                    view.task.events
                ));
                next_progress = now + interval;
            }
        }
        let wake = if progress.is_some() {
            deadline.min(next_progress)
        } else {
            deadline
        };
        tokio::select! {
            _ = changes.changed() => {}
            _ = tokio::time::sleep_until(wake.into()) => {}
        }
    }
    task_result(shared, &args.task_id)
}

fn message(shared: &Arc<Shared>, args: MessageArgs) -> Result<Value, RpcError> {
    let control = shared.control()?;
    if args.text.trim().is_empty() {
        return Err(invalid("text must not be empty"));
    }
    let key = shared
        .registry
        .resolve(&args.session_id, args.connection_id.as_deref())
        .map_err(invalid)?;
    let agent = control
        .session(&key)
        .map(|s| s.agent_name)
        .unwrap_or_default();
    let task_id = match shared.run_task(&control, &key, None, args.text, Vec::new(), |_| {}) {
        Ok(id) => id,
        Err(error) if error.contains("turns") || error.starts_with("budget spent") => {
            return Ok(result::failure(
                &agent,
                FailureReason::BudgetExceeded,
                &error,
            ));
        }
        Err(error) => {
            return Ok(result::failure(
                &agent,
                FailureReason::from_error(&error),
                &error,
            ));
        }
    };
    let status = shared
        .registry
        .view(&task_id, shared.second())
        .map(|v| v.task.status)
        .unwrap_or(TaskStatus::Queued);
    Ok(result::ok(
        format!(
            "Message sent to {agent} as {task_id} ({}).",
            status.as_str()
        ),
        json!({
            "status": status.as_str(),
            "taskId": task_id,
            "agent": agent,
            "connectionId": key.connection_id,
            "sessionId": key.session_id,
        }),
    ))
}

fn cancel(shared: &Arc<Shared>, args: CancelArgs) -> Result<Value, RpcError> {
    let control = shared.control()?;
    let key = match (&args.task_id, &args.session_id) {
        (Some(task), _) => shared
            .registry
            .task_key(task)
            .ok_or_else(|| invalid(format!("Unknown taskId: {task}")))?,
        (None, Some(session)) => shared
            .registry
            .resolve(session, args.connection_id.as_deref())
            .map_err(invalid)?,
        (None, None) => return Err(invalid("Pass taskId or sessionId")),
    };
    shared.registry.stopping(
        &key,
        FailureReason::Cancelled,
        "cancelled by the lead".into(),
    );
    control.cancel(&key).map_err(|e| RpcError {
        code: -32603,
        message: e,
    })?;
    Ok(result::ok(
        format!(
            "Stopped session {} and everything it delegated.",
            key.session_id
        ),
        json!({"cancelled": true, "connectionId": key.connection_id, "sessionId": key.session_id}),
    ))
}

fn record_decision(shared: &Arc<Shared>, args: DecisionArgs) -> Result<Value, RpcError> {
    let control = shared.control()?;
    if args.chosen.trim().is_empty() || args.why.trim().is_empty() {
        return Err(invalid("chosen and why must not be empty"));
    }
    let decision = DecisionRecord {
        id: format!("decision-{}", shared.registry.decision_count() + 1),
        chosen: args.chosen,
        why: args.why,
        alternatives: args.alternatives,
        recorded_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    };
    shared.registry.record_decision(decision.clone());
    shared.emit(DelegationEvent::Decision {
        lead: control.caller().clone(),
        decision: decision.clone(),
    });
    Ok(result::ok(
        format!("Recorded decision {}.", decision.id),
        json!({"decisionId": decision.id, "decision": decision}),
    ))
}

/// The tools the server lists, with their JSON schemas.
pub fn tool_definitions() -> Value {
    let session_ref = json!({
        "sessionId": {"type": "string", "description": "Session id from delegate or get_result."},
        "connectionId": {"type": "string", "description": "Needed only when two agents use the same session id."},
    });
    json!([
        {
            "name": "list_agents",
            "title": "List agents",
            "description": "List the agents you can delegate to: connected agents and installed agents Span starts on demand (`state` is connected, ready to start, starting or unavailable; `delegable` says whether delegate can use it now). You can delegate to a ready to start agent directly; the user does not need to connect it. `reported` capabilities come from the agent's ACP initialize; `hinted` capabilities are maintained by Span and are not reported by the agent.",
            "inputSchema": {"type": "object", "additionalProperties": false},
            "annotations": {"readOnlyHint": true, "openWorldHint": false},
        },
        {
            "name": "delegate",
            "title": "Delegate a task",
            "description": "Start a task on another agent in a new child session. The agent may be connected or only installed: Span starts an installed agent in the background first (this call then waits for the start, up to about 25 seconds) and never needs the user to connect it. Returns a taskId once the child session exists; poll get_result. The child's permission requests, questions and edits go to the user, not to you. Children cannot delegate further unless the user raised the depth limit.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "agent": {"type": "string", "description": "Agent id or name from list_agents, connected or installed."},
                    "task": {"type": "string", "description": "What the child should do."},
                    "attachments": {"type": "array", "items": {"type": "string"}, "description": "Workspace relative files sent as resource links."},
                    "expect": {"type": "string", "description": "What you expect back, for example a summary, a diff or an image."},
                    "saveTo": {"type": "string", "description": "Workspace relative file the child should write its result to; reported as an artifact."},
                    "budget": {
                        "type": "object",
                        "additionalProperties": false,
                        "description": "Lower the per-delegation budget. Values above Span's limits are capped.",
                        "properties": {
                            "maxTurns": {"type": "integer", "minimum": 1},
                            "maxTokens": {"type": "integer", "minimum": 1},
                            "timeoutSeconds": {"type": "integer", "minimum": 1},
                            "maxCost": {"type": "number", "minimum": 0},
                        },
                    },
                },
                "required": ["agent", "task"],
                "additionalProperties": false,
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": true},
        },
        {
            "name": "get_result",
            "title": "Get a task result",
            "description": "Status of a task. Waits up to waitSeconds (at most 30) for it to finish and sends progress notifications while waiting when the call has a progressToken. Returns status running or queued with progress, or the final result: a summary, resource links for files, and structuredContent {status, agent, sessionId, stopReason, artifacts, usage}. Failures set isError with a reason.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskId": {"type": "string"},
                    "waitSeconds": {"type": "number", "minimum": 0, "maximum": 30},
                },
                "required": ["taskId"],
                "additionalProperties": false,
            },
            "outputSchema": {
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["queued", "running", "completed", "failed"]},
                    "taskId": {"type": "string"},
                    "agent": {"type": "string"},
                    "connectionId": {"type": "string"},
                    "sessionId": {"type": "string"},
                    "stopReason": {"type": ["string", "null"]},
                    "reason": {"type": "string", "enum": FailureReason::ALL.iter().map(|r| r.as_str()).collect::<Vec<_>>()},
                    "detail": {"type": "string"},
                    "artifacts": {"type": "array", "items": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string"},
                            "mimeType": {"type": "string"},
                            "bytes": {"type": "integer"},
                            "sha256": {"type": "string"},
                            "source": {"type": "string", "enum": ["buffer", "disk"]},
                        },
                        "required": ["path", "mimeType", "bytes", "sha256"],
                    }},
                    "usage": {"type": "object"},
                    "progress": {"type": "object"},
                },
                "required": ["status", "taskId", "agent", "sessionId", "stopReason", "artifacts"],
            },
            "annotations": {"readOnlyHint": true, "openWorldHint": false},
        },
        {
            "name": "message",
            "title": "Message a child",
            "description": "Send a follow-up to a session you delegated. It queues behind the child's current turn and returns a new taskId immediately.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionId": session_ref["sessionId"],
                    "connectionId": session_ref["connectionId"],
                    "text": {"type": "string"},
                },
                "required": ["sessionId", "text"],
                "additionalProperties": false,
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": true},
        },
        {
            "name": "cancel",
            "title": "Cancel a child",
            "description": "Stop a session you delegated, and everything it delegated. Pass taskId or sessionId.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskId": {"type": "string"},
                    "sessionId": session_ref["sessionId"],
                    "connectionId": session_ref["connectionId"],
                },
                "additionalProperties": false,
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false},
        },
        {
            "name": "record_decision",
            "title": "Record a decision",
            "description": "Record a decision you made so Span can show it to the user as a decision card. Has no other effect.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "chosen": {"type": "string"},
                    "why": {"type": "string"},
                    "alternatives": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["chosen", "why"],
                "additionalProperties": false,
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false},
        },
    ])
}

fn run_tool_definitions() -> Value {
    let config_id = json!({"id": {"type": "string", "description": "Run process ID from runs_list or run configuration ID from run_configurations, as appropriate."}});
    json!([
        {
            "name": "run_configurations",
            "title": "List run configurations",
            "description": "List saved and detected workspace run configurations without executing them. Environment values are never returned. Use the catalog revision for create, save, delete, start and restart calls.",
            "inputSchema": {"type": "object", "additionalProperties": false},
            "annotations": {"readOnlyHint": true, "openWorldHint": false},
        },
        {
            "name": "run_configuration_read",
            "title": "Read a run configuration",
            "description": "Read one saved or detected configuration. Environment values are omitted and only variable names are returned.",
            "inputSchema": {"type": "object", "properties": config_id, "required": ["id"], "additionalProperties": false},
            "annotations": {"readOnlyHint": true, "openWorldHint": false},
        },
        {
            "name": "run_configuration_save",
            "title": "Create or edit a run configuration",
            "description": "Propose a saved configuration change. For an edit, pass the id and expectedRevision from the current catalog. For a new configuration, omit id. Omitted fields are preserved, including environment values. In env, set a value to null to remove that key. New values can be literals or ${env:NAME} references and are shown to the user for approval; do not send redaction placeholders. Span shows the proposed command and asks the user before saving. Environment references in command fields are resolved only for the local approval preview and execution; their expanded values are not returned to this tool.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "expectedRevision": {"type": "string"},
                    "name": {"type": "string"},
                    "executable": {"type": "string"},
                    "args": {"type": "array", "items": {"type": "string"}},
                    "cwd": {"type": "string"},
                    "env": {"type": "object", "additionalProperties": {"type": ["string", "null"]}},
                },
                "required": ["expectedRevision"],
                "additionalProperties": false,
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false},
        },
        {
            "name": "run_configuration_delete",
            "title": "Delete a run configuration",
            "description": "Delete a saved configuration after user approval. Detected tasks cannot be deleted.",
            "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "expectedRevision": {"type": "string"}}, "required": ["id", "expectedRevision"], "additionalProperties": false},
            "annotations": {"readOnlyHint": false, "destructiveHint": true, "openWorldHint": false},
        },
        {
            "name": "run_start",
            "title": "Run a saved configuration",
            "description": "Start only a saved configuration by id. Span shows its configured executable, arguments and working directory and asks the user before launching. Execution uses direct argv, no implicit shell.",
            "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "expectedRevision": {"type": "string"}}, "required": ["id", "expectedRevision"], "additionalProperties": false},
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false},
        },
        {
            "name": "run_stop",
            "title": "Stop a run",
            "description": "Stop a running process from the active workspace after user approval. Pass its run process id from runs_list.",
            "inputSchema": {"type": "object", "properties": config_id, "required": ["id"], "additionalProperties": false},
            "annotations": {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false},
        },
        {
            "name": "run_restart",
            "title": "Restart a saved configuration",
            "description": "Stop this process and restart it with the same saved command after one user approval. Pass a run process id from runs_list.",
            "inputSchema": {"type": "object", "properties": config_id, "required": ["id"], "additionalProperties": false},
            "annotations": {"readOnlyHint": false, "destructiveHint": true, "openWorldHint": false},
        },
        {
            "name": "runs_list",
            "title": "List runs",
            "description": "List run process status for the active workspace.",
            "inputSchema": {"type": "object", "additionalProperties": false},
            "annotations": {"readOnlyHint": true, "openWorldHint": false},
        },
        {
            "name": "run_output",
            "title": "Read run output",
            "description": "Read bounded retained stdout and stderr text for a run in the active workspace. Process output is arbitrary and may contain secrets printed by that process.",
            "inputSchema": {"type": "object", "properties": config_id, "required": ["id"], "additionalProperties": false},
            "annotations": {"readOnlyHint": true, "openWorldHint": false},
        },
    ])
}

/// Random hex for bearer tokens, from the OS CSPRNG through `getrandom`.
/// There is no fallback: when the OS cannot supply randomness the server
/// does not start.
fn random_hex(bytes: usize) -> Result<String, String> {
    let mut out = vec![0u8; bytes];
    getrandom::fill(&mut out).map_err(|error| {
        format!("span-agents could not read the OS random source for its token: {error}")
    })?;
    Ok(out.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_long_and_distinct() {
        let a = random_hex(32).unwrap();
        let b = random_hex(32).unwrap();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(tokens_match(&a, &a.clone()));
        assert!(!tokens_match(&a, &b));
        assert!(!tokens_match(&a, &a[..63]));
    }

    #[test]
    fn every_tool_has_an_object_input_schema() {
        let tools = tool_definitions();
        let names: Vec<&str> = tools
            .as_array()
            .unwrap()
            .iter()
            .map(|t| {
                assert_eq!(t["inputSchema"]["type"], "object");
                t["name"].as_str().unwrap()
            })
            .collect();
        assert_eq!(
            names,
            [
                "list_agents",
                "delegate",
                "get_result",
                "message",
                "cancel",
                "record_decision"
            ]
        );
    }
}
