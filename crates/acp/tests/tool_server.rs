//! Process and HTTP level tests for the span-agents MCP tool server (#52,
//! #53). Agents are real Node subprocesses (tests/fixtures/worker.mjs); the
//! MCP client is reqwest over real loopback HTTP, or the lead fixture
//! process itself using Node's fetch.
//!
//! Time scaling: tests that need minutes long children set
//! `ToolPolicy::second` to 10 ms, so one policy second (the unit of
//! `waitSeconds`, budgets and progress intervals) is 10 ms of real time.
use serde_json::{json, Value};
use span_acp::tools::{
    DelegationEvent, RunConfigurationEntry, RunToolBackend, RunToolCatalog, RunToolFuture,
    ToolPolicy, ToolServer, ToolServerConfig,
};
use span_acp::{AgentCommand, AgentEvent, SessionEvent, SessionKey, SessionManager, SessionOrigin};
use span_core::{CoreWorkspace, RunConfiguration};
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::mpsc,
};

struct Harness {
    directory: tempfile::TempDir,
    workspace: Arc<Mutex<CoreWorkspace>>,
    manager: SessionManager,
    events: mpsc::UnboundedReceiver<SessionEvent>,
    tool_events: Arc<Mutex<Vec<DelegationEvent>>>,
}

fn harness() -> Harness {
    let directory = tempfile::tempdir().expect("temporary workspace");
    std::fs::create_dir(directory.path().join("out")).unwrap();
    let workspace = Arc::new(Mutex::new(
        CoreWorkspace::open(directory.path())
            .expect("workspace")
            .with_user_settings(None),
    ));
    let (tx, events) = mpsc::unbounded_channel();
    let manager = SessionManager::new(Arc::new(move |event| {
        let _ = tx.send(event);
    }));
    Harness {
        directory,
        workspace,
        manager,
        events,
        tool_events: Arc::default(),
    }
}

fn worker(flags: &[&str]) -> AgentCommand {
    let mut args = vec![format!(
        "{}/tests/fixtures/worker.mjs",
        env!("CARGO_MANIFEST_DIR")
    )];
    args.extend(flags.iter().map(|f| f.to_string()));
    AgentCommand {
        command: "node".into(),
        args,
        env: BTreeMap::new(),
    }
}

fn scaled() -> ToolPolicy {
    ToolPolicy {
        second: Duration::from_millis(10),
        ..ToolPolicy::default()
    }
}

impl Harness {
    async fn connect(&self, flags: &[&str]) -> String {
        self.manager
            .connect(
                worker(flags),
                self.directory.path().to_string_lossy().into_owned(),
                self.workspace.clone(),
                None,
            )
            .await
            .expect("start fixture agent")
    }

    fn config(&self, policy: ToolPolicy) -> ToolServerConfig {
        let sink = self.tool_events.clone();
        ToolServerConfig {
            workspace: self.workspace.clone(),
            policy,
            delegation_enabled: true,
            run_tools: None,
            installed: vec![span_acp::InstalledAgent {
                id: "gemini-cli".into(),
                version: "1.0.0".into(),
                launch: worker(&[]),
            }],
            background: None,
            events: Some(Arc::new(move |event| sink.lock().unwrap().push(event))),
        }
    }

    /// A lead session with a bound server, started in the order the desktop
    /// would: server first (its entry goes into session/new), then bind.
    async fn lead(&self, connection: &str, policy: ToolPolicy) -> (SessionKey, ToolServer) {
        self.lead_with_config(connection, self.config(policy)).await
    }

    async fn lead_with_config(
        &self,
        connection: &str,
        config: ToolServerConfig,
    ) -> (SessionKey, ToolServer) {
        let server = ToolServer::start(&self.manager, connection, config)
            .await
            .expect("start span-agents");
        let lead = self
            .manager
            .open_session_with(
                connection,
                None,
                SessionOrigin::User,
                vec![server.mcp_server_json()],
            )
            .await
            .expect("lead session");
        server.bind(&self.manager, lead.clone()).expect("bind lead");
        (lead, server)
    }

    async fn next(&mut self, matches: impl Fn(&SessionEvent) -> bool) -> SessionEvent {
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let event = self.events.recv().await.expect("event stream closed");
                if matches(&event) {
                    return event;
                }
            }
        })
        .await
        .expect("matching event timed out")
    }
}

#[derive(Default)]
struct FakeRunTools {
    entries: Arc<Mutex<Vec<RunConfigurationEntry>>>,
    hold_start: bool,
    wait_started: Arc<AtomicBool>,
    wait_dropped: Arc<AtomicBool>,
}
impl FakeRunTools {
    fn seeded() -> Self {
        Self {
            entries: Arc::new(Mutex::new(vec![RunConfigurationEntry {
                configuration: RunConfiguration {
                    id: "build".into(),
                    name: "Build".into(),
                    executable: "cargo".into(),
                    args: vec!["check".into()],
                    cwd: ".".into(),
                    env: BTreeMap::from([("TOKEN".into(), "literal-secret-value".into())]),
                },
                revision: "revision-1".into(),
                detected: false,
            }])),
            ..Self::default()
        }
    }

    fn pending_start() -> Self {
        Self {
            hold_start: true,
            ..Self::seeded()
        }
    }
}
impl RunToolBackend for FakeRunTools {
    fn list_configurations<'a>(
        &'a self,
        _lead: &'a SessionKey,
    ) -> RunToolFuture<'a, RunToolCatalog> {
        let entries = self.entries.lock().unwrap().clone();
        Box::pin(async move {
            Ok(RunToolCatalog {
                configurations: entries,
                revision: "revision-1".into(),
            })
        })
    }
    fn read_configuration<'a>(
        &'a self,
        _lead: &'a SessionKey,
        id: &'a str,
    ) -> RunToolFuture<'a, Option<RunConfigurationEntry>> {
        let entry = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .find(|entry| entry.configuration.id == id)
            .cloned();
        Box::pin(async move { Ok(entry) })
    }
    fn save_configuration<'a>(
        &'a self,
        _lead: &'a SessionKey,
        configuration: RunConfiguration,
        expected_revision: String,
        _progress: Option<span_acp::tools::RunToolProgress>,
    ) -> RunToolFuture<'a, RunConfigurationEntry> {
        let store = self.entries.clone();
        Box::pin(async move {
            assert_eq!(expected_revision, "revision-1");
            let mut store = store.lock().unwrap();
            let entry = RunConfigurationEntry {
                configuration,
                revision: "revision-2".into(),
                detected: false,
            };
            if let Some(previous) = store
                .iter_mut()
                .find(|previous| previous.configuration.id == entry.configuration.id)
            {
                *previous = entry.clone();
            }
            Ok(entry)
        })
    }
    fn delete_configuration<'a>(
        &'a self,
        _lead: &'a SessionKey,
        id: &'a str,
        _expected_revision: String,
        _progress: Option<span_acp::tools::RunToolProgress>,
    ) -> RunToolFuture<'a, Value> {
        Box::pin(async move { Ok(json!({"deleted": true, "id": id})) })
    }
    fn start_run<'a>(
        &'a self,
        _lead: &'a SessionKey,
        id: &'a str,
        _expected_revision: String,
        progress: Option<span_acp::tools::RunToolProgress>,
    ) -> RunToolFuture<'a, Value> {
        let should_hold = self.hold_start;
        let started = self.wait_started.clone();
        let dropped = self.wait_dropped.clone();
        Box::pin(async move {
            if should_hold {
                struct DropProbe(Arc<AtomicBool>);
                impl Drop for DropProbe {
                    fn drop(&mut self) {
                        self.0.store(true, Ordering::Release);
                    }
                }
                let _probe = DropProbe(dropped);
                if let Some(progress) = progress.clone() {
                    progress("Waiting for user approval in Span".into());
                    let later = progress.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        later("Still waiting for user approval in Span".into());
                    });
                }
                started.store(true, Ordering::Release);
                return std::future::pending::<Result<Value, String>>().await;
            }
            Ok(json!({"id": "process-1", "configurationId": id, "status": "running"}))
        })
    }
    fn stop_run<'a>(
        &'a self,
        _lead: &'a SessionKey,
        id: &'a str,
        _progress: Option<span_acp::tools::RunToolProgress>,
    ) -> RunToolFuture<'a, Value> {
        Box::pin(async move { Ok(json!({"id": id, "status": "exited"})) })
    }
    fn restart_run<'a>(
        &'a self,
        _lead: &'a SessionKey,
        id: &'a str,
        _progress: Option<span_acp::tools::RunToolProgress>,
    ) -> RunToolFuture<'a, Value> {
        Box::pin(async move { Ok(json!({"id": id, "status": "running"})) })
    }
    fn list_runs<'a>(&'a self, _lead: &'a SessionKey) -> RunToolFuture<'a, Value> {
        Box::pin(async { Ok(json!([{"id": "process-1", "status": "running"}])) })
    }
    fn read_run_output<'a>(
        &'a self,
        _lead: &'a SessionKey,
        id: &'a str,
    ) -> RunToolFuture<'a, Value> {
        Box::pin(async move { Ok(json!({"id": id, "text": "ok", "truncated": false})) })
    }
}

/// A minimal MCP Streamable HTTP client over reqwest.
struct Client {
    http: reqwest::Client,
    url: String,
    token: String,
    next: u64,
}

struct Reply {
    response: Value,
    notifications: Vec<Value>,
}

fn token_of(server: &ToolServer) -> String {
    let entry = server.mcp_server_json();
    assert_eq!(entry["type"], "http");
    assert_eq!(entry["name"], "span-agents");
    let header = &entry["headers"][0];
    assert_eq!(header["name"], "Authorization");
    header["value"]
        .as_str()
        .unwrap()
        .strip_prefix("Bearer ")
        .unwrap()
        .to_owned()
}

impl Client {
    fn new(server: &ToolServer) -> Self {
        Self {
            http: reqwest::Client::new(),
            url: server.url().to_owned(),
            token: token_of(server),
            next: 0,
        }
    }

