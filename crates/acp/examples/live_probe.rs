//! Live ACP probe: drives one real agent through Span's own client code
//! (SessionManager, AgentService, the adapter layer and the span-agents tool
//! server) and records the raw JSON-RPC lines and the normalised events.
//!
//! Usage: cargo run -p span-acp --example live_probe -- AGENT OUT_DIR
//! AGENT is one of opencode, gemini, claude, codex. OUT_DIR must not exist;
//! the agent workspace is OUT_DIR/workspace and holds only hello.txt.
//!
//! Safety: every permission request is rejected, except the read-only
//! span-agents `list_agents` tool during the MCP step (allow_once only).
//! Elicitations are declined. Every prompt has a 90 second limit. No
//! credentials are read; the span-agents bearer token is scrubbed from every
//! file this probe writes. Child processes are terminated at the end.
use serde_json::{json, Value};
use span_acp::tools::{ToolPolicy, ToolServer, ToolServerConfig};
use span_acp::{AgentCommand, AgentEvent, ConfigOption, SessionKey, SessionManager, SessionOrigin};
use span_core::CoreWorkspace;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

const PROMPT_LIMIT: Duration = Duration::from_secs(90);
const PONG: &str = "Reply with exactly the single word PONG. Do not use any tools.";
const READ: &str =
    "Use your file read tool to read hello.txt in the current directory and tell me its content.";
const COUNT: &str = "Count from 1 to 300, one number per line, slowly.";
const LIST: &str = "Call the list_agents tool from the span-agents MCP server and report the agent names. Do not call any other tool.";

type Res<T> = Result<T, String>;

/// Append-only NDJSON files with one shared sequence and clock.
struct Recorder {
    start: Instant,
    seq: AtomicU64,
    files: HashMap<&'static str, Mutex<File>>,
    secrets: Mutex<Vec<String>>,
    config: Mutex<HashMap<String, Vec<ConfigOption>>>,
}

impl Recorder {
    fn new(dir: &Path) -> Res<Self> {
        let mut files = HashMap::new();
        for name in ["wire", "events", "probe", "mcp"] {
            let file =
                File::create(dir.join(format!("{name}.ndjson"))).map_err(|e| e.to_string())?;
            files.insert(name, Mutex::new(file));
        }
        Ok(Self {
            start: Instant::now(),
            seq: AtomicU64::new(0),
            files,
            secrets: Mutex::new(Vec::new()),
            config: Mutex::new(HashMap::new()),
        })
    }

    fn ms(&self) -> u128 {
        self.start.elapsed().as_millis()
    }

    fn secret(&self, value: String) {
        if !value.is_empty() {
            self.secrets
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(value);
        }
    }

    fn write(&self, file: &str, mut value: Value) {
        let wall = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        value["seq"] = json!(self.seq.fetch_add(1, Ordering::SeqCst));
        value["tMs"] = json!(self.ms());
        value["wallMs"] = json!(wall);
        let mut line = value.to_string();
        for secret in self
            .secrets
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
        {
            line = line.replace(secret.as_str(), "[redacted-token]");
        }
        if let Some(file) = self.files.get(file) {
            let mut file = file.lock().unwrap_or_else(|p| p.into_inner());
            let _ = writeln!(file, "{line}");
        }
    }

    fn mark(&self, step: &str, detail: Value) {
        println!("[{:>7} ms] {step}: {detail}", self.ms());
        self.write("probe", json!({"step": step, "detail": detail}));
    }
}

fn launch(agent: &str) -> Res<AgentCommand> {
    let (command, args, env): (&str, Vec<&str>, Vec<(&str, &str)>) = match agent {
        // The user's global OpenCode config allows every tool. This
        // process-local override makes OpenCode ask, so the probe can reject.
        "opencode" => (
            "opencode",
            vec!["acp"],
            vec![(
                "OPENCODE_CONFIG_CONTENT",
                r#"{"permission":{"*":"ask","read":"ask","edit":{"*":"ask"},"bash":{"*":"ask"},"webfetch":"ask"}}"#,
            )],
        ),
        "gemini" => ("gemini", vec!["--acp"], vec![]),
        "claude" => (
            "npx",
            vec!["-y", "@agentclientprotocol/claude-agent-acp@0.98.0"],
            vec![],
        ),
        "codex" => (
            "npx",
            vec!["-y", "@agentclientprotocol/codex-acp@2.3.0"],
            vec![],
        ),
        other => return Err(format!("Unknown agent {other}")),
    };
    Ok(AgentCommand {
        command: command.into(),
        args: args.into_iter().map(str::to_owned).collect(),
        env: env
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect::<BTreeMap<_, _>>(),
    })
}

