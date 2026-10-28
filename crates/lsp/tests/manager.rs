//! Manager tests against a python fake language server.

mod common;

use lsp_types::*;
use serde_json::Value;
use span_lsp::path_to_uri;
use span_lsp::servers::manager::{
    LaunchResolver, Manager, ManagerConfig, ManagerError, ManagerEvent, ServerError, ServerState,
};
use span_lsp::servers::spec::{LaunchSpec, Runtime, RuntimeRequirement, ServerId, ServerSpec};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const ID: ServerId = ServerId::Json;
const WAIT: Duration = Duration::from_secs(15);

struct Resolver {
    mode: Mutex<&'static str>,
    log: PathBuf,
    missing: bool,
    resolves: AtomicUsize,
}

impl LaunchResolver for Resolver {
    async fn resolve(&self, _id: ServerId) -> Result<LaunchSpec, ServerError> {
        self.resolves.fetch_add(1, Ordering::SeqCst);
        if self.missing {
            return Err(ServerError::NotInstalled(ID));
        }
        let script =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-lsp-server.py");
        let (py, py_args) = common::python_args(&[
            script.to_string_lossy().into_owned(),
            (*self.mode.lock().unwrap()).to_string(),
        ]);
        Ok(LaunchSpec {
            program: PathBuf::from(py),
            args: py_args,
            env: vec![(
                "FAKE_LSP_LOG".into(),
                self.log.to_string_lossy().into_owned(),
            )],
        })
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    log: PathBuf,
    resolver: Arc<Resolver>,
    manager: Manager,
}

fn fixture_with(mode: &'static str, missing: bool) -> Fixture {
    fixture_full(mode, missing, Duration::from_secs(3))
}

fn fixture_with_grace(mode: &'static str, grace: Duration) -> Fixture {
    fixture_full(mode, false, grace)
}

fn fixture_full(mode: &'static str, missing: bool, grace: Duration) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let log = dir.path().join("server.log");
    let spec = ServerSpec {
        id: ID,
        display_name: "fake",
        language_ids: &["json"],
        extensions: &["json"],
        root_markers: &[],
        runtime: RuntimeRequirement {
            runtime: Runtime::None,
            min_major: 0,
        },
        initialization_options: Value::Null,
    };
    let resolver = Arc::new(Resolver {
        mode: Mutex::new(mode),
        log: log.clone(),
        missing,
        resolves: AtomicUsize::new(0),
    });
    let manager = Manager::new(
        vec![spec],
        resolver.clone(),
        ManagerConfig {
            init_timeout: Duration::from_secs(10),
            shutdown_grace: grace,
        },
    );
    Fixture {
        _dir: dir,
        root,
        log,
        resolver,
        manager,
    }
}

fn fixture(mode: &'static str) -> Fixture {
    fixture_with(mode, false)
}

impl Fixture {
    fn file(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    fn entries(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn methods(&self, method: &str) -> Vec<Value> {
        self.entries()
            .into_iter()
            .filter(|e| e["method"] == method)
            .collect()
    }

    async fn wait_log(&self, method: &str, count: usize) {
        let deadline = tokio::time::Instant::now() + WAIT;
        while self.methods(method).len() < count {
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for {method} x{count}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn ready(&self) {
        self.manager.start(ID, &self.root).await.unwrap();
        self.manager.wait_ready(ID, &self.root, WAIT).await.unwrap();
    }

    fn hover_params(&self, name: &str) -> HoverParams {
        HoverParams {
            text_document_position_params: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier {
                    uri: path_to_uri(&self.file(name)).unwrap(),
                },
                position: Position {
                    line: 0,
                    character: 0,
                },
            },
            work_done_progress_params: Default::default(),
        }
    }
}

fn full(text: &str) -> TextDocumentContentChangeEvent {
    TextDocumentContentChangeEvent {
        range: None,
        range_length: None,
        text: text.into(),
    }
}

#[tokio::test]
async fn starts_lazily_reuses_and_serves_requests() {
    let f = fixture("normal");
    assert_eq!(f.manager.state(ID, &f.root).await, None);
    assert!(
        f.entries().is_empty(),
        "nothing is spawned before first use"
    );

    f.ready().await;
    f.manager.start(ID, &f.root).await.unwrap();
    f.manager.wait_ready(ID, &f.root, WAIT).await.unwrap();
    assert_eq!(
        f.methods("initialize").len(),
        1,
        "second start reuses the process"
    );

    f.manager
        .open_document(ID, &f.root, &f.file("a.json"), "json", "{}".into())
        .await
        .unwrap();
    let hover = f
        .manager
        .hover(ID, &f.root, f.hover_params("a.json"), None)
        .await
        .unwrap();
    assert!(hover.is_some());

    f.manager.shutdown_all().await;
}

#[tokio::test]
async fn answers_server_requests_and_forwards_diagnostics() {
    let f = fixture("normal");
    let mut events = f.manager.subscribe();
    f.ready().await;
    f.wait_log("response", 1).await;
    let resp = &f.methods("response")[0];
    assert_eq!(resp["id"], "srv-1");
    assert_eq!(resp["result"], serde_json::json!([{}]));

    f.manager
        .open_document(ID, &f.root, &f.file("a.json"), "json", "{}".into())
        .await
        .unwrap();
    let got = tokio::time::timeout(WAIT, async {
        loop {
            if let Ok(ManagerEvent::Diagnostics { params, .. }) = events.recv().await {
                return params;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(got.diagnostics[0].message, "opened");
    f.manager.shutdown_all().await;
}

#[tokio::test]
async fn buffers_documents_while_starting_and_flushes_latest_text() {
    let f = fixture("slow-init");
    let path = f.file("a.json");
    f.manager
        .open_document(ID, &f.root, &path, "json", "one".into())
        .await
        .unwrap();
    assert_eq!(
        f.manager.state(ID, &f.root).await,
        Some(ServerState::Starting)
    );

    let err = f
        .manager
        .hover(ID, &f.root, f.hover_params("a.json"), None)
        .await
        .unwrap_err();
    assert!(
        matches!(err, ManagerError::NotReady(ServerState::Starting)),
        "{err:?}"
    );

    let v = f
        .manager
        .change_document(ID, &f.root, &path, vec![full("two")])
        .await
        .unwrap();
    assert_eq!(v, 2);
    f.manager.wait_ready(ID, &f.root, WAIT).await.unwrap();

    f.wait_log("textDocument/didOpen", 1).await;
    let opens = f.methods("textDocument/didOpen");
    assert_eq!(opens.len(), 1);
    assert_eq!(opens[0]["params"]["textDocument"]["text"], "two");
    assert_eq!(opens[0]["params"]["textDocument"]["version"], 2);
    assert!(f.methods("textDocument/didChange").is_empty());
    f.manager.shutdown_all().await;
}

#[tokio::test]
async fn forwards_changes_and_close_once_ready() {
    let f = fixture("normal");
    f.ready().await;
    let path = f.file("a.json");
    f.manager
        .open_document(ID, &f.root, &path, "json", "abc".into())
        .await
        .unwrap();
    let edit = TextDocumentContentChangeEvent {
        range: Some(Range::new(Position::new(0, 1), Position::new(0, 2))),
        range_length: None,
        text: "XY".into(),
    };
    let v = f
        .manager
        .change_document(ID, &f.root, &path, vec![edit])
        .await
        .unwrap();
    assert_eq!(v, 2);
    assert_eq!(
        f.manager.document_text(ID, &f.root, &path).await.as_deref(),
        Some("aXYc")
    );

    f.wait_log("textDocument/didChange", 1).await;
    let change = &f.methods("textDocument/didChange")[0];
    assert_eq!(change["params"]["textDocument"]["version"], 2);
    assert_eq!(change["params"]["contentChanges"][0]["text"], "XY");

    f.manager.close_document(ID, &f.root, &path).await.unwrap();
    f.wait_log("textDocument/didClose", 1).await;
    assert_eq!(f.manager.document_text(ID, &f.root, &path).await, None);
    f.manager.shutdown_all().await;
}

#[tokio::test]
async fn crash_is_reported_and_restart_reopens_buffers() {
    let f = fixture("normal");
    let path = f.file("a.json");
    f.manager
        .open_document(ID, &f.root, &path, "json", "crash".into())
        .await
        .unwrap();
    f.manager.wait_ready(ID, &f.root, WAIT).await.unwrap();

    // The fake server exits on hover over a document containing "crash".
    let err = f
        .manager
        .hover(ID, &f.root, f.hover_params("a.json"), None)
        .await
        .unwrap_err();
    assert!(matches!(err, ManagerError::ServerCrashed(_)), "{err:?}");

    let deadline = tokio::time::Instant::now() + WAIT;
    while f.manager.state(ID, &f.root).await != Some(ServerState::Crashed) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "never reached Crashed"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let err = f
        .manager
        .hover(ID, &f.root, f.hover_params("a.json"), None)
        .await
        .unwrap_err();
    assert!(matches!(err, ManagerError::ServerCrashed(_)), "{err:?}");

    // An edit made while the server is down is buffered and not lost.
    let v = f
        .manager
        .change_document(ID, &f.root, &path, vec![full("edited while down")])
        .await
        .unwrap();
    assert_eq!(v, 2);
    assert_eq!(f.methods("textDocument/didChange").len(), 0);

    f.ready().await;
    assert_eq!(f.methods("initialize").len(), 2);
    f.wait_log("textDocument/didOpen", 2).await;
    let opens = f.methods("textDocument/didOpen");
    assert_eq!(opens.len(), 2);
    assert_eq!(
        opens[1]["params"]["textDocument"]["text"],
        "edited while down"
    );
    assert_eq!(opens[1]["params"]["textDocument"]["version"], 2);
    assert_eq!(
        f.manager.document_text(ID, &f.root, &path).await.as_deref(),
        Some("edited while down")
    );
    f.manager.shutdown_all().await;
}

#[tokio::test]
async fn initialize_failure_is_reported() {
    let f = fixture("bad-init");
    f.manager.start(ID, &f.root).await.unwrap();
    let err = f.manager.wait_ready(ID, &f.root, WAIT).await.unwrap_err();
    assert!(matches!(err, ManagerError::InitializeFailed(_)), "{err:?}");
    assert!(matches!(
        f.manager.state(ID, &f.root).await,
        Some(ServerState::Failed(_))
    ));

    // Buffers survive Failed, and the caller is told the server is Failed.
    let path = f.file("a.json");
    let err = f
        .manager
        .open_document(ID, &f.root, &path, "json", "kept".into())
        .await
        .unwrap_err();
    assert!(
        matches!(err, ManagerError::NotReady(ServerState::Failed(_))),
        "{err:?}"
    );
    assert_eq!(
        f.manager.document_text(ID, &f.root, &path).await.as_deref(),
        Some("kept")
    );

    // The next successful start reopens the buffered document.
    *f.resolver.mode.lock().unwrap() = "normal";
    f.ready().await;
    f.wait_log("textDocument/didOpen", 1).await;
    let opens = f.methods("textDocument/didOpen");
    assert_eq!(opens.len(), 1);
    assert_eq!(opens[0]["params"]["textDocument"]["text"], "kept");
    f.manager.shutdown_all().await;
}

#[tokio::test]
async fn failed_instance_is_not_respawned_by_open_document() {
    let f = fixture("bad-init");
    f.manager.start(ID, &f.root).await.unwrap();
    f.manager.wait_ready(ID, &f.root, WAIT).await.unwrap_err();
    assert_eq!(f.resolver.resolves.load(Ordering::SeqCst), 1);
    assert_eq!(f.methods("initialize").len(), 1);

    for name in ["a.json", "b.json", "c.json"] {
        let err = f
            .manager
            .open_document(ID, &f.root, &f.file(name), "json", format!("text {name}"))
            .await
            .unwrap_err();
        assert!(
            matches!(err, ManagerError::NotReady(ServerState::Failed(_))),
            "{err:?}"
        );
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(f.resolver.resolves.load(Ordering::SeqCst), 1, "no respawn");
    assert_eq!(f.methods("initialize").len(), 1, "no respawn");
    for name in ["a.json", "b.json", "c.json"] {
        assert_eq!(
            f.manager
                .document_text(ID, &f.root, &f.file(name))
                .await
                .as_deref(),
            Some(format!("text {name}").as_str())
        );
    }

    // An explicit start replaces it and resends every buffered document.
    *f.resolver.mode.lock().unwrap() = "normal";
    f.ready().await;
    assert_eq!(f.resolver.resolves.load(Ordering::SeqCst), 2);
    f.wait_log("textDocument/didOpen", 3).await;
    let mut texts: Vec<String> = f
        .methods("textDocument/didOpen")
        .iter()
        .map(|e| {
            e["params"]["textDocument"]["text"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    texts.sort();
    assert_eq!(texts, ["text a.json", "text b.json", "text c.json"]);
    f.manager.shutdown_all().await;
}

#[tokio::test]
async fn edits_racing_a_restart_are_never_lost() {
    let f = fixture("normal");
    let path = f.file("a.json");
    f.manager
        .open_document(ID, &f.root, &path, "json", "crash".into())
        .await
        .unwrap();
    f.manager.wait_ready(ID, &f.root, WAIT).await.unwrap();
    f.manager
        .hover(ID, &f.root, f.hover_params("a.json"), None)
        .await
        .unwrap_err();
    let deadline = tokio::time::Instant::now() + WAIT;
    while f.manager.state(ID, &f.root).await != Some(ServerState::Crashed) {
        assert!(tokio::time::Instant::now() < deadline, "never Crashed");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    const EDITS: i32 = 80;
    let editor = {
        let manager = f.manager.clone();
        let root = f.root.clone();
        let path = path.clone();
        tokio::spawn(async move {
            let mut versions = Vec::new();
            for i in 0..EDITS {
                let v = manager
                    .change_document(ID, &root, &path, vec![full(&format!("edit-{i}"))])
                    .await
                    .expect("an edit must never be dropped");
                versions.push(v);
                tokio::time::sleep(Duration::from_millis(3)).await;
            }
            versions
        })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    f.manager.start(ID, &f.root).await.unwrap();
    let versions = editor.await.unwrap();
    f.manager.wait_ready(ID, &f.root, WAIT).await.unwrap();

    assert_eq!(versions, (2..2 + EDITS).collect::<Vec<_>>());
    let expected = format!("edit-{}", EDITS - 1);
    assert_eq!(
        f.manager.document_text(ID, &f.root, &path).await.as_deref(),
        Some(expected.as_str())
    );

    // Everything the restarted server saw: opened once, then monotonic changes ending
    // at the final buffer.
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let entries = f.entries();
        let second_init = entries
            .iter()
            .enumerate()
            .filter(|(_, e)| e["method"] == "initialize")
            .nth(1)
            .map(|(i, _)| i)
            .expect("restarted");
        let mut seen: Vec<(i64, String)> = Vec::new();
        for e in &entries[second_init..] {
            let m = e["method"].as_str().unwrap();
            if m == "textDocument/didOpen" {
                let d = &e["params"]["textDocument"];
                seen.push((
                    d["version"].as_i64().unwrap(),
                    d["text"].as_str().unwrap().into(),
                ));
            } else if m == "textDocument/didChange" {
                let d = &e["params"];
                seen.push((
                    d["textDocument"]["version"].as_i64().unwrap(),
                    d["contentChanges"][0]["text"].as_str().unwrap().into(),
                ));
            }
        }
        if seen.last().map(|(v, t)| (*v, t.as_str()))
            == Some((i64::from(EDITS) + 1, expected.as_str()))
        {
            assert!(seen.windows(2).all(|w| w[0].0 < w[1].0), "{seen:?}");
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "server never saw the final text: {seen:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    f.manager.shutdown_all().await;
}

#[tokio::test]
async fn resolver_failure_is_reported() {
    let f = fixture_with("normal", true);
    f.manager.start(ID, &f.root).await.unwrap();
    let err = f.manager.wait_ready(ID, &f.root, WAIT).await.unwrap_err();
    match err {
        ManagerError::InitializeFailed(m) => assert!(m.contains("not installed"), "{m}"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn unknown_server_is_rejected() {
    let f = fixture("normal");
    let err = f.manager.start(ServerId::Css, &f.root).await.unwrap_err();
    assert!(matches!(err, ManagerError::UnknownServer(ServerId::Css)));
}

#[tokio::test]
async fn unadvertised_capability_is_unsupported() {
    let f = fixture("nodef");
    f.ready().await;
    f.manager
        .open_document(ID, &f.root, &f.file("a.json"), "json", "{}".into())
        .await
        .unwrap();
    let params = GotoDefinitionParams {
        text_document_position_params: f.hover_params("a.json").text_document_position_params,
        work_done_progress_params: Default::default(),
        partial_result_params: Default::default(),
    };
    let err = f
        .manager
        .definition(ID, &f.root, params, None)
        .await
        .unwrap_err();
    assert!(matches!(err, ManagerError::Unsupported(_)), "{err:?}");
    f.manager.shutdown_all().await;
}

#[tokio::test]
async fn cancellation_sends_cancel_request() {
    let f = fixture("hang");
    f.ready().await;
    f.manager
        .open_document(ID, &f.root, &f.file("a.json"), "json", "{}".into())
        .await
        .unwrap();
    let token = CancellationToken::new();
    let t = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        t.cancel();
    });
    let err = f
        .manager
        .hover(ID, &f.root, f.hover_params("a.json"), Some(token))
        .await
        .unwrap_err();
    assert!(matches!(err, ManagerError::Cancelled), "{err:?}");
    f.wait_log("$/cancelRequest", 1).await;
    let hovers = f.methods("textDocument/hover");
    assert_eq!(hovers.len(), 1);
    let cancels = f.methods("$/cancelRequest");
    assert_eq!(cancels.len(), 1);
    assert!(hovers[0]["id"].is_number(), "{:?}", hovers[0]);
    assert_eq!(cancels[0]["params"]["id"], hovers[0]["id"]);
    f.manager.shutdown_all().await;
}

#[tokio::test]
async fn shutdown_all_sends_shutdown_and_exit() {
    let f = fixture("normal");
    f.ready().await;
    let pid = f.methods("initialize")[0]["pid"].as_u64().unwrap();
    assert!(
        common::process_exists(pid),
        "child should be running before shutdown"
    );
    f.manager.shutdown_all().await;
    assert!(
        !common::process_exists(pid),
        "child {pid} must have exited and been reaped (kill -0 on a zombie succeeds)"
    );
    assert_eq!(f.methods("shutdown").len(), 1);
    assert_eq!(f.methods("exit").len(), 1);
    assert_eq!(f.manager.state(ID, &f.root).await, None);
}

#[tokio::test]
async fn shutdown_all_stops_slow_servers_in_parallel() {
    let f = fixture("slow-shutdown");
    let other = f.root.parent().unwrap().join("project2");
    std::fs::create_dir(&other).unwrap();
    f.ready().await;
    f.manager.start(ID, &other).await.unwrap();
    f.manager.wait_ready(ID, &other, WAIT).await.unwrap();
    let started = std::time::Instant::now();
    f.manager.shutdown_all().await;
    let elapsed = started.elapsed();
    // Each server needs about 1.5 s to answer shutdown; one after the other would be 3 s.
    assert!(elapsed < Duration::from_millis(2500), "took {elapsed:?}");
    assert_eq!(f.manager.state(ID, &f.root).await, None);
}

#[tokio::test]
async fn slow_exit_is_waited_for_within_the_grace_and_killed_after_it() {
    // The fake leaves 1.5 s after `exit`. Grace 3 s (the fixture): clean exit.
    let f = fixture("slow-exit");
    f.ready().await;
    let started = std::time::Instant::now();
    f.manager.shutdown(ID, &f.root).await;
    assert!(started.elapsed() >= Duration::from_millis(1400));
    assert_eq!(
        f.methods("exited-cleanly").len(),
        1,
        "server should exit by itself"
    );

    // Grace below the exit time: the server is killed before it finishes.
    let f = fixture_with_grace("slow-exit", Duration::from_millis(400));
    f.ready().await;
    let started = std::time::Instant::now();
    f.manager.shutdown(ID, &f.root).await;
    let took = started.elapsed();
    assert!(
        took < Duration::from_millis(1400),
        "kill backstop took {took:?}"
    );
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(
        f.methods("exited-cleanly").is_empty(),
        "server must have been killed"
    );
}

#[test]
fn slow_runtimes_get_a_longer_shutdown_grace() {
    let c = ManagerConfig::default();
    assert!(c.grace_for(ServerId::Jdtls) >= Duration::from_secs(30));
    assert!(c.grace_for(ServerId::RustAnalyzer) >= Duration::from_secs(15));
    assert_eq!(c.grace_for(ServerId::Vtsls), c.shutdown_grace);
    let long = ManagerConfig {
        shutdown_grace: Duration::from_secs(60),
        ..c
    };
    assert_eq!(long.grace_for(ServerId::Jdtls), Duration::from_secs(60));
}

#[tokio::test]
async fn did_save_is_sent_only_when_the_server_asks_for_it() {
    for (mode, expect, text) in [
        ("normal", 0usize, false),
        ("save", 1, false),
        ("save-text", 1, true),
    ] {
        let f = fixture(mode);
        f.ready().await;
        f.manager
            .open_document(ID, &f.root, &f.file("a.json"), "json", "{}".into())
            .await
            .unwrap();
        f.manager
            .save_document(ID, &f.root, &f.file("a.json"))
            .await
            .unwrap();
        // Unknown documents and unstarted servers are quiet no-ops.
        f.manager
            .save_document(ID, &f.root, &f.file("other.json"))
            .await
            .unwrap();
        if expect > 0 {
            f.wait_log("textDocument/didSave", 1).await;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        let saves = f.methods("textDocument/didSave");
        assert_eq!(saves.len(), expect, "{mode}");
        if expect > 0 {
            assert_eq!(saves[0]["params"]["text"].is_string(), text, "{mode}");
        }
        f.manager.shutdown_all().await;
    }
}

#[tokio::test]
async fn reopened_documents_continue_their_version_numbers() {
    let f = fixture("normal");
    f.ready().await;
    let path = f.file("a.json");
    let v1 = f
        .manager
        .open_document(ID, &f.root, &path, "json", "{}".into())
        .await
        .unwrap();
    f.manager.close_document(ID, &f.root, &path).await.unwrap();
    let v2 = f
        .manager
        .open_document(ID, &f.root, &path, "json", "{}".into())
        .await
        .unwrap();
    assert!(v2 > v1, "{v1} then {v2}");
    f.manager.shutdown_all().await;
}