    async fn rpc(&mut self, method: &str, params: Value) -> Reply {
        self.next += 1;
        let body = json!({"jsonrpc": "2.0", "id": self.next, "method": method, "params": params});
        let response = self
            .http
            .post(&self.url)
            .header("authorization", format!("Bearer {}", self.token))
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", "2025-06-18")
            .json(&body)
            .send()
            .await
            .expect("request");
        assert_eq!(response.status(), 200);
        let sse = response
            .headers()
            .get("content-type")
            .is_some_and(|v| v.to_str().unwrap().starts_with("text/event-stream"));
        let text = response.text().await.unwrap();
        if !sse {
            return Reply {
                response: serde_json::from_str(&text).unwrap(),
                notifications: Vec::new(),
            };
        }
        let mut messages: Vec<Value> = text
            .split("\n\n")
            .filter_map(|event| event.lines().find_map(|l| l.strip_prefix("data: ")))
            .map(|data| serde_json::from_str(data).unwrap())
            .collect();
        let response = messages.pop().expect("final response");
        Reply {
            response,
            notifications: messages,
        }
    }

    async fn tool(&mut self, name: &str, arguments: Value) -> Value {
        let reply = self
            .rpc("tools/call", json!({"name": name, "arguments": arguments}))
            .await;
        reply.response["result"].clone()
    }

    /// `get_result` with a progress token, so progress arrives over SSE.
    async fn wait(&mut self, task: &str, seconds: u64, token: &str) -> Reply {
        self.rpc(
            "tools/call",
            json!({
                "name": "get_result",
                "arguments": {"taskId": task, "waitSeconds": seconds},
                "_meta": {"progressToken": token},
            }),
        )
        .await
    }

    async fn until_finished(&mut self, task: &str) -> Value {
        for _ in 0..200 {
            let result = self
                .tool("get_result", json!({"taskId": task, "waitSeconds": 30}))
                .await;
            let status = result["structuredContent"]["status"].as_str().unwrap();
            if status == "completed" || status == "failed" {
                return result;
            }
        }
        panic!("task {task} never finished");
    }
}

fn structured(result: &Value) -> &Value {
    &result["structuredContent"]
}

#[tokio::test]
async fn tools_list_and_protocol_basics_over_real_http() {
    let h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let (_lead, server) = h.lead(&lead_connection, scaled()).await;
    assert!(server.url().starts_with("http://127.0.0.1:"));
    assert!(server.url().ends_with("/mcp"));
    assert!(!format!("{server:?}").contains(&token_of(&server)));
    let mut client = Client::new(&server);

    let init = client
        .rpc(
            "initialize",
            json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}),
        )
        .await
        .response;
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(init["result"]["serverInfo"]["name"], "span-agents");
    assert!(init["result"]["capabilities"]["tools"].is_object());

    let tools = client.rpc("tools/list", json!({})).await.response;
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
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
    assert_eq!(
        client.rpc("ping", json!({})).await.response["result"],
        json!({})
    );
    assert_eq!(
        client.rpc("resources/list", json!({})).await.response["error"]["code"],
        -32601
    );
    assert_eq!(
        client.tool("no_such_tool", json!({})).await,
        Value::Null,
        "unknown tools are protocol errors"
    );

    let http = reqwest::Client::new();
    let auth = format!("Bearer {}", client.token);
    let get = http
        .get(server.url())
        .header("authorization", &auth)
        .send()
        .await
        .unwrap();
    assert_eq!(get.status(), 405);
    let notification = http
        .post(server.url())
        .header("authorization", &auth)
        .header("accept", "application/json, text/event-stream")
        .json(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        .send()
        .await
        .unwrap();
    assert_eq!(notification.status(), 202);
    let modern = http
        .post(server.url())
        .header("authorization", &auth)
        .header("mcp-protocol-version", "2026-07-28")
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
        .send()
        .await
        .unwrap();
    assert_eq!(modern.status(), 400);

    let agents = client.tool("list_agents", json!({})).await;
    let list = structured(&agents)["agents"].as_array().unwrap().clone();
    let me = list.iter().find(|a| a["name"] == "lead").unwrap();
    assert_eq!(me["isLead"], true);
    assert_eq!(me["reported"]["mcpHttp"], true);
    let installed = list.iter().find(|a| a["name"] == "gemini-cli").unwrap();
    assert_eq!(installed["connected"], false);
    assert_eq!(installed["delegable"], false);
    assert_eq!(structured(&agents)["maxDepth"], 1);
    assert_eq!(structured(&agents)["canDelegate"], true);
}

#[tokio::test]
async fn run_tools_are_separately_gated_and_dispatch_over_real_mcp_calls() {
    let h = harness();
    let connection = h.connect(&["--name=run-lead", "--mcp-http"]).await;
    let backend = Arc::new(FakeRunTools::seeded());
    let mut config = h.config(scaled());
    config.delegation_enabled = false;
    config.run_tools = Some(backend.clone());
    let (_lead, server) = h.lead_with_config(&connection, config).await;
    let mut client = Client::new(&server);

    let listed = client.rpc("tools/list", json!({})).await.response;
    let names: Vec<_> = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"run_configurations"));
    assert!(names.contains(&"run_start"));
    assert!(names.contains(&"run_output"));
    assert!(!names.contains(&"delegate"));
    assert!(!names.contains(&"list_agents"));

    let catalog = client.tool("run_configurations", json!({})).await;
    assert_eq!(catalog["isError"], false);
    assert_eq!(catalog["structuredContent"]["revision"], "revision-1");
    assert!(catalog.to_string().contains("environmentNames"));
    assert!(!catalog.to_string().contains("literal-secret-value"));

    let read = client
        .tool("run_configuration_read", json!({"id": "build"}))
        .await;
    assert_eq!(read["structuredContent"]["executable"], "cargo");
    assert_eq!(read["structuredContent"]["environmentNames"][0], "TOKEN");
    assert!(!read.to_string().contains("literal-secret-value"));

    let secret_patch = client.rpc("tools/call", json!({
        "name": "run_configuration_save",
        "arguments": {"id": "build", "expectedRevision": "revision-1", "env": {"TOKEN": "<redacted>"}}
    })).await;
    assert_eq!(secret_patch.response["error"]["code"], -32602);

    let saved = client.tool("run_configuration_save", json!({
        "id": "build", "expectedRevision": "revision-1", "name": "Check", "args": ["check", "--locked"], "env": {"NODE_ENV": "development"}
    })).await;
    assert_eq!(saved["structuredContent"]["name"], "Check");
    assert_eq!(saved["structuredContent"]["args"][1], "--locked");
    assert!(!saved.to_string().contains("literal-secret-value"));
    assert!(saved["structuredContent"]["environmentNames"]
        .as_array()
        .unwrap()
        .contains(&json!("NODE_ENV")));
    let stored = backend.entries.lock().unwrap()[0].configuration.clone();
    assert_eq!(
        stored.env.get("TOKEN").map(String::as_str),
        Some("literal-secret-value")
    );
    assert_eq!(
        stored.env.get("NODE_ENV").map(String::as_str),
        Some("development")
    );

    let started = client
        .tool(
            "run_start",
            json!({"id": "build", "expectedRevision": "revision-2"}),
        )
        .await;
    assert_eq!(started["structuredContent"]["id"], "process-1");
    let runs = client.tool("runs_list", json!({})).await;
    assert_eq!(runs["structuredContent"][0]["status"], "running");
    let output = client.tool("run_output", json!({"id": "process-1"})).await;
    assert_eq!(output["structuredContent"]["text"], "ok");
}

#[tokio::test]
async fn disabled_run_tools_are_not_advertised_or_callable() {
    let h = harness();
    let connection = h.connect(&["--name=plain-lead", "--mcp-http"]).await;
    let mut config = h.config(scaled());
    config.delegation_enabled = false;
    config.run_tools = None;
    let (_lead, server) = h.lead_with_config(&connection, config).await;
    let mut client = Client::new(&server);
    let listed = client.rpc("tools/list", json!({})).await.response;
    assert!(listed["result"]["tools"].as_array().unwrap().is_empty());
    let result = client
        .rpc(
            "tools/call",
            json!({"name": "run_configurations", "arguments": {}}),
        )
        .await;
    assert_eq!(result.response["error"]["code"], -32602);
}

#[tokio::test]
async fn run_tool_approval_wait_uses_supplied_progress_token_and_cancels_on_disconnect() {
    let h = harness();
    let connection = h.connect(&["--name=waiting-lead", "--mcp-http"]).await;
    let backend = Arc::new(FakeRunTools::pending_start());
    let mut config = h.config(scaled());
    config.delegation_enabled = false;
    config.run_tools = Some(backend.clone());
    let (_lead, server) = h.lead_with_config(&connection, config).await;

    let address = server
        .url()
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap();
    let mut stream = TcpStream::connect(address).await.unwrap();
    let body = serde_json::to_vec(&json!({
        "jsonrpc": "2.0", "id": 44, "method": "tools/call",
        "params": {
            "name": "run_start",
            "arguments": {"id": "build", "expectedRevision": "revision-1"},
            "_meta": {"progressToken": "approval-44"}
        }
    }))
    .unwrap();
    let request = format!(
        "POST /mcp HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\nAccept: application/json, text/event-stream\r\nMCP-Protocol-Version: 2025-06-18\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        token_of(&server),
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    stream.write_all(&body).await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), async {
        let mut chunk = [0; 4096];
        loop {
            let read = stream.read(&mut chunk).await.unwrap();
            assert_ne!(read, 0, "SSE response closed before progress arrived");
            response.extend_from_slice(&chunk[..read]);
            let text = String::from_utf8_lossy(&response);
            if text.contains("notifications/progress") {
                assert!(text.contains("approval-44"), "{text}");
                assert!(text.contains("Waiting for user approval in Span"), "{text}");
                break;
            }
        }
    })
    .await
    .unwrap();
    assert!(backend.wait_started.load(Ordering::Acquire));

    // reqwest may return an unread streaming response to its connection pool
    // instead of closing the socket. Close both TCP directions so the server's
    // next progress write observes a real disconnected caller.
    stream
        .into_std()
        .unwrap()
        .shutdown(std::net::Shutdown::Both)
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !backend.wait_dropped.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("dropping the MCP stream cancels the pending tool call");
}

