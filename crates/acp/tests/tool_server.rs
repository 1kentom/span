//! Process and HTTP level tests for the span-agents MCP tool server (#52,
//! #53). Agents are real Node subprocesses (tests/fixtures/worker.mjs); the
//! MCP client is reqwest over real loopback HTTP, or the lead fixture
//! process itself using Node's fetch.
//!
//! Time scaling: tests that need minutes long children set
//! `ToolPolicy::second` to 10 ms, so one policy second (the unit of
//! `waitSeconds`, budgets and progress intervals) is 10 ms of real time.
use serde_json::{json, Value};
use span_acp::tools::{ToolEvent, ToolPolicy, ToolServer, ToolServerConfig};
use span_acp::{AgentCommand, AgentEvent, SessionEvent, SessionKey, SessionManager, SessionOrigin};
use span_core::CoreWorkspace;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

struct Harness {
    directory: tempfile::TempDir,
    workspace: Arc<Mutex<CoreWorkspace>>,
    manager: SessionManager,
    events: mpsc::UnboundedReceiver<SessionEvent>,
    tool_events: Arc<Mutex<Vec<ToolEvent>>>,
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
            installed: vec![span_acp::InstalledAgent {
                id: "gemini-cli".into(),
                version: "1.0.0".into(),
                launch: worker(&[]),
            }],
            events: Some(Arc::new(move |event| sink.lock().unwrap().push(event))),
        }
    }

    /// A lead session with a bound server, started in the order the desktop
    /// would: server first (its entry goes into session/new), then bind.
    async fn lead(&self, connection: &str, policy: ToolPolicy) -> (SessionKey, ToolServer) {
        let server = ToolServer::start(&self.manager, connection, self.config(policy))
            .await
            .expect("start span-agents");
        let lead = self
            .manager
            .open_session(connection, None, SessionOrigin::User)
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
        .any(|e| matches!(e, ToolEvent::Delegated { task_id, .. } if *task_id == task)));
    assert!(events.iter().any(|e| matches!(e, ToolEvent::TaskFinished { task_id, status, .. } if *task_id == task && status == "completed")));
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
    assert!(events.iter().any(|e| matches!(e, ToolEvent::Decision { lead: l, decision } if *l == lead && decision.chosen == "ropey")));
    assert_eq!(h.manager.sessions().len(), before, "no side effects");
    let missing = client
        .rpc(
            "tools/call",
            json!({"name": "record_decision", "arguments": {"chosen": "x"}}),
        )
        .await;
    assert_eq!(missing.response["error"]["code"], -32602);
}