/// What the event loop knows while a step runs.
struct Ctx {
    manager: SessionManager,
    rec: Arc<Recorder>,
    events: mpsc::UnboundedReceiver<AgentEvent>,
    step: String,
    allow_list_agents: bool,
    completes: Vec<(u128, String, String)>,
}

impl Ctx {
    async fn handle(&mut self, event: AgentEvent) {
        match event {
            AgentEvent::Permission {
                session_id,
                request_id,
                title,
                options,
                tool_kind,
                raw_input,
                content,
                meta,
                ..
            } => {
                let hay = format!(
                    "{title} {} {} {}",
                    raw_input.clone().unwrap_or(Value::Null),
                    content.clone().unwrap_or(Value::Null),
                    meta.clone().unwrap_or(Value::Null)
                )
                .to_lowercase();
                let list_agents = self.allow_list_agents
                    && hay.contains("list_agents")
                    && (hay.contains("span-agents") || hay.contains("span_agents"))
                    && !hay.contains("delegate")
                    && !hay.contains("record_decision");
                let wanted = if list_agents {
                    "allow_once"
                } else {
                    "reject_once"
                };
                let choice = options
                    .iter()
                    .find(|o| o.kind == wanted)
                    .map(|o| o.option_id.clone());
                let kinds: Vec<&str> = options.iter().map(|o| o.kind.as_str()).collect();
                let connection = self.connection_of(&session_id);
                let mut result = Err(String::from("no connection"));
                if let Some(connection) = connection {
                    let key = SessionKey::new(connection, session_id.clone());
                    for _ in 0..40 {
                        result = self.manager.respond_permission(
                            &key,
                            request_id.clone(),
                            choice.clone(),
                        );
                        if result.is_ok() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(25)).await;
                    }
                }
                self.rec.mark(
                    "permission-decision",
                    json!({"step": self.step, "requestId": request_id, "title": title,
                        "toolKind": tool_kind, "optionKinds": kinds,
                        "decision": if list_agents { "allow_once (span-agents list_agents)" } else { "reject" },
                        "optionId": choice, "result": format!("{result:?}")}),
                );
            }
            AgentEvent::Elicitation {
                request_id,
                session_id,
                ..
            } => {
                let connection = session_id
                    .as_deref()
                    .and_then(|s| self.connection_of(s))
                    .or_else(|| {
                        self.manager
                            .connections()
                            .into_iter()
                            .find(|c| c.open)
                            .map(|c| c.connection_id)
                    });
                let result = connection
                    .map(|c| {
                        self.manager.respond_elicitation(
                            &c,
                            request_id.clone(),
                            "decline".into(),
                            None,
                        )
                    })
                    .unwrap_or(Err("no connection".into()));
                self.rec.mark(
                    "elicitation-declined",
                    json!({"requestId": request_id, "result": format!("{result:?}")}),
                );
            }
            AgentEvent::Proposal { proposal, .. } => {
                self.rec
                    .mark("proposal-seen-left-pending", json!({"id": proposal.id}));
            }
            AgentEvent::Complete {
                session_id,
                stop_reason,
                ..
            } => self
                .completes
                .push((self.rec.ms(), session_id, stop_reason)),
            _ => {}
        }
    }

    fn connection_of(&self, session_id: &str) -> Option<String> {
        self.manager
            .sessions()
            .into_iter()
            .find(|s| s.key.session_id == session_id)
            .map(|s| s.key.connection_id)
    }

    /// Handle events until `until` passes.
    async fn drain(&mut self, period: Duration) {
        let until = tokio::time::Instant::now() + period;
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(until) => break,
                event = self.events.recv() => match event {
                    Some(event) => self.handle(event).await,
                    None => break,
                },
            }
        }
    }

    /// Run one prompt with the 90 second limit. Cancels on timeout.
    async fn prompt(&mut self, key: &SessionKey, step: &str, text: &str) -> Value {
        self.step = step.into();
        let started = self.rec.ms();
        self.rec
            .mark(&format!("{step}-start"), json!({"session": key.session_id}));
        let rx = match self.manager.enqueue(key, text.into(), vec![]) {
            Ok(rx) => rx,
            Err(error) => {
                self.rec.mark(&format!("{step}-refused"), json!(error));
                return json!({"error": error});
            }
        };
        tokio::pin!(rx);
        let deadline = tokio::time::sleep(PROMPT_LIMIT);
        tokio::pin!(deadline);
        let mut timed_out = false;
        let outcome = loop {
            tokio::select! {
                result = &mut rx => break result.map_err(|e| e.to_string()).and_then(|r| r),
                event = self.events.recv() => if let Some(event) = event { self.handle(event).await },
                _ = &mut deadline => {
                    if timed_out {
                        break Err("No answer 15 s after the timeout cancel".into());
                    }
                    timed_out = true;
                    self.rec.mark(&format!("{step}-timeout-cancel"), json!(self.manager.cancel(key)));
                    deadline.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(15));
                }
            }
        };
        let summary = json!({"result": format!("{outcome:?}"), "elapsedMs": self.rec.ms() - started, "timedOut": timed_out});
        self.rec.mark(&format!("{step}-end"), summary.clone());
        summary
    }

    /// Start a long prompt, cancel it after two seconds, time the response.
    async fn cancel_probe(&mut self, key: &SessionKey) -> Value {
        self.step = "cancel".into();
        self.rec.mark("cancel-prompt-start", json!({}));
        let rx = match self.manager.enqueue(key, COUNT.into(), vec![]) {
            Ok(rx) => rx,
            Err(error) => return json!({"error": error}),
        };
        tokio::pin!(rx);
        let fire = tokio::time::sleep(Duration::from_secs(2));
        tokio::pin!(fire);
        let mut cancel_at: Option<u128> = None;
        let limit = tokio::time::sleep(Duration::from_secs(30));
        tokio::pin!(limit);
        let outcome = loop {
            tokio::select! {
                result = &mut rx => break result.map_err(|e| e.to_string()).and_then(|r| r),
                event = self.events.recv() => if let Some(event) = event { self.handle(event).await },
                _ = &mut fire, if cancel_at.is_none() => {
                    cancel_at = Some(self.rec.ms());
                    let sent = self.manager.cancel(key);
                    self.rec.mark("cancel-sent", json!(format!("{sent:?}")));
                }
                _ = &mut limit => break Err("No prompt response within 30 s".into()),
            }
        };
        let done = self.rec.ms();
        let stop = self
            .completes
            .iter()
            .rev()
            .find(|c| c.1 == key.session_id)
            .map(|c| c.2.clone());
        let summary = json!({
            "result": format!("{outcome:?}"),
            "cancelAtMs": cancel_at,
            "resolvedAtMs": done,
            "cancelToResolveMs": cancel_at.map(|c| done - c),
            "lastStopReason": stop,
            "finishedBeforeCancel": cancel_at.is_none(),
        });
        self.rec.mark("cancel-end", summary.clone());
        summary
    }

    /// Put the session in the agent's asking mode. The user's global
    /// configs set Claude to bypassPermissions and Codex to full access;
    /// the probe never runs tool prompts in those modes.
    async fn make_safe(&mut self, key: &SessionKey) -> bool {
        // PROBE_MODEL picks a model through the normal config path, for an
        // agent whose default model has no sign-in.
        if let Ok(model) = std::env::var("PROBE_MODEL") {
            let result = match self.manager.service(&key.connection_id) {
                Some(service) => {
                    service
                        .set_config(key.session_id.clone(), "model".into(), model.clone())
                        .await
                }
                None => Err("no service".into()),
            };
            self.rec.mark(
                "model-set",
                json!({"model": model, "result": format!("{result:?}")}),
            );
        }
        let options = self
            .rec
            .config
            .lock()
            .map(|c| c.get(&key.session_id).cloned().unwrap_or_default())
            .unwrap_or_default();
        let Some(mode) = options
            .iter()
            .find(|o| o.category.as_deref() == Some("mode") || o.id == "mode")
            .cloned()
        else {
            self.rec
                .mark("mode", json!({"note": "no mode option advertised", "options": options.iter().map(|o| &o.id).collect::<Vec<_>>()}));
            return true;
        };
        let values: Vec<String> = mode
            .groups
            .iter()
            .flat_map(|g| g.choices.iter().map(|c| c.value.clone()))
            .collect();
        let preferred = ["default", "read-only", "readonly", "read_only", "ask"]
            .iter()
            .find(|p| values.iter().any(|v| v == *p))
            .map(|p| (*p).to_owned());
        self.rec.mark(
            "mode-before",
            json!({"id": mode.id, "current": mode.current_value, "choices": values, "target": preferred}),
        );
        if let Some(target) = preferred.filter(|t| *t != mode.current_value) {
            let result = match self.manager.service(&key.connection_id) {
                Some(service) => {
                    service
                        .set_config(key.session_id.clone(), mode.id.clone(), target.clone())
                        .await
                }
                None => Err("no service".into()),
            };
            self.rec.mark(
                "mode-set",
                json!({"target": target, "result": format!("{result:?}")}),
            );
            self.drain(Duration::from_millis(300)).await;
        }
        let current = self
            .rec
            .config
            .lock()
            .ok()
            .and_then(|c| c.get(&key.session_id).cloned())
            .and_then(|o| o.into_iter().find(|o| o.id == mode.id))
            .map(|o| o.current_value)
            .unwrap_or_default();
        let lower = current.to_lowercase();
        let unsafe_mode = [
            "bypass", "full", "yolo", "never", "dontask", "dont_ask", "accept",
        ]
        .iter()
        .any(|u| lower.contains(u));
        self.rec.mark(
            "mode-after",
            json!({"current": current, "safe": !unsafe_mode}),
        );
        !unsafe_mode
    }
}