#[tokio::test]
async fn missing_wrong_or_foreign_tokens_and_origins_are_rejected() {
    let h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let (_first, server) = h.lead(&lead_connection, scaled()).await;
    let (_second, other) = h.lead(&lead_connection, scaled()).await;
    assert_ne!(
        token_of(&server),
        token_of(&other),
        "tokens are per session"
    );
    let http = reqwest::Client::new();
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});
    let send = |auth: Option<String>, origin: Option<&'static str>| {
        let mut request = http
            .post(server.url())
            .header("accept", "application/json, text/event-stream")
            .json(&body);
        if let Some(auth) = auth {
            request = request.header("authorization", auth);
        }
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        request.send()
    };
    assert_eq!(send(None, None).await.unwrap().status(), 401);
    assert_eq!(
        send(Some("Bearer wrong".into()), None)
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        send(Some(token_of(&server)), None).await.unwrap().status(),
        401,
        "the bare token without the Bearer scheme"
    );
    assert_eq!(
        send(Some(format!("Bearer {}", token_of(&other))), None)
            .await
            .unwrap()
            .status(),
        401,
        "another session's token"
    );
    assert_eq!(
        send(
            Some(format!("Bearer {}", token_of(&server))),
            Some("https://evil.example")
        )
        .await
        .unwrap()
        .status(),
        403
    );
    let ok = send(Some(format!("Bearer {}", token_of(&server))), None)
        .await
        .unwrap();
    assert_eq!(ok.status(), 200);
    let unauthorized = send(None, None).await.unwrap().text().await.unwrap();
    assert!(!unauthorized.contains(&token_of(&server)));
}

#[tokio::test]
async fn the_server_is_only_attached_to_agents_that_advertise_http() {
    let h = harness();
    let plain = h.connect(&["--name=plain"]).await;
    let sse_only = h.connect(&["--name=sse", "--mcp-sse"]).await;
    let http = h.connect(&["--name=http", "--mcp-http"]).await;
    let refused = ToolServer::start(&h.manager, &plain, h.config(scaled()))
        .await
        .unwrap_err();
    assert!(refused.contains("mcpCapabilities.http"), "{refused}");
    let refused = ToolServer::start(&h.manager, &sse_only, h.config(scaled()))
        .await
        .unwrap_err();
    assert!(refused.contains("HTTP+SSE"), "{refused}");
    let server = ToolServer::start(&h.manager, &http, h.config(scaled()))
        .await
        .expect("http agent gets the server");
    assert!(server.running());
}

impl Harness {
    /// Prompt `servers` in a session and return the `mcpServers` its
    /// `session/new` carried, as the fixture agent recorded them.
    async fn servers_of(&mut self, key: &SessionKey) -> Value {
        let manager = self.manager.clone();
        let target = key.clone();
        let turn =
            tokio::spawn(async move { manager.prompt(&target, "servers".into(), vec![]).await });
        let event = self
            .next(|e| {
                e.connection_id == key.connection_id
                    && e.session_id.as_deref() == Some(key.session_id.as_str())
                    && matches!(e.event, AgentEvent::Text { .. })
            })
            .await;
        turn.await.unwrap().expect("servers turn");
        let AgentEvent::Text { text, .. } = event.event else {
            unreachable!()
        };
        serde_json::from_str(&text).expect("fixture answered with JSON")
    }
}

#[tokio::test]
async fn only_the_lead_session_receives_the_server_entry_and_token() {
    let mut h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let (lead, server) = h.lead(&lead_connection, scaled()).await;
    let token = token_of(&server);

    let lead_servers = h.servers_of(&lead).await;
    assert_eq!(lead_servers[0]["name"], "span-agents");
    assert_eq!(
        lead_servers[0]["headers"][0]["value"],
        format!("Bearer {token}")
    );

    // Another user session on the same agent process gets nothing.
    let other = h
        .manager
        .open_session(&lead_connection, None, SessionOrigin::User)
        .await
        .unwrap();
    assert_eq!(h.servers_of(&other).await, json!([]));

    // A child the lead delegates to its own connection gets nothing either.
    let mut client = Client::new(&server);
    let started = client
        .tool("delegate", json!({"agent": "lead", "task": "servers"}))
        .await;
    assert_eq!(structured(&started)["connectionId"], lead_connection);
    let task = structured(&started)["taskId"].as_str().unwrap().to_owned();
    let result = client.until_finished(&task).await;
    assert_eq!(structured(&result)["status"], "completed");
    let summary = result["content"][0]["text"].as_str().unwrap();
    assert!(summary.contains("[]"), "{summary}");
    assert!(!result.to_string().contains(&token));
    assert!(!summary.contains("span-agents"), "{summary}");
}

fn drain(events: &mut mpsc::UnboundedReceiver<SessionEvent>) -> Vec<SessionEvent> {
    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() {
        seen.push(event);
    }
    seen
}

#[tokio::test]
async fn the_token_never_reaches_logs_debug_output_or_errors() {
    let mut h = harness();
    let accepting = h.connect(&["--name=lead", "--mcp-http"]).await;
    let rejecting = h
        .connect(&["--name=rejecting", "--mcp-http", "--reject-session"])
        .await;
    let (lead, server) = h.lead(&accepting, scaled()).await;
    let token = token_of(&server);
    let rejected_server = ToolServer::start(&h.manager, &rejecting, h.config(scaled()))
        .await
        .unwrap();
    let rejected_token = token_of(&rejected_server);
    let error = h
        .manager
        .open_session_with(
            &rejecting,
            None,
            SessionOrigin::User,
            vec![rejected_server.mcp_server_json()],
        )
        .await
        .unwrap_err();
    assert!(error.contains("session refused by fixture"), "{error}");
    // Let the debug callbacks for both requests arrive.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let events = drain(&mut h.events);
    let logs: Vec<&String> = events
        .iter()
        .filter_map(|e| match &e.event {
            AgentEvent::Log { line, .. } => Some(line),
            _ => None,
        })
        .collect();
    let new_session_lines: Vec<&&String> = logs
        .iter()
        .filter(|line| line.contains("\"session/new\""))
        .collect();
    assert_eq!(new_session_lines.len(), 2, "{logs:?}");
    for line in &new_session_lines {
        assert!(line.contains("span-agents"), "{line}");
        assert!(line.contains("[redacted]"), "{line}");
    }
    for secret in [&token, &rejected_token] {
        for event in &events {
            assert!(!serde_json::to_string(event)
                .unwrap()
                .contains(secret.as_str()));
            assert!(!format!("{event:?}").contains(secret.as_str()));
        }
        for text in [
            format!("{server:?}"),
            format!("{rejected_server:?}"),
            format!("{error:?}"),
            error.clone(),
            format!("{lead:?}"),
        ] {
            assert!(!text.contains(secret.as_str()), "{text}");
        }
    }
}