/// A logging MCP proxy between the agent and the span-agents server. It
/// rewrites `Host` (and `Origin` when present) to the upstream port so the
/// server's DNS rebinding checks pass, and never logs `Authorization`.
async fn start_proxy(upstream: u16, rec: Arc<Recorder>) -> Res<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    tokio::spawn(async move {
        let mut n = 0u64;
        while let Ok((client, _)) = listener.accept().await {
            n += 1;
            tokio::spawn(proxy_connection(n, client, upstream, rec.clone()));
        }
    });
    Ok(port)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

async fn proxy_connection(n: u64, mut client: TcpStream, upstream: u16, rec: Arc<Recorder>) {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let split = loop {
        match client.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(k) => buffer.extend_from_slice(&chunk[..k]),
        }
        if let Some(position) = find(&buffer, b"\r\n\r\n") {
            break position + 4;
        }
        if buffer.len() > 65_536 {
            return;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..split]).into_owned();
    let mut rewritten = Vec::new();
    let mut logged = Vec::new();
    for line in head.split("\r\n") {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("host:") {
            rewritten.push(format!("Host: 127.0.0.1:{upstream}"));
            logged.push(format!("{line}  [proxy rewrote to upstream port]"));
        } else if lower.starts_with("origin:") {
            rewritten.push(format!("Origin: http://127.0.0.1:{upstream}"));
            logged.push(format!("{line}  [proxy rewrote to upstream port]"));
        } else if lower.starts_with("authorization:") {
            rewritten.push(line.to_owned());
            logged.push("Authorization: [redacted]".into());
        } else {
            rewritten.push(line.to_owned());
            logged.push(line.to_owned());
        }
    }
    let rest = String::from_utf8_lossy(&buffer[split..]).into_owned();
    rec.write(
        "mcp",
        json!({"conn": n, "dir": "agent->span", "head": logged.join("\r\n"), "body": rest}),
    );
    let Ok(mut server) = TcpStream::connect(("127.0.0.1", upstream)).await else {
        rec.write(
            "mcp",
            json!({"conn": n, "error": "upstream connect failed"}),
        );
        return;
    };
    let mut first = rewritten.join("\r\n").into_bytes();
    first.extend_from_slice(&buffer[split..]);
    if server.write_all(&first).await.is_err() {
        return;
    }
    let (mut client_read, mut client_write) = client.into_split();
    let (mut server_read, mut server_write) = server.into_split();
    let up_rec = rec.clone();
    let upward = tokio::spawn(async move {
        let mut chunk = [0u8; 8192];
        loop {
            match client_read.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(k) => {
                    up_rec.write("mcp", json!({"conn": n, "dir": "agent->span", "data": String::from_utf8_lossy(&chunk[..k])}));
                    if server_write.write_all(&chunk[..k]).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
    let mut chunk = [0u8; 8192];
    loop {
        match server_read.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(k) => {
                rec.write(
                    "mcp",
                    json!({"conn": n, "dir": "span->agent", "data": String::from_utf8_lossy(&chunk[..k])}),
                );
                if client_write.write_all(&chunk[..k]).await.is_err() {
                    break;
                }
            }
        }
    }
    let _ = client_write.shutdown().await;
    upward.abort();
    rec.write("mcp", json!({"conn": n, "closed": true}));
}

/// Every live descendant of this process, as (pid, command).
fn descendants() -> Vec<(u32, String)> {
    let Ok(output) = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,command="])
        .output()
    else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let rows: Vec<(u32, u32, String)> = text
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let ppid = parts.next()?.parse().ok()?;
            Some((pid, ppid, parts.collect::<Vec<_>>().join(" ")))
        })
        .collect();
    let mut found = Vec::new();
    let mut frontier = vec![std::process::id()];
    let mut seen = HashSet::new();
    while let Some(parent) = frontier.pop() {
        for (pid, ppid, command) in &rows {
            if *ppid == parent && seen.insert(*pid) && !command.starts_with("ps -axo") {
                found.push((*pid, command.chars().take(120).collect()));
                frontier.push(*pid);
            }
        }
    }
    found
}

fn kill_descendants(rec: &Recorder) {
    for signal in ["-TERM", "-KILL"] {
        let left = descendants();
        rec.mark(
            "descendants",
            json!({"before": signal, "pids": left.iter().map(|(p, c)| json!({"pid": p, "command": c})).collect::<Vec<_>>()}),
        );
        if left.is_empty() {
            return;
        }
        for (pid, _) in left {
            let _ = std::process::Command::new("kill")
                .args([signal, &pid.to_string()])
                .status();
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    rec.mark(
        "descendants-final",
        json!(descendants().iter().map(|(p, _)| p).collect::<Vec<_>>()),
    );
}

async fn connect(
    manager: &SessionManager,
    rec: &Recorder,
    agent: &str,
    root: &str,
    workspace: &Arc<Mutex<CoreWorkspace>>,
    sink: span_acp::EventSink,
) -> Res<(String, span_acp::AgentFeatures)> {
    let started = rec.ms();
    let connection = manager
        .connect(launch(agent)?, root.into(), workspace.clone(), Some(sink))
        .await;
    rec.mark(
        "connect",
        json!({"result": format!("{connection:?}"), "elapsedMs": rec.ms() - started}),
    );
    let connection = connection?;
    // `connect` can return before the Ready event reached the manager, so
    // `ConnectionInfo.features` may still be None here. Record and wait.
    let immediate = manager
        .connection(&connection)
        .is_some_and(|c| c.features.is_some());
    let mut features = None;
    for _ in 0..100 {
        features = manager.connection(&connection).and_then(|c| c.features);
        if features.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    rec.mark(
        "features",
        json!({"featuresSetWhenConnectReturned": immediate, "features": features}),
    );
    Ok((connection, features.unwrap_or_default()))
}

async fn open(
    ctx: &mut Ctx,
    connection: &str,
    servers: Vec<Value>,
    label: &str,
) -> Option<SessionKey> {
    let started = ctx.rec.ms();
    let key = ctx
        .manager
        .open_session_with(connection, None, SessionOrigin::User, servers)
        .await;
    ctx.rec.mark(
        label,
        json!({"result": format!("{key:?}"), "elapsedMs": ctx.rec.ms() - started}),
    );
    ctx.drain(Duration::from_millis(1500)).await;
    key.ok()
}

async fn probe(agent: &str, out: &Path) -> Res<()> {
    let root_dir = out.join("workspace");
    std::fs::create_dir_all(&root_dir).map_err(|e| e.to_string())?;
    std::fs::write(root_dir.join("hello.txt"), "hello").map_err(|e| e.to_string())?;
    let root_dir = std::fs::canonicalize(&root_dir).map_err(|e| e.to_string())?;
    let root = root_dir.to_string_lossy().into_owned();
    let rec = Arc::new(Recorder::new(out)?);
    rec.mark("start", json!({"agent": agent, "launch": launch(agent)?}));
    let workspace = Arc::new(Mutex::new(
        CoreWorkspace::open(&root_dir)
            .map_err(|e| e.to_string())?
            .with_user_settings(None),
    ));
    let (tx, events) = mpsc::unbounded_channel();
    let sink_rec = rec.clone();
    let sink: span_acp::EventSink = Arc::new(move |event: AgentEvent| {
        match &event {
            AgentEvent::Log { direction, line } => {
                let truncated = line.chars().count() >= 16_384;
                sink_rec.write(
                    "wire",
                    json!({"dir": direction, "line": line, "truncatedBySpan": truncated}),
                );
                return;
            }
            AgentEvent::Config {
                session_id,
                options,
            } => {
                if let Ok(mut config) = sink_rec.config.lock() {
                    config.insert(session_id.clone(), options.clone());
                }
            }
            _ => {}
        }
        sink_rec.write(
            "events",
            json!({"event": serde_json::to_value(&event).unwrap_or(Value::Null)}),
        );
        let _ = tx.send(event);
    });
    let manager = SessionManager::new(Arc::new(|_| {}));
    let mut ctx = Ctx {
        manager: manager.clone(),
        rec: rec.clone(),
        events,
        step: "setup".into(),
        allow_list_agents: false,
        completes: Vec::new(),
    };
    let mut summary = serde_json::Map::new();

    // 1. initialize and session/new
    let (connection, features) =
        match connect(&manager, &rec, agent, &root, &workspace, sink.clone()).await {
            Ok(value) => value,
            Err(error) => {
                summary.insert("connect".into(), json!(error));
                rec.mark("summary", Value::Object(summary));
                kill_descendants(&rec);
                return Err(error);
            }
        };
    ctx.drain(Duration::from_millis(500)).await;
    let session = open(&mut ctx, &connection, vec![], "session-new").await;
    if let Some(key) = session.clone() {
        let safe = ctx.make_safe(&key).await;
        summary.insert("safeMode".into(), json!(safe));
        // 2. no tools
        summary.insert("prompt1".into(), ctx.prompt(&key, "prompt1", PONG).await);
        // 3. permission
        if safe {
            summary.insert("prompt2".into(), ctx.prompt(&key, "prompt2", READ).await);
        } else {
            rec.mark(
                "prompt2-skipped",
                json!("session mode could not be made to ask"),
            );
        }
        // 4. cancel
        summary.insert("cancel".into(), ctx.cancel_probe(&key).await);
        ctx.drain(Duration::from_secs(3)).await;
        // 5a. list on the same process
        if features.can_list_sessions {
            if let Some(service) = manager.service(&connection) {
                let listed = service.list_sessions().await;
                let found = listed
                    .as_ref()
                    .map(|l| l.iter().any(|s| s.session_id == key.session_id));
                rec.mark(
                    "list-sessions",
                    json!({"result": format!("{listed:?}"), "containsProbeSession": format!("{found:?}")}),
                );
            }
        }
    }
    rec.mark(
        "disconnect-1",
        json!(format!("{:?}", manager.disconnect(&connection))),
    );
    ctx.drain(Duration::from_secs(3)).await;
    kill_descendants(&rec);

    // 5b. a fresh process restores the session, then close, delete, MCP.
    let (connection, features) =
        match connect(&manager, &rec, agent, &root, &workspace, sink.clone()).await {
            Ok(value) => value,
            Err(error) => {
                summary.insert("reconnect".into(), json!(error));
                rec.mark("summary", Value::Object(summary));
                kill_descendants(&rec);
                return Ok(());
            }
        };
    ctx.drain(Duration::from_millis(500)).await;
    let service = manager.service(&connection).ok_or("no service")?;
    if let Some(key) = &session {
        if features.can_list_sessions {
            let listed = service.list_sessions().await;
            let found = listed
                .as_ref()
                .map(|l| l.iter().any(|s| s.session_id == key.session_id));
            rec.mark(
                "list-sessions-new-process",
                json!({"result": format!("{listed:?}"), "containsProbeSession": format!("{found:?}")}),
            );
        }
        if features.load_session {
            ctx.step = "load".into();
            let started = rec.ms();
            rec.mark("load-start", json!({"session": key.session_id}));
            let loaded = service.load_session(key.session_id.clone()).await;
            rec.mark(
                "load-end",
                json!({"result": format!("{loaded:?}"), "elapsedMs": rec.ms() - started}),
            );
            let key2 = SessionKey::new(connection.clone(), key.session_id.clone());
            if loaded.is_ok() {
                let adopted = manager.adopt(key2.clone(), SessionOrigin::User);
                rec.mark("adopt", json!(format!("{adopted:?}")));
            }
            ctx.drain(Duration::from_secs(3)).await;
            rec.mark("load-drain-end", json!({}));
            if loaded.is_ok() {
                ctx.make_safe(&key2).await;
                summary.insert(
                    "promptAfterLoad".into(),
                    ctx.prompt(&key2, "prompt-after-load", PONG).await,
                );
            }
        }
        if features.can_close_sessions {
            let closed = service.close_session(key.session_id.clone()).await;
            rec.mark("close", json!(format!("{closed:?}")));
        }
        if features.can_delete_sessions {
            let deleted = service.delete_session(key.session_id.clone()).await;
            rec.mark("delete", json!(format!("{deleted:?}")));
            if features.can_list_sessions {
                let listed = service.list_sessions().await;
                let found = listed
                    .as_ref()
                    .map(|l| l.iter().any(|s| s.session_id == key.session_id));
                rec.mark(
                    "list-after-delete",
                    json!({"containsProbeSession": format!("{found:?}")}),
                );
            }
        }
        if features.can_resume_sessions {
            rec.mark(
                "resume",
                json!("advertised, but AgentService has no session/resume call; not exercised"),
            );
        }
        ctx.drain(Duration::from_secs(1)).await;
    }

    // 6. MCP
    if features.mcp_http {
        let events_rec = rec.clone();
        let config = ToolServerConfig {
            workspace: workspace.clone(),
            policy: ToolPolicy::default(),
            installed: Vec::new(),
            background: None,
            events: Some(Arc::new(move |event| {
                events_rec.write(
                    "events",
                    json!({"delegation": serde_json::to_value(&event).unwrap_or(Value::Null)}),
                )
            })),
        };
        match ToolServer::start(&manager, &connection, config).await {
            Ok(server) => {
                let mut entry = server.mcp_server_json();
                if let Some(value) = entry.pointer("/headers/0/value").and_then(Value::as_str) {
                    rec.secret(value.to_owned());
                    rec.secret(value.trim_start_matches("Bearer ").to_owned());
                }
                let upstream: u16 = server
                    .url()
                    .rsplit(':')
                    .next()
                    .and_then(|tail| tail.split('/').next())
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(0);
                let proxy = start_proxy(upstream, rec.clone()).await?;
                entry["url"] = json!(format!("http://127.0.0.1:{proxy}/mcp"));
                rec.mark(
                    "mcp-server",
                    json!({"upstreamPort": upstream, "proxyPort": proxy, "entryKeys": entry.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>())}),
                );
                if let Some(lead) =
                    open(&mut ctx, &connection, vec![entry], "session-new-mcp").await
                {
                    rec.mark(
                        "mcp-bind",
                        json!(format!("{:?}", server.bind(&manager, lead.clone()))),
                    );
                    if ctx.make_safe(&lead).await {
                        ctx.allow_list_agents = true;
                        summary.insert("mcp".into(), ctx.prompt(&lead, "mcp", LIST).await);
                        ctx.allow_list_agents = false;
                    } else {
                        rec.mark(
                            "mcp-skipped",
                            json!("session mode could not be made to ask"),
                        );
                    }
                    ctx.drain(Duration::from_secs(2)).await;
                    if features.can_close_sessions {
                        let closed = service.close_session(lead.session_id.clone()).await;
                        rec.mark("close-mcp-session", json!(format!("{closed:?}")));
                    }
                }
                server.shutdown();
            }
            Err(error) => rec.mark("mcp-server-refused", json!(error)),
        }
    } else {
        rec.mark("mcp-skipped", json!("mcpCapabilities.http not advertised"));
    }
    rec.mark(
        "disconnect-2",
        json!(format!("{:?}", manager.disconnect(&connection))),
    );
    ctx.drain(Duration::from_secs(3)).await;
    kill_descendants(&rec);
    rec.mark("summary", Value::Object(summary));
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let agent = args.next().ok_or("AGENT required")?;
    let out = PathBuf::from(args.next().ok_or("OUT_DIR required")?);
    if out.exists() {
        return Err("OUT_DIR already exists; use a fresh directory".into());
    }
    std::fs::create_dir_all(&out)?;
    probe(&agent, &out).await?;
    Ok(())
}