#[tokio::test]
async fn delegate_returns_at_once_and_get_result_follows_a_three_minute_child() {
    let mut h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let worker_connection = h.connect(&["--name=worker"]).await;
    let (lead, server) = h.lead(&lead_connection, scaled()).await;
    let mut client = Client::new(&server);

    // 180 ticks of 10 ms: three minutes in policy seconds.
    let started = Instant::now();
    let delegated = client
        .tool(
            "delegate",
            json!({"agent": "worker", "task": "work:180:10", "expect": "a tick count"}),
        )
        .await;
    let returned_after = started.elapsed();
    assert_eq!(delegated["isError"], false, "{delegated}");
    assert_eq!(structured(&delegated)["status"], "running");
    assert!(
        returned_after < Duration::from_millis(1500),
        "delegate waited {returned_after:?}"
    );
    let task = structured(&delegated)["taskId"]
        .as_str()
        .unwrap()
        .to_owned();
    let session = structured(&delegated)["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let child = SessionKey::new(worker_connection.clone(), session.clone());
    let info = h.manager.session(&child).unwrap();
    assert_eq!(info.parent.as_ref(), Some(&lead));
    assert_eq!(info.origin, SessionOrigin::Delegated);

    // The child streams into the UI path, tagged with its agent.
    let streamed = h
        .next(|e| {
            e.session_id.as_deref() == Some(session.as_str())
                && matches!(e.event, AgentEvent::Thought { .. })
        })
        .await;
    assert_eq!(streamed.agent_name, "worker");

    let mut polls = 0;
    let mut progress = Vec::new();
    let result = loop {
        polls += 1;
        let reply = client.wait(&task, 30, &format!("p{polls}")).await;
        for note in &reply.notifications {
            assert_eq!(note["method"], "notifications/progress");
            assert_eq!(note["params"]["progressToken"], format!("p{polls}"));
            progress.push((polls, note["params"]["progress"].as_f64().unwrap()));
        }
        let result = reply.response["result"].clone();
        if structured(&result)["status"] == "completed" {
            break result;
        }
        assert_eq!(structured(&result)["status"], "running");
        assert!(structured(&result)["progress"]["events"].as_u64().unwrap() > 0);
        assert!(polls < 30, "too many polls");
    };
    assert!(
        polls >= 3,
        "a 180 s child needs several 30 s polls, got {polls}"
    );
    assert!(
        progress.len() >= polls - 1,
        "progress while waiting: {progress:?}"
    );
    for pair in progress.windows(2) {
        if pair[0].0 == pair[1].0 {
            assert!(pair[1].1 > pair[0].1, "progress increases within a call");
        }
    }
    assert_eq!(structured(&result)["stopReason"], "end_turn");
    assert!(result["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("worker worked 180 ticks"));
    assert!(
        structured(&result)["usage"]["elapsedSeconds"]
            .as_u64()
            .unwrap()
            >= 180
    );
    assert_eq!(structured(&result)["usage"]["turns"], 1);
    let events = h.tool_events.lock().unwrap().clone();
    assert!(events
        .iter()
        .any(|e| matches!(e, DelegationEvent::Delegated { task_id, .. } if *task_id == task)));
    assert!(events.iter().any(|e| matches!(e, DelegationEvent::TaskFinished { task_id, status, .. } if *task_id == task && status == "completed")));
}

#[tokio::test]
async fn a_fixture_lead_delegates_from_its_own_process() {
    let mut h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    h.connect(&["--name=worker"]).await;
    let (lead, server) = h.lead(&lead_connection, scaled()).await;
    let call = json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "delegate", "arguments": {"agent": "worker", "task": "reply:from the child"}}});
    let prompt = format!("mcp {} {} {}", server.url(), token_of(&server), call);
    let manager = h.manager.clone();
    let key = lead.clone();
    let turn = tokio::spawn(async move { manager.prompt(&key, prompt, vec![]).await });
    let event = h
        .next(|e| {
            e.session_id.as_deref() == Some(lead.session_id.as_str())
                && matches!(e.event, AgentEvent::Text { .. })
        })
        .await;
    turn.await.unwrap().expect("lead turn");
    let AgentEvent::Text { text, .. } = event.event else {
        unreachable!()
    };
    let reply: Value = serde_json::from_str(&text).expect("lead saw a JSON-RPC reply");
    assert_eq!(reply["id"], 7);
    let task = reply["result"]["structuredContent"]["taskId"]
        .as_str()
        .unwrap()
        .to_owned();
    let result = Client::new(&server).until_finished(&task).await;
    assert_eq!(structured(&result)["status"], "completed");
    assert!(result["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("from the child"));
}

#[tokio::test]
async fn results_carry_the_summary_links_artifacts_and_previews() {
    let mut h = harness();
    let images = h.connect(&["--name=lead", "--mcp-http", "--image"]).await;
    let text_only = h.connect(&["--name=textlead", "--mcp-http"]).await;
    let worker_connection = h.connect(&["--name=worker"]).await;
    let (_lead, server) = h.lead(&images, scaled()).await;
    let mut client = Client::new(&server);

    // A child edit goes through the same editor review as the lead's.
    let delegated = client
        .tool(
            "delegate",
            json!({"agent": "worker", "task": "write:out/result.txt:hello", "saveTo": "out/result.txt"}),
        )
        .await;
    let task = structured(&delegated)["taskId"]
        .as_str()
        .unwrap()
        .to_owned();
    let proposal = h
        .next(|e| matches!(e.event, AgentEvent::Proposal { .. }))
        .await;
    assert_eq!(proposal.agent_name, "worker");
    let AgentEvent::Proposal { proposal, .. } = proposal.event else {
        unreachable!()
    };
    let waiting = client.tool("get_result", json!({"taskId": task})).await;
    assert_eq!(structured(&waiting)["progress"]["waitingForUser"], true);
    h.manager
        .service(&worker_connection)
        .unwrap()
        .review_proposal(proposal.id, true, proposal.base_revision)
        .expect("the user accepts");
    let result = client.until_finished(&task).await;
    let s = structured(&result);
    for field in [
        "status",
        "agent",
        "sessionId",
        "stopReason",
        "artifacts",
        "usage",
    ] {
        assert!(!s[field].is_null(), "missing {field}: {s}");
    }
    assert_eq!(s["status"], "completed");
    assert_eq!(s["agent"], "worker");
    assert_eq!(result["isError"], false);
    assert_eq!(result["content"][0]["type"], "text", "summary first");
    let artifact = &s["artifacts"][0];
    assert_eq!(artifact["path"], "out/result.txt");
    assert_eq!(artifact["mimeType"], "text/plain");
    assert_eq!(artifact["bytes"], 6);
    assert_eq!(artifact["source"], "buffer", "accepted edits stay unsaved");
    assert_eq!(artifact["sha256"], span_acp::tools::sha256_hex(b"hello\n"));
    let link = result["content"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["type"] == "resource_link")
        .expect("resource link");
    assert_eq!(link["name"], "out/result.txt");
    assert!(link["uri"].as_str().unwrap().starts_with("file:///"));

    // Inline previews: only for a lead that accepts images.
    let png = b"\x89PNG\r\n\x1a\nfake image bytes";
    std::fs::write(h.directory.path().join("out/pic.png"), png).unwrap();
    let delegated = client
        .tool(
            "delegate",
            json!({"agent": "worker", "task": "reply:drawn", "saveTo": "out/pic.png"}),
        )
        .await;
    let task = structured(&delegated)["taskId"]
        .as_str()
        .unwrap()
        .to_owned();
    let result = client.until_finished(&task).await;
    let image = result["content"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["type"] == "image")
        .expect("inline preview");
    assert_eq!(image["mimeType"], "image/png");
    assert_eq!(image["data"], span_acp::tools::base64(png));
    assert_eq!(structured(&result)["artifacts"][0]["source"], "disk");

    let (_other, text_server) = h.lead(&text_only, scaled()).await;
    let mut text_client = Client::new(&text_server);
    let delegated = text_client
        .tool(
            "delegate",
            json!({"agent": "worker", "task": "reply:drawn", "saveTo": "out/pic.png"}),
        )
        .await;
    let task = structured(&delegated)["taskId"]
        .as_str()
        .unwrap()
        .to_owned();
    let result = text_client.until_finished(&task).await;
    assert!(result["content"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["type"] != "image"));

    // Paths outside the workspace are refused.
    let escape = text_client
        .rpc(
            "tools/call",
            json!({"name": "delegate", "arguments": {"agent": "worker", "task": "x", "saveTo": "../escape.txt"}}),
        )
        .await;
    assert_eq!(escape.response["error"]["code"], -32602);
}

#[tokio::test]
async fn failures_map_to_the_closed_reason_set() {
    let h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    h.connect(&["--name=worker"]).await;
    let (_lead, server) = h.lead(&lead_connection, scaled()).await;
    let mut client = Client::new(&server);
    for (task, reason) in [("refuse", "refused"), ("limit", "output_limit")] {
        let delegated = client
            .tool("delegate", json!({"agent": "worker", "task": task}))
            .await;
        let id = structured(&delegated)["taskId"]
            .as_str()
            .unwrap()
            .to_owned();
        let result = client.until_finished(&id).await;
        assert_eq!(result["isError"], true);
        assert_eq!(structured(&result)["reason"], reason);
    }
    let missing = client
        .tool("delegate", json!({"agent": "nobody", "task": "x"}))
        .await;
    assert_eq!(structured(&missing)["reason"], "agent_unavailable");
    let installed = client
        .tool("delegate", json!({"agent": "gemini-cli", "task": "x"}))
        .await;
    assert_eq!(structured(&installed)["reason"], "agent_unavailable");
    assert!(structured(&installed)["detail"]
        .as_str()
        .unwrap()
        .contains("not connected"));
}

#[tokio::test]
async fn a_child_cannot_delegate_unless_the_depth_limit_allows_it() {
    let h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let worker_connection = h.connect(&["--name=worker", "--mcp-http"]).await;
    let (_lead, server) = h.lead(&lead_connection, scaled()).await;
    let mut client = Client::new(&server);
    let delegated = client
        .tool("delegate", json!({"agent": "worker", "task": "reply:ok"}))
        .await;
    let child = SessionKey::new(
        worker_connection.clone(),
        structured(&delegated)["sessionId"].as_str().unwrap(),
    );
    // Children get no server by default. Give one anyway to prove the limit
    // holds even if a child reached the tools.
    let child_server = ToolServer::start(&h.manager, &worker_connection, h.config(scaled()))
        .await
        .unwrap();
    child_server.bind(&h.manager, child.clone()).unwrap();
    let mut child_client = Client::new(&child_server);
    let agents = child_client.tool("list_agents", json!({})).await;
    assert_eq!(structured(&agents)["canDelegate"], false);
    assert_eq!(structured(&agents)["callerDepth"], 1);
    let refused = child_client
        .tool(
            "delegate",
            json!({"agent": "lead", "task": "reply:recursion"}),
        )
        .await;
    assert_eq!(refused["isError"], true);
    assert_eq!(structured(&refused)["reason"], "depth_exceeded");
    assert!(refused["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("depth limit"));
    assert_eq!(h.manager.sessions().len(), 2, "no grandchild was created");

    // A user who raises the limit to 2 lets the child delegate once more.
    let raised = ToolPolicy {
        max_depth: 2,
        ..scaled()
    };
    let child_server = ToolServer::start(&h.manager, &worker_connection, h.config(raised))
        .await
        .unwrap();
    child_server.bind(&h.manager, child.clone()).unwrap();
    let allowed = Client::new(&child_server)
        .tool("delegate", json!({"agent": "lead", "task": "reply:nested"}))
        .await;
    assert_eq!(allowed["isError"], false, "{allowed}");
    let grandchild = SessionKey::new(
        lead_connection.clone(),
        structured(&allowed)["sessionId"].as_str().unwrap(),
    );
    assert_eq!(h.manager.session(&grandchild).unwrap().depth, 2);
}

#[tokio::test]
async fn exceeding_a_budget_cancels_the_child_and_reports_it() {
    let mut h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let worker_connection = h.connect(&["--name=worker"]).await;
    let (_lead, server) = h.lead(&lead_connection, scaled()).await;
    let mut client = Client::new(&server);

    let delegated = client
        .tool(
            "delegate",
            json!({"agent": "worker", "task": "usage:5000", "budget": {"maxTokens": 1000}}),
        )
        .await;
    let task = structured(&delegated)["taskId"]
        .as_str()
        .unwrap()
        .to_owned();
    let session = structured(&delegated)["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let child = SessionKey::new(worker_connection.clone(), session.clone());
    h.next(|e| e.connection_id == worker_connection && matches!(&e.event, AgentEvent::Complete { session_id, stop_reason, .. } if *session_id == session && stop_reason == "cancelled"))
        .await;
    let result = client.until_finished(&task).await;
    assert_eq!(result["isError"], true);
    assert_eq!(structured(&result)["reason"], "budget_exceeded");
    assert_eq!(structured(&result)["usage"]["tokens"], 5000);
    assert!(structured(&result)["detail"]
        .as_str()
        .unwrap()
        .contains("1000 token budget"));

    // Wall clock: 5 policy seconds.
    let delegated = client
        .tool(
            "delegate",
            json!({"agent": "worker", "task": "wait", "budget": {"timeoutSeconds": 5}}),
        )
        .await;
    let task = structured(&delegated)["taskId"]
        .as_str()
        .unwrap()
        .to_owned();
    let result = client.until_finished(&task).await;
    assert_eq!(structured(&result)["reason"], "timeout");

    // Turns: the delegation used its only turn, so a follow-up is refused.
    let delegated = client
        .tool(
            "delegate",
            json!({"agent": "worker", "task": "reply:one", "budget": {"maxTurns": 1}}),
        )
        .await;
    let task = structured(&delegated)["taskId"]
        .as_str()
        .unwrap()
        .to_owned();
    client.until_finished(&task).await;
    let refused = client
        .tool(
            "message",
            json!({"sessionId": structured(&delegated)["sessionId"], "text": "reply:two"}),
        )
        .await;
    assert_eq!(refused["isError"], true);
    assert_eq!(structured(&refused)["reason"], "budget_exceeded");
    assert!(!h.manager.session(&child).unwrap().busy);
}

#[tokio::test]
async fn cancel_cascades_and_the_server_ends_with_its_lead() {
    let mut h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let a = h.connect(&["--name=alpha"]).await;
    let b = h.connect(&["--name=beta"]).await;
    let (lead, server) = h.lead(&lead_connection, scaled()).await;
    let mut client = Client::new(&server);
    let first = client
        .tool("delegate", json!({"agent": "alpha", "task": "wait"}))
        .await;
    let second = client
        .tool("delegate", json!({"agent": "beta", "task": "wait"}))
        .await;
    let first_task = structured(&first)["taskId"].as_str().unwrap().to_owned();
    let second_task = structured(&second)["taskId"].as_str().unwrap().to_owned();
    // A follow-up queues behind the running turn, via the manager.
    let queued = client
        .tool(
            "message",
            json!({"sessionId": structured(&first)["sessionId"], "text": "reply:later"}),
        )
        .await;
    assert_eq!(structured(&queued)["status"], "queued");
    let queued_task = structured(&queued)["taskId"].as_str().unwrap().to_owned();
    let alpha_child = SessionKey::new(a.clone(), structured(&first)["sessionId"].as_str().unwrap());
    assert_eq!(h.manager.session(&alpha_child).unwrap().queued, 1);

    let cancelled = client.tool("cancel", json!({"taskId": first_task})).await;
    assert_eq!(cancelled["isError"], false);
    let result = client.until_finished(&first_task).await;
    assert_eq!(structured(&result)["reason"], "cancelled");
    assert_eq!(structured(&result)["detail"], "cancelled by the lead");
    let result = client.until_finished(&queued_task).await;
    assert_eq!(structured(&result)["reason"], "cancelled");

    // The user stops the lead: the remaining child stops too.
    h.manager.cancel(&lead).unwrap();
    h.next(|e| e.connection_id == b && matches!(&e.event, AgentEvent::Complete { stop_reason, .. } if stop_reason == "cancelled"))
        .await;
    let result = client.until_finished(&second_task).await;
    assert_eq!(structured(&result)["status"], "failed");
    assert_eq!(structured(&result)["reason"], "cancelled");

    // Closing the lead session tears the server down.
    let url = server.url().to_owned();
    h.manager.close(&lead).await.ok();
    h.manager.disconnect(&lead_connection).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while server.running() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("server stops with its lead");
    tokio::time::sleep(Duration::from_millis(50)).await;
    let after = reqwest::Client::new()
        .post(&url)
        .header("authorization", format!("Bearer {}", client.token))
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}))
        .send()
        .await;
    assert!(after.is_err(), "nothing listens after teardown");
    assert!(h.manager.session(&alpha_child).is_none());
}

#[tokio::test]
async fn a_child_permission_cannot_be_answered_through_any_tool() {
    let mut h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let worker_connection = h.connect(&["--name=worker"]).await;
    let (_lead, server) = h.lead(&lead_connection, scaled()).await;
    let mut client = Client::new(&server);

    // No tool takes a request or option id.
    let tools = client.rpc("tools/list", json!({})).await.response;
    for tool in tools["result"]["tools"].as_array().unwrap() {
        let schema = tool["inputSchema"].to_string().to_lowercase();
        for word in ["requestid", "optionid", "approve", "allow"] {
            assert!(!schema.contains(word), "{} mentions {word}", tool["name"]);
        }
    }

    let delegated = client
        .tool("delegate", json!({"agent": "worker", "task": "permission"}))
        .await;
    let task = structured(&delegated)["taskId"]
        .as_str()
        .unwrap()
        .to_owned();
    let session = structured(&delegated)["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let child = SessionKey::new(worker_connection.clone(), session.clone());
    let permission = h
        .next(|e| matches!(e.event, AgentEvent::Permission { .. }))
        .await;
    // Surfaced to the user, labelled with the agent.
    assert_eq!(permission.agent_name, "worker");
    assert_eq!(permission.connection_id, worker_connection);
    let AgentEvent::Permission { request_id, .. } = permission.event else {
        unreachable!()
    };

    // Every tool, with every argument that could look like an answer.
    client.tool("list_agents", json!({})).await;
    let polled = client
        .tool("get_result", json!({"taskId": task, "waitSeconds": 1}))
        .await;
    assert_eq!(structured(&polled)["progress"]["waitingForUser"], true);
    for text in [
        format!("allow {request_id}"),
        "yes".into(),
        format!("{{\"requestId\":\"{request_id}\",\"optionId\":\"yes\"}}"),
    ] {
        client
            .tool("message", json!({"sessionId": session, "text": text}))
            .await;
    }
    client
        .tool(
            "record_decision",
            json!({"chosen": format!("approve {request_id}"), "why": "optionId yes", "alternatives": ["reject"]}),
        )
        .await;
    for name in ["respond_permission", "permission", "approve", "answer"] {
        let reply = client
            .rpc(
                "tools/call",
                json!({"name": name, "arguments": {"requestId": request_id, "optionId": "yes", "sessionId": session}}),
            )
            .await;
        assert_eq!(reply.response["error"]["code"], -32602, "{name}");
    }
    let extra = client
        .rpc(
            "tools/call",
            json!({"name": "get_result", "arguments": {"taskId": task, "requestId": request_id, "optionId": "yes"}}),
        )
        .await;
    assert_eq!(
        extra.response["error"]["code"], -32602,
        "unknown arguments are refused"
    );
    for method in ["session/request_permission", "permission/respond"] {
        let reply = client
            .rpc(method, json!({"requestId": request_id, "optionId": "yes"}))
            .await;
        assert_eq!(reply.response["error"]["code"], -32601);
    }
    let pending = h.manager.pending_requests();
    assert_eq!(pending.len(), 1, "still waiting for the user");
    assert_eq!(pending[0].request_id, request_id);
    let still = client.tool("get_result", json!({"taskId": task})).await;
    assert_eq!(structured(&still)["status"], "running");

    // Only the user's handle answers it.
    h.manager
        .respond_permission(&child, request_id, Some("no".into()))
        .unwrap();
    let result = client.until_finished(&task).await;
    assert_eq!(structured(&result)["reason"], "permission_rejected");
    // The queued follow-ups run as ordinary turns afterwards; stop them.
    h.manager.cancel(&child).ok();
}

#[tokio::test]
async fn record_decision_stores_a_record_and_emits_an_event_only() {
    let h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let (lead, server) = h.lead(&lead_connection, scaled()).await;
    let mut client = Client::new(&server);
    let before = h.manager.sessions().len();
    let recorded = client
        .tool(
            "record_decision",
            json!({"chosen": "ropey", "why": "fast edits", "alternatives": ["xi-rope", "String"]}),
        )
        .await;
    assert_eq!(recorded["isError"], false);
    assert_eq!(structured(&recorded)["decisionId"], "decision-1");
    let decisions = server.decisions();
    assert_eq!(decisions.len(), 1);
    assert_eq!(decisions[0].alternatives, ["xi-rope", "String"]);
    let events = h.tool_events.lock().unwrap().clone();
    assert!(events.iter().any(|e| matches!(e, DelegationEvent::Decision { lead: l, decision } if *l == lead && decision.chosen == "ropey")));
    assert_eq!(h.manager.sessions().len(), before, "no side effects");
    let missing = client
        .rpc(
            "tools/call",
            json!({"name": "record_decision", "arguments": {"chosen": "x"}}),
        )
        .await;
    assert_eq!(missing.response["error"]["code"], -32602);
}

#[tokio::test]
async fn delegated_is_emitted_before_any_child_event() {
    let h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let worker_connection = h.connect(&["--name=worker"]).await;
    // One log for both streams, so the order between them is observable.
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = log.clone();
    let mut config = h.config(scaled());
    config.events = Some(Arc::new(move |event| {
        if let DelegationEvent::Delegated { task_id, .. } = event {
            sink.lock().unwrap().push(format!("delegated:{task_id}"));
        }
    }));
    let server = ToolServer::start(&h.manager, &lead_connection, config)
        .await
        .expect("start span-agents");
    let lead = h
        .manager
        .open_session_with(
            &lead_connection,
            None,
            SessionOrigin::User,
            vec![server.mcp_server_json()],
        )
        .await
        .expect("lead session");
    server.bind(&h.manager, lead).expect("bind lead");
    let child_log = log.clone();
    let child_connection = worker_connection.clone();
    let _subscription = h.manager.subscribe(Arc::new(move |event: SessionEvent| {
        // Events of the prompt itself; session setup events precede any task.
        let turn = matches!(
            event.event,
            AgentEvent::Thought { .. }
                | AgentEvent::Text { .. }
                | AgentEvent::Usage { .. }
                | AgentEvent::Complete { .. }
        );
        if turn && event.connection_id == child_connection && event.session_id.is_some() {
            child_log.lock().unwrap().push("child".into());
        }
    }));
    let mut client = Client::new(&server);

    // A child that streams the moment its prompt arrives.
    let delegated = client
        .tool("delegate", json!({"agent": "worker", "task": "work:3:0"}))
        .await;
    let task = structured(&delegated)["taskId"]
        .as_str()
        .unwrap()
        .to_owned();
    client.until_finished(&task).await;
    let log = log.lock().unwrap().clone();
    assert_eq!(log.first(), Some(&format!("delegated:{task}")), "{log:?}");
    assert!(log.iter().any(|entry| entry == "child"), "{log:?}");
}

#[tokio::test]
async fn a_child_permission_emits_one_typed_event_that_no_tool_can_answer() {
    let mut h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let worker_connection = h.connect(&["--name=worker"]).await;
    let (lead, server) = h.lead(&lead_connection, scaled()).await;
    let mut client = Client::new(&server);

    let tools = client.rpc("tools/list", json!({})).await.response;
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    for name in &names {
        for word in ["permission", "answer", "respond", "approve", "cancel_task"] {
            assert!(!name.contains(word), "tool {name} could answer or cancel");
        }
    }

    let delegated = client
        .tool("delegate", json!({"agent": "worker", "task": "permission"}))
        .await;
    let task = structured(&delegated)["taskId"]
        .as_str()
        .unwrap()
        .to_owned();
    let session = structured(&delegated)["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let plain = h
        .next(|e| matches!(e.event, AgentEvent::Permission { .. }))
        .await;
    let AgentEvent::Permission { request_id, .. } = plain.event else {
        unreachable!()
    };
    let typed = h
        .tool_events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| matches!(e, DelegationEvent::ChildPermission { .. }))
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(
        typed,
        vec![DelegationEvent::ChildPermission {
            lead,
            child: SessionKey::new(worker_connection.clone(), session.clone()),
            task_id: Some(task.clone()),
            agent_name: "worker".into(),
            connection_id: worker_connection.clone(),
            session_id: session.clone(),
            request_id: request_id.clone(),
            request_kind: "permission".into(),
        }]
    );

    // Tool calls with the ids in hand change nothing.
    for name in ["list_agents", "get_result", "message", "record_decision"] {
        let _ = client
            .tool(
                name,
                json!({"taskId": task, "sessionId": session, "text": "yes", "chosen": request_id, "why": "yes"}),
            )
            .await;
    }
    let pending = h.manager.pending_requests();
    assert_eq!(pending.len(), 1, "still waiting for the user");
    assert_eq!(pending[0].request_id, request_id);
    h.manager
        .respond_permission(
            &SessionKey::new(worker_connection, session),
            request_id,
            Some("no".into()),
        )
        .unwrap();
    client.until_finished(&task).await;
}

#[tokio::test]
async fn tasks_report_timing_progress_summary_artifacts_and_usage() {
    let mut h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let worker_connection = h.connect(&["--name=worker"]).await;
    let (_lead, server) = h.lead(&lead_connection, scaled()).await;
    let mut client = Client::new(&server);

    let delegated = client
        .tool(
            "delegate",
            json!({"agent": "worker", "task": "write:out/result.txt:hello", "saveTo": "out/result.txt"}),
        )
        .await;
    let task = structured(&delegated)["taskId"]
        .as_str()
        .unwrap()
        .to_owned();
    let proposal = h
        .next(|e| matches!(e.event, AgentEvent::Proposal { .. }))
        .await;
    let AgentEvent::Proposal { proposal, .. } = proposal.event else {
        unreachable!()
    };
    let running = server.tasks();
    assert_eq!(running.len(), 1);
    assert_eq!(running[0].status, "running");
    assert!(running[0].started_at_ms > 0);
    assert_eq!(running[0].finished_at_ms, None);
    assert_eq!(running[0].result_summary, None);
    assert!(running[0].artifacts.is_empty());
    assert!(
        running[0].progress_text.is_some(),
        "the child reported a tool call"
    );
    assert_eq!(running[0].budget_used.turns, 1);

    h.manager
        .service(&worker_connection)
        .unwrap()
        .review_proposal(proposal.id, true, proposal.base_revision)
        .expect("the user accepts");
    client.until_finished(&task).await;
    let done = &server.tasks()[0];
    assert_eq!(done.status, "completed");
    let finished = done.finished_at_ms.expect("finish time");
    assert!(finished >= done.started_at_ms);
    assert!(done
        .result_summary
        .as_deref()
        .is_some_and(|s| s.contains("wrote out/result.txt")));
    assert!(done.progress_text.is_some());
    assert_eq!(done.artifacts.len(), 1);
    assert_eq!(done.artifacts[0].path, "out/result.txt");
    assert_eq!(done.artifacts[0].sha256.len(), 64);
    assert!(done.artifacts[0].bytes > 0);
    assert_eq!(done.budget_used.turns, 1);
    // The agent reported no usage, so none is made up.
    assert_eq!(done.budget_used.tokens, None);
}

#[tokio::test]
async fn the_user_can_cancel_one_task_and_the_child_tree_stops() {
    let h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let worker_connection = h.connect(&["--name=worker"]).await;
    let (_lead, server) = h.lead(&lead_connection, scaled()).await;
    let mut client = Client::new(&server);

    let delegated = client
        .tool("delegate", json!({"agent": "worker", "task": "wait"}))
        .await;
    let task = structured(&delegated)["taskId"]
        .as_str()
        .unwrap()
        .to_owned();
    let session = structured(&delegated)["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(server.has_task(&task));
    assert!(server.cancel_task("task-99").is_err(), "unknown task");
    server.cancel_task(&task).expect("user cancel");
    let result = client.until_finished(&task).await;
    assert_eq!(structured(&result)["status"], "failed");
    assert_eq!(structured(&result)["reason"], "cancelled");
    let listed = &server.tasks()[0];
    assert_eq!(
        listed.reason,
        Some(span_acp::tools::FailureReason::Cancelled)
    );
    assert_eq!(listed.detail.as_deref(), Some("cancelled by the user"));
    assert!(listed.finished_at_ms.is_some());
    assert!(
        server.cancel_task(&task).is_err(),
        "a finished task cannot be cancelled again"
    );
    // The session stays open for follow-ups, as with the lead's cancel.
    assert!(h
        .manager
        .session(&SessionKey::new(worker_connection, session))
        .is_some());
}

#[tokio::test]
async fn a_child_that_ignores_stop_fails_alone_and_the_lead_keeps_running() {
    let mut h = harness();
    // One process hosts the lead and the child.
    let connection = h.connect(&["--name=agent", "--mcp-http"]).await;
    let (lead, server) = h.lead(&connection, scaled()).await;
    let mut client = Client::new(&server);
    let delegated = client
        .tool("delegate", json!({"agent": connection, "task": "stubborn"}))
        .await;
    let task = structured(&delegated)["taskId"]
        .as_str()
        .unwrap()
        .to_owned();
    let session = structured(&delegated)["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(session, lead.session_id);

    // The lead is mid turn (about 12 s) when its tool stops the child. The
    // child never acknowledges, so the 5 s Stop deadline passes.
    let manager = h.manager.clone();
    let lead_key = lead.clone();
    let lead_turn = tokio::spawn(async move {
        manager
            .prompt(&lead_key, "work:1200:10".into(), Vec::new())
            .await
    });
    let cancelled = client.tool("cancel", json!({"taskId": task})).await;
    assert_eq!(cancelled["isError"], false, "{cancelled}");
    let result = client.until_finished(&task).await;
    assert_eq!(structured(&result)["status"], "failed");
    assert_eq!(structured(&result)["reason"], "cancelled");

    // The failure event names the child, never the lead.
    let failure = h
        .next(|e| matches!(e.event, AgentEvent::Error { .. }))
        .await;
    assert_eq!(failure.session_id.as_deref(), Some(session.as_str()));
    let AgentEvent::Error {
        session_id,
        message,
    } = failure.event
    else {
        unreachable!()
    };
    assert_eq!(session_id.as_deref(), Some(session.as_str()));
    assert!(message.contains("Stop"), "{message}");

    // The connection and the lead's turn survived.
    assert!(h.manager.connection(&connection).unwrap().open);
    let finished = tokio::time::timeout(Duration::from_secs(30), lead_turn)
        .await
        .expect("lead turn ends")
        .expect("join");
    assert_eq!(finished, Ok(()), "the lead's turn was not cut off");
    assert!(h.manager.connection(&connection).unwrap().open);
}

#[tokio::test]
async fn a_root_session_that_ignores_stop_still_ends_the_connection() {
    let mut h = harness();
    let connection = h.connect(&["--name=agent"]).await;
    let root = h
        .manager
        .open_session(&connection, None, SessionOrigin::User)
        .await
        .expect("session");
    let manager = h.manager.clone();
    let key = root.clone();
    tokio::spawn(async move { manager.prompt(&key, "stubborn".into(), Vec::new()).await });
    tokio::time::sleep(Duration::from_millis(500)).await;
    h.manager.cancel(&root).unwrap();
    let error = h
        .next(|e| matches!(e.event, AgentEvent::Error { .. }))
        .await;
    let AgentEvent::Error {
        session_id,
        message,
    } = error.event
    else {
        unreachable!()
    };
    assert_eq!(session_id, None, "a connection level error");
    assert!(message.contains("connection was terminated"), "{message}");
    h.next(|e| matches!(&e.event, AgentEvent::Status { state, .. } if state == "disconnected"))
        .await;
}

#[tokio::test]
async fn a_cancel_right_after_a_prompt_is_never_lost() {
    // The test runtime is single threaded: the manager's turn driver cannot
    // run between `enqueue` and `cancel`, which forces the interleaving where
    // the cancel arrives before the prompt was written to the agent. Before
    // the fix the cancel was dropped and the child ran to completion.
    let mut h = harness();
    let connection = h.connect(&["--name=worker"]).await;
    let key = h
        .manager
        .open_session(&connection, None, SessionOrigin::User)
        .await
        .expect("session");
    let done = h
        .manager
        .enqueue(&key, "work:180:10".into(), Vec::new())
        .expect("enqueue");
    h.manager.cancel(&key).expect("cancel");
    let result = tokio::time::timeout(Duration::from_secs(10), done)
        .await
        .expect("the turn ends")
        .expect("reply");
    assert_eq!(result, Err("Cancelled before the turn started".to_string()));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let streamed = drain(&mut h.events).into_iter().any(|e| {
        e.session_id.as_deref() == Some(key.session_id.as_str())
            && matches!(
                e.event,
                AgentEvent::Thought { .. } | AgentEvent::Text { .. }
            )
    });
    assert!(!streamed, "the cancelled prompt must never reach the agent");
    // The session is still usable afterwards.
    let again = h.manager.prompt(&key, "reply:ok".into(), Vec::new()).await;
    assert_eq!(again, Ok(()));
}

#[tokio::test]
async fn a_user_cancel_right_after_delegate_ends_cancelled_not_completed() {
    // Same forced interleaving through the tool server: the child's turn
    // is accepted and cancelled before the prompt is written.
    let h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let _worker = h.connect(&["--name=worker"]).await;
    let (_lead, server) = h.lead(&lead_connection, scaled()).await;
    let mut client = Client::new(&server);
    let delegated = client
        .tool("delegate", json!({"agent": "worker", "task": "work:30:10"}))
        .await;
    let task = structured(&delegated)["taskId"]
        .as_str()
        .unwrap()
        .to_owned();
    server.cancel_task(&task).expect("user cancel");
    let result = client.until_finished(&task).await;
    assert_eq!(structured(&result)["status"], "failed");
    assert_eq!(structured(&result)["reason"], "cancelled");
}

/// Live run finding: `connect` returned before the `Ready` event reached the
/// manager, so `open_lead` right after it saw no features in 6 of 8 connects
/// and dropped delegation with "has not finished initialize".
#[tokio::test]
async fn open_lead_right_after_connect_always_sees_features() {
    let h = harness();
    let leads = span_acp::tools::LeadServers::default();
    for attempt in 0..8 {
        // A slow direct sink (the desktop's Tauri channel) delays the
        // manager's own bookkeeping of each event, which widens the window.
        let slow: span_acp::EventSink = Arc::new(|event: AgentEvent| {
            if matches!(event, AgentEvent::Ready { .. }) {
                std::thread::sleep(Duration::from_millis(150));
            }
        });
        let connection = h
            .manager
            .connect(
                worker(&["--name=lead", "--mcp-http"]),
                h.directory.path().to_string_lossy().into_owned(),
                h.workspace.clone(),
                Some(slow),
            )
            .await
            .expect("start fixture agent");
        let features = h
            .manager
            .connection(&connection)
            .and_then(|c| c.features)
            .is_some();
        let (key, delegation) = leads
            .open_lead(&h.manager, &connection, Some(h.config(scaled())))
            .await
            .expect("open lead");
        assert!(features, "attempt {attempt}: features unset after connect");
        assert_eq!(
            delegation,
            span_acp::tools::LeadDelegation::Attached,
            "attempt {attempt}"
        );
        h.manager.close(&key).await.ok();
        h.manager.disconnect(&connection).unwrap();
    }
}

// On-demand starts of installed agents (#82): Span starts an installed agent
// the lead delegates to, in the background, through the session manager.

use span_acp::tools::LeadServers;
use span_acp::{BackgroundAgents, BackgroundState, InstalledAgent, LaunchFn};
use std::sync::atomic::AtomicUsize;

fn installed(id: &str, launch: AgentCommand) -> InstalledAgent {
    InstalledAgent {
        id: id.into(),
        version: "1.0.0".into(),
        launch,
    }
}

/// A launcher that starts the installed agent's own command through the
/// manager, after `delay`, counting the processes it started.
fn launcher(h: &Harness, delay: Duration, starts: Arc<AtomicUsize>) -> LaunchFn {
    let manager = h.manager.clone();
    let workspace = h.workspace.clone();
    let cwd = h.directory.path().to_string_lossy().into_owned();
    Arc::new(move |agent: InstalledAgent, sink| {
        let (manager, workspace, cwd, starts) = (
            manager.clone(),
            workspace.clone(),
            cwd.clone(),
            starts.clone(),
        );
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            starts.fetch_add(1, Ordering::SeqCst);
            manager
                .connect(agent.launch, cwd, workspace, Some(sink))
                .await
        })
    })
}

impl Harness {
    fn background_config(
        &self,
        policy: ToolPolicy,
        agents: Vec<InstalledAgent>,
        background: &BackgroundAgents,
    ) -> ToolServerConfig {
        // Ten real seconds for a fixture process to start, unless the test
        // set its own limit.
        let policy =
            if policy.launch_timeout_seconds == ToolPolicy::default().launch_timeout_seconds {
                ToolPolicy {
                    launch_timeout_seconds: 1000,
                    ..policy
                }
            } else {
                policy
            };
        let mut config = self.config(policy);
        config.installed = agents;
        config.background = Some(background.clone());
        config
    }

    async fn background_lead(
        &self,
        connection: &str,
        config: ToolServerConfig,
    ) -> (SessionKey, ToolServer) {
        let server = ToolServer::start(&self.manager, connection, config)
            .await
            .expect("start span-agents");
        let lead = self
            .manager
            .open_session_with(
                connection,
                None,
                SessionOrigin::User,
                vec![server.mcp_server_json()],
            )
            .await
            .expect("lead session");
        server.bind(&self.manager, lead.clone()).expect("bind lead");
        (lead, server)
    }

    /// The lead still answers its own prompts.
    async fn lead_answers(&mut self, lead: &SessionKey) {
        let manager = self.manager.clone();
        let key = lead.clone();
        let turn = tokio::spawn(async move {
            manager
                .prompt(&key, "reply:lead still here".into(), vec![])
                .await
        });
        let lead_session = lead.session_id.clone();
        let event = self
            .next(|e| {
                e.session_id.as_deref() == Some(lead_session.as_str())
                    && matches!(&e.event, AgentEvent::Text { text, .. } if text.contains("lead still here"))
            })
            .await;
        assert_eq!(event.connection_id, lead.connection_id);
        turn.await.unwrap().expect("lead turn");
    }
}

#[tokio::test]
async fn list_agents_reports_installed_agents_as_ready_to_start() {
    let h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let background = BackgroundAgents::new(
        h.manager.clone(),
        launcher(&h, Duration::ZERO, Arc::default()),
    );
    let config = h.background_config(
        scaled(),
        vec![installed("codex-acp", worker(&["--name=codex"]))],
        &background,
    );
    let (_lead, server) = h.background_lead(&lead_connection, config).await;
    let listed = Client::new(&server).tool("list_agents", json!({})).await;
    let agents = structured(&listed)["agents"].as_array().unwrap().clone();
    let codex = agents.iter().find(|a| a["id"] == "codex-acp").unwrap();
    assert_eq!(codex["state"], "ready to start");
    assert_eq!(codex["delegable"], true);
    let text = listed["content"][0]["text"].as_str().unwrap();
    assert!(
        text.contains("codex-acp (installed, ready to start)"),
        "{text}"
    );
    assert!(
        !text.to_lowercase().contains("ask the user to connect"),
        "{text}"
    );
    // Listing starts nothing.
    assert_eq!(background.state("codex-acp"), BackgroundState::Idle);
    assert_eq!(h.manager.connections().len(), 1);

    // The advertised instructions and descriptions say so too.
    let mut client = Client::new(&server);
    let init = client
        .rpc("initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}))
        .await;
    let instructions = init.response["result"]["instructions"].as_str().unwrap();
    assert!(
        instructions.contains("Do not ask the user to connect"),
        "{instructions}"
    );
    let tools = client.rpc("tools/list", json!({})).await;
    let delegate = tools.response["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "delegate")
        .unwrap()
        .clone();
    assert!(delegate["description"]
        .as_str()
        .unwrap()
        .contains("Span starts an installed agent in the background"));
}

#[tokio::test]
async fn delegating_to_an_installed_agent_starts_it_and_returns_the_childs_result() {
    let mut h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let starts = Arc::new(AtomicUsize::new(0));
    let background = BackgroundAgents::new(
        h.manager.clone(),
        launcher(&h, Duration::ZERO, starts.clone()),
    );
    let config = h.background_config(
        scaled(),
        vec![installed("codex-acp", worker(&["--name=codex"]))],
        &background,
    );
    let (lead, server) = h.background_lead(&lead_connection, config).await;
    let mut client = Client::new(&server);
    let delegated = client
        .tool(
            "delegate",
            json!({"agent": "codex-acp", "task": "reply:hello from codex"}),
        )
        .await;
    assert_eq!(delegated["isError"], false, "{delegated}");
    let connection = structured(&delegated)["connectionId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(connection, lead_connection);
    assert_eq!(structured(&delegated)["agent"], "codex");
    let task = structured(&delegated)["taskId"]
        .as_str()
        .unwrap()
        .to_owned();
    let result = client.until_finished(&task).await;
    assert_eq!(structured(&result)["status"], "completed");
    assert!(result["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("hello from codex"));
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(
        background.state("codex-acp"),
        BackgroundState::Connected(connection.clone())
    );

    // The UI saw the start, then the delegation, in that order.
    let events = h.tool_events.lock().unwrap().clone();
    let position = |pred: &dyn Fn(&DelegationEvent) -> bool| events.iter().position(pred).unwrap();
    let starting = position(
        &|e| matches!(e, DelegationEvent::Starting { agent_id, lead: l } if agent_id == "codex-acp" && *l == lead),
    );
    let finished = position(
        &|e| matches!(e, DelegationEvent::StartFinished { agent_id, launched: true, connection_id: Some(c), reason: None, .. } if agent_id == "codex-acp" && *c == connection),
    );
    let delegated_at = position(&|e| matches!(e, DelegationEvent::Delegated { .. }));
    assert!(starting < finished && finished < delegated_at, "{events:?}");

    // list_agents now shows it connected under its installed id, once.
    let listed = client.tool("list_agents", json!({})).await;
    let agents = structured(&listed)["agents"].as_array().unwrap().clone();
    assert!(agents.iter().all(|a| a["id"] != "codex-acp"));
    let running = agents.iter().find(|a| a["id"] == connection).unwrap();
    assert_eq!(running["state"], "connected");
    assert_eq!(running["installedId"], "codex-acp");

    // A second delegation reuses the running process and announces no start.
    let before = h.tool_events.lock().unwrap().len();
    let again = client
        .tool(
            "delegate",
            json!({"agent": "codex-acp", "task": "reply:again"}),
        )
        .await;
    assert_eq!(structured(&again)["connectionId"], connection);
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    let later = h.tool_events.lock().unwrap()[before..].to_vec();
    assert!(!later
        .iter()
        .any(|e| matches!(e, DelegationEvent::Starting { .. })));
    h.lead_answers(&lead).await;
}

#[tokio::test]
async fn two_simultaneous_delegates_share_one_start() {
    let h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let starts = Arc::new(AtomicUsize::new(0));
    let background = BackgroundAgents::new(
        h.manager.clone(),
        launcher(&h, Duration::from_millis(400), starts.clone()),
    );
    let config = h.background_config(
        scaled(),
        vec![installed("codex-acp", worker(&["--name=codex"]))],
        &background,
    );
    let (_lead, server) = h.background_lead(&lead_connection, config).await;
    let (mut a, mut b) = (Client::new(&server), Client::new(&server));
    let (first, second) = tokio::join!(
        a.tool(
            "delegate",
            json!({"agent": "codex-acp", "task": "reply:one"})
        ),
        b.tool(
            "delegate",
            json!({"agent": "codex-acp", "task": "reply:two"})
        ),
    );
    assert_eq!(first["isError"], false, "{first}");
    assert_eq!(second["isError"], false, "{second}");
    assert_eq!(
        structured(&first)["connectionId"],
        structured(&second)["connectionId"]
    );
    assert_eq!(starts.load(Ordering::SeqCst), 1, "one process for both");
    assert_eq!(h.manager.connections().len(), 2);
    let events = h.tool_events.lock().unwrap().clone();
    let launched: Vec<bool> = events
        .iter()
        .filter_map(|e| match e {
            DelegationEvent::StartFinished { launched, .. } => Some(*launched),
            _ => None,
        })
        .collect();
    assert_eq!(launched.iter().filter(|l| **l).count(), 1, "{events:?}");
}

#[tokio::test]
async fn a_delegate_during_a_warm_start_waits_for_it() {
    let h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let starts = Arc::new(AtomicUsize::new(0));
    let background = BackgroundAgents::new(
        h.manager.clone(),
        launcher(&h, Duration::from_millis(400), starts.clone()),
    );
    let codex = installed("codex-acp", worker(&["--name=codex"]));
    let config = h.background_config(scaled(), vec![codex.clone()], &background);
    let (_lead, server) = h.background_lead(&lead_connection, config).await;
    background.warm(
        vec![codex],
        Duration::from_millis(300),
        4,
        Duration::from_secs(20),
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(background.state("codex-acp"), BackgroundState::Starting);
    let delegated = Client::new(&server)
        .tool(
            "delegate",
            json!({"agent": "codex-acp", "task": "reply:warm"}),
        )
        .await;
    assert_eq!(delegated["isError"], false, "{delegated}");
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    let events = h.tool_events.lock().unwrap().clone();
    assert!(events.iter().any(|e| matches!(
        e,
        DelegationEvent::StartFinished {
            launched: false,
            reason: None,
            ..
        }
    )));
}

#[tokio::test]
async fn warm_starts_initialize_only_one_at_a_time_and_at_most_the_cap() {
    let h = harness();
    let starts = Arc::new(AtomicUsize::new(0));
    let background = BackgroundAgents::new(
        h.manager.clone(),
        launcher(&h, Duration::ZERO, starts.clone()),
    );
    let agents: Vec<InstalledAgent> = (1..=5)
        .map(|n| installed(&format!("agent-{n}"), worker(&[&format!("--name=a{n}")])))
        .collect();
    background.warm(
        agents,
        Duration::from_millis(300),
        4,
        Duration::from_secs(20),
    );
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(starts.load(Ordering::SeqCst) <= 1, "staggered");
    let deadline = Instant::now() + Duration::from_secs(20);
    while background.connections().len() < 4 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(background.connections().len(), 4);
    assert_eq!(background.state("agent-5"), BackgroundState::Idle);
    // Initialize only: no session was opened on any warm connection.
    assert!(h.manager.sessions().is_empty());
    background.shutdown();
    assert!(background.connections().is_empty());
    assert!(h.manager.connections().iter().all(|c| !c.open) || h.manager.connections().is_empty());
}

#[tokio::test]
async fn a_failed_start_maps_to_a_closed_reason_and_the_lead_keeps_working() {
    let mut h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let manager = h.manager.clone();
    let workspace = h.workspace.clone();
    let cwd = h.directory.path().to_string_lossy().into_owned();
    // "hang" never finishes starting; the others start their own command.
    let launch: LaunchFn = Arc::new(move |agent: InstalledAgent, sink| {
        let (manager, workspace, cwd) = (manager.clone(), workspace.clone(), cwd.clone());
        Box::pin(async move {
            if agent.id == "hang" {
                std::future::pending::<()>().await;
            }
            manager
                .connect(agent.launch, cwd, workspace, Some(sink))
                .await
        })
    });
    let background = BackgroundAgents::new(h.manager.clone(), launch);
    let missing = AgentCommand {
        command: "span-agent-that-does-not-exist".into(),
        args: Vec::new(),
        env: BTreeMap::new(),
    };
    let policy = ToolPolicy {
        launch_timeout_seconds: 300,
        ..scaled()
    };
    let config = h.background_config(
        policy,
        vec![
            installed("missing", missing),
            installed("hang", worker(&["--name=hang"])),
            installed("locked", worker(&["--name=locked", "--auth-required"])),
        ],
        &background,
    );
    let (lead, server) = h.background_lead(&lead_connection, config).await;
    let mut client = Client::new(&server);
    for (agent, reason, says) in [
        ("missing", "agent_unavailable", "not installed"),
        ("hang", "timeout", "did not start in time"),
        ("locked", "auth_required", "Authentication required"),
    ] {
        let started = Instant::now();
        let result = client
            .tool("delegate", json!({"agent": agent, "task": "reply:x"}))
            .await;
        assert!(started.elapsed() < Duration::from_secs(10), "{agent} hung");
        assert_eq!(result["isError"], true, "{agent}: {result}");
        assert_eq!(structured(&result)["reason"], reason, "{agent}: {result}");
        let detail = structured(&result)["detail"].as_str().unwrap();
        assert!(detail.contains(says), "{agent}: {detail}");
    }
    let events = h.tool_events.lock().unwrap().clone();
    assert!(events.iter().any(|e| matches!(e, DelegationEvent::StartFinished { agent_id, reason: Some(_), .. } if agent_id == "missing")));
    // A failed start is quiet: listed as unavailable, retried on demand.
    let listed = client.tool("list_agents", json!({})).await;
    let agents = structured(&listed)["agents"].as_array().unwrap().clone();
    let missing = agents.iter().find(|a| a["id"] == "missing").unwrap();
    assert_eq!(missing["state"], "unavailable");
    assert_eq!(missing["delegable"], true);
    h.lead_answers(&lead).await;
}

#[tokio::test]
async fn a_child_cannot_start_agents_unless_depth_allows() {
    let h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let starts = Arc::new(AtomicUsize::new(0));
    let background = BackgroundAgents::new(
        h.manager.clone(),
        launcher(&h, Duration::ZERO, starts.clone()),
    );
    // A server bound to a delegated child (depth 1) with the default max depth 1.
    let (lead, lead_server) = h
        .background_lead(
            &lead_connection,
            h.background_config(scaled(), Vec::new(), &background),
        )
        .await;
    drop(lead_server);
    let control = h.manager.agent_control(lead).unwrap();
    let child = control.delegate(&lead_connection).await.unwrap();
    let server = ToolServer::start(
        &h.manager,
        &lead_connection,
        h.background_config(
            scaled(),
            vec![installed("codex-acp", worker(&["--name=codex"]))],
            &background,
        ),
    )
    .await
    .unwrap();
    server.bind(&h.manager, child).unwrap();
    let result = Client::new(&server)
        .tool("delegate", json!({"agent": "codex-acp", "task": "reply:x"}))
        .await;
    assert_eq!(structured(&result)["reason"], "depth_exceeded");
    assert_eq!(starts.load(Ordering::SeqCst), 0, "nothing was started");
}

#[tokio::test]
async fn delegation_off_exposes_no_tool() {
    let mut h = harness();
    let connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let leads = LeadServers::default();
    let (key, outcome) = leads
        .open_lead(&h.manager, &connection, None)
        .await
        .unwrap();
    assert_eq!(outcome, span_acp::tools::LeadDelegation::Off);
    assert!(!leads.attached(&key));
    assert_eq!(h.servers_of(&key).await, json!([]));
}

#[tokio::test]
async fn background_connections_forward_only_child_requests_until_promoted() {
    let mut h = harness();
    let lead_connection = h.connect(&["--name=lead", "--mcp-http"]).await;
    let background = BackgroundAgents::new(
        h.manager.clone(),
        launcher(&h, Duration::ZERO, Arc::default()),
    );
    let forwarded: Arc<Mutex<Vec<AgentEvent>>> = Arc::default();
    let sink = forwarded.clone();
    background.set_child_sink(Some(Arc::new(move |event| {
        sink.lock().unwrap().push(event)
    })));
    let config = h.background_config(
        scaled(),
        vec![installed("codex-acp", worker(&["--name=codex"]))],
        &background,
    );
    let (_lead, server) = h.background_lead(&lead_connection, config).await;
    let mut client = Client::new(&server);
    let delegated = client
        .tool(
            "delegate",
            json!({"agent": "codex-acp", "task": "permission"}),
        )
        .await;
    let session = structured(&delegated)["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let connection = structured(&delegated)["connectionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let asked = h
        .next(|e| e.connection_id == connection && matches!(e.event, AgentEvent::Permission { .. }))
        .await;
    let AgentEvent::Permission { request_id, .. } = asked.event else {
        unreachable!()
    };
    let seen = forwarded.lock().unwrap().clone();
    assert!(
        seen.iter().all(
            |e| matches!(e, AgentEvent::Permission { session_id, .. } if *session_id == session)
        ),
        "{seen:?}"
    );
    assert_eq!(seen.len(), 1);
    // The user answers it through the manager, as agent_child_permission does.
    h.manager
        .respond_permission(
            &SessionKey::new(connection.clone(), session),
            request_id,
            None,
        )
        .unwrap();

    // Promoted, the UI first gets the identity it missed, then everything.
    let primary: Arc<Mutex<Vec<AgentEvent>>> = Arc::default();
    let sink = primary.clone();
    let promoted = background
        .promote(
            "codex-acp",
            Arc::new(move |event| sink.lock().unwrap().push(event)),
        )
        .unwrap();
    assert_eq!(promoted, connection);
    let replayed = primary.lock().unwrap().clone();
    assert!(
        replayed.iter().any(
            |e| matches!(e, AgentEvent::Ready { agent_name: Some(name), .. } if name == "codex")
        ),
        "{replayed:?}"
    );
}
