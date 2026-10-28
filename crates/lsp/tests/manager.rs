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
            shutdown_grace: Duration::from_secs(3),
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

// ---------------------------------------------------------------------------
// Navigation requests
// ---------------------------------------------------------------------------

fn at(f: &Fixture, name: &str) -> TextDocumentPositionParams {
    f.hover_params(name).text_document_position_params
}

fn goto(f: &Fixture, name: &str) -> GotoDefinitionParams {
    GotoDefinitionParams {
        text_document_position_params: at(f, name),
        work_done_progress_params: Default::default(),
        partial_result_params: Default::default(),
    }
}

async fn nav_ready(mode: &'static str) -> Fixture {
    let f = fixture(mode);
    f.ready().await;
    f.manager
        .open_document(ID, &f.root, &f.file("a.json"), "json", "{}".into())
        .await
        .unwrap();
    f
}

#[tokio::test]
async fn navigation_requests_return_typed_results() {
    let f = nav_ready("nav").await;
    let (m, r) = (&f.manager, &f.root);

    let refs = m
        .references(
            ID,
            r,
            ReferenceParams {
                text_document_position: at(&f, "a.json"),
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
                context: ReferenceContext {
                    include_declaration: true,
                },
            },
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(refs.len(), 2);
    let sent = f.methods("textDocument/references");
    assert_eq!(sent[0]["params"]["context"]["includeDeclaration"], true);

    let imp = m
        .implementation(ID, r, goto(&f, "a.json"), None)
        .await
        .unwrap();
    assert!(matches!(imp, Some(GotoDefinitionResponse::Link(l)) if l.len() == 1));
    let td = m
        .type_definition(ID, r, goto(&f, "a.json"), None)
        .await
        .unwrap();
    assert!(matches!(td, Some(GotoDefinitionResponse::Scalar(_))));
    let decl = m
        .declaration(ID, r, goto(&f, "a.json"), None)
        .await
        .unwrap();
    assert!(matches!(decl, Some(GotoDefinitionResponse::Array(l)) if l.len() == 1));

    let uri = path_to_uri(&f.file("a.json")).unwrap();
    let symbols = m
        .document_symbols(
            ID,
            r,
            DocumentSymbolParams {
                text_document: TextDocumentIdentifier { uri: uri.clone() },
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
            },
            None,
        )
        .await
        .unwrap();
    match symbols {
        Some(DocumentSymbolResponse::Nested(v)) => {
            assert_eq!(v[0].name, "Outer");
            assert_eq!(v[0].children.as_ref().unwrap()[0].name, "inner");
        }
        other => panic!("expected hierarchical symbols, got {other:?}"),
    }

    let ws = m
        .workspace_symbols(
            ID,
            r,
            WorkspaceSymbolParams {
                query: "foo".into(),
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
            },
            None,
        )
        .await
        .unwrap();
    match ws {
        Some(WorkspaceSymbolResponse::Nested(v)) => {
            assert_eq!(v[0].name, "fooSym");
            assert!(matches!(v[1].location, OneOf::Right(_)), "lazy location");
        }
        other => panic!("expected nested workspace symbols, got {other:?}"),
    }

    let prepared = m
        .prepare_call_hierarchy(
            ID,
            r,
            CallHierarchyPrepareParams {
                text_document_position_params: at(&f, "a.json"),
                work_done_progress_params: Default::default(),
            },
            None,
        )
        .await
        .unwrap()
        .unwrap();
    let item = prepared[0].clone();
    assert_eq!(item.data.as_ref().unwrap()["opaque"][2]["k"], "v");
    let incoming = m
        .incoming_calls(
            ID,
            r,
            CallHierarchyIncomingCallsParams {
                item: item.clone(),
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
            },
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(incoming[0].from.name, "caller");
    let outgoing = m
        .outgoing_calls(
            ID,
            r,
            CallHierarchyOutgoingCallsParams {
                item,
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
            },
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(outgoing[0].to.name, "callee");
    let sent = f.methods("callHierarchy/incomingCalls");
    assert_eq!(
        sent[0]["params"]["item"]["data"]["opaque"][1], 2,
        "item data round-trips to the server"
    );

    assert!(m.supports_type_hierarchy(ID, r).await);
    let types = m
        .prepare_type_hierarchy(
            ID,
            r,
            TypeHierarchyPrepareParams {
                text_document_position_params: at(&f, "a.json"),
                work_done_progress_params: Default::default(),
            },
            None,
        )
        .await
        .unwrap()
        .unwrap();
    let sup = m
        .type_supertypes(
            ID,
            r,
            TypeHierarchySupertypesParams {
                item: types[0].clone(),
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
            },
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(sup[0].name, "supertypes");
    let sub = m
        .type_subtypes(
            ID,
            r,
            TypeHierarchySubtypesParams {
                item: types[0].clone(),
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
            },
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(sub[0].name, "subtypes");

    let hl = m
        .document_highlights(
            ID,
            r,
            DocumentHighlightParams {
                text_document_position_params: at(&f, "a.json"),
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
            },
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(hl.len(), 2);
    assert_eq!(hl[0].kind, Some(DocumentHighlightKind::READ));

    let sig = m
        .signature_help(
            ID,
            r,
            SignatureHelpParams {
                context: None,
                text_document_position_params: at(&f, "a.json"),
                work_done_progress_params: Default::default(),
            },
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(sig.active_parameter, Some(1));

    let prep = m
        .prepare_rename(ID, r, at(&f, "a.json"), None)
        .await
        .unwrap();
    assert!(matches!(
        prep,
        Some(PrepareRenameResponse::RangeWithPlaceholder { .. })
    ));
    let edit = m
        .rename(
            ID,
            r,
            RenameParams {
                text_document_position: at(&f, "a.json"),
                new_name: "renamed".into(),
                work_done_progress_params: Default::default(),
            },
            None,
        )
        .await
        .unwrap()
        .unwrap();
    let (changed, edits) = edit.changes.unwrap().into_iter().next().unwrap();
    assert_eq!(changed, uri);
    assert_eq!(edits[0].new_text, "renamed");

    let src = m
        .class_file_contents(ID, r, "jdt://contents/Foo.class", None)
        .await
        .unwrap();
    assert_eq!(src.as_deref(), Some("public class Foo {}\n"));
    f.manager.shutdown_all().await;
}

#[tokio::test]
async fn flat_symbol_information_is_accepted() {
    let f = nav_ready("nav-flat").await;
    let uri = path_to_uri(&f.file("a.json")).unwrap();
    let symbols = f
        .manager
        .document_symbols(
            ID,
            &f.root,
            DocumentSymbolParams {
                text_document: TextDocumentIdentifier { uri },
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
            },
            None,
        )
        .await
        .unwrap();
    match symbols {
        Some(DocumentSymbolResponse::Flat(v)) => assert_eq!(v[0].name, "Flat"),
        other => panic!("expected flat symbols, got {other:?}"),
    }
    f.manager.shutdown_all().await;
}

#[tokio::test]
async fn navigation_requests_are_unsupported_unless_advertised() {
    let f = nav_ready("normal").await;
    let (m, r) = (&f.manager, &f.root);
    let uri = path_to_uri(&f.file("a.json")).unwrap();
    let unsupported = |e: ManagerError| matches!(e, ManagerError::Unsupported(_));
    assert!(!m.supports_type_hierarchy(ID, r).await);
    assert!(unsupported(
        m.implementation(ID, r, goto(&f, "a.json"), None)
            .await
            .unwrap_err()
    ));
    assert!(unsupported(
        m.type_definition(ID, r, goto(&f, "a.json"), None)
            .await
            .unwrap_err()
    ));
    assert!(unsupported(
        m.declaration(ID, r, goto(&f, "a.json"), None)
            .await
            .unwrap_err()
    ));
    assert!(unsupported(
        m.document_symbols(
            ID,
            r,
            DocumentSymbolParams {
                text_document: TextDocumentIdentifier { uri },
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
            },
            None
        )
        .await
        .unwrap_err()
    ));
    assert!(unsupported(
        m.prepare_type_hierarchy(
            ID,
            r,
            TypeHierarchyPrepareParams {
                text_document_position_params: at(&f, "a.json"),
                work_done_progress_params: Default::default(),
            },
            None
        )
        .await
        .unwrap_err()
    ));
    assert!(unsupported(
        m.prepare_rename(ID, r, at(&f, "a.json"), None)
            .await
            .unwrap_err()
    ));
    for method in [
        "textDocument/implementation",
        "textDocument/typeDefinition",
        "textDocument/declaration",
        "textDocument/documentSymbol",
        "textDocument/prepareTypeHierarchy",
        "textDocument/prepareRename",
    ] {
        assert!(
            f.methods(method).is_empty(),
            "{method} must not be sent when unadvertised"
        );
    }
    f.manager.shutdown_all().await;
}

#[tokio::test]
async fn navigation_retries_content_modified() {
    let f = nav_ready("nav-modified").await;
    let refs = f
        .manager
        .references(
            ID,
            &f.root,
            ReferenceParams {
                text_document_position: at(&f, "a.json"),
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
                context: ReferenceContext {
                    include_declaration: false,
                },
            },
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(refs.len(), 2);
    assert_eq!(f.methods("textDocument/references").len(), 2, "one retry");
    f.manager.shutdown_all().await;
}

#[tokio::test]
async fn navigation_requests_cancel() {
    let f = nav_ready("nav-hang").await;
    let token = CancellationToken::new();
    let t = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        t.cancel();
    });
    let err = f
        .manager
        .references(
            ID,
            &f.root,
            ReferenceParams {
                text_document_position: at(&f, "a.json"),
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
                context: ReferenceContext {
                    include_declaration: true,
                },
            },
            Some(token),
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ManagerError::Cancelled), "{err:?}");
    f.wait_log("$/cancelRequest", 1).await;
    f.manager.shutdown_all().await;
}

#[test]
fn declared_client_capabilities_cover_navigation() {
    let caps = serde_json::to_value(span_lsp::client_capabilities()).unwrap();
    let td = &caps["textDocument"];
    assert_eq!(
        td["documentSymbol"]["hierarchicalDocumentSymbolSupport"],
        true
    );
    for key in [
        "definition",
        "implementation",
        "typeDefinition",
        "declaration",
    ] {
        assert_eq!(td[key]["linkSupport"], true, "{key}");
    }
    assert_eq!(td["rename"]["prepareSupport"], true);
    assert!(td["callHierarchy"].is_object());
    assert!(td["typeHierarchy"].is_object());
    assert!(td["references"].is_object());
    assert!(td["documentHighlight"].is_object());
    assert_eq!(
        td["documentSymbol"]["symbolKind"]["valueSet"]
            .as_array()
            .unwrap()
            .len(),
        26
    );
    assert_eq!(
        caps["workspace"]["symbol"]["symbolKind"]["valueSet"]
            .as_array()
            .unwrap()
            .len(),
        26
    );
}

#[tokio::test]
async fn work_done_progress_is_forwarded_and_the_create_request_answered() {
    use span_lsp::servers::manager::WorkProgressKind;
    let f = fixture("progress");
    let mut events = f.manager.subscribe();
    f.ready().await;
    let mut kinds = Vec::new();
    let deadline = tokio::time::Instant::now() + WAIT;
    while kinds.last() != Some(&WorkProgressKind::End) {
        let event = tokio::time::timeout_at(deadline, events.recv())
            .await
            .expect("progress arrives")
            .unwrap();
        if let ManagerEvent::Progress {
            token,
            kind,
            title,
            percentage,
            ..
        } = event
        {
            assert_eq!(token, "tok-1");
            if kind == WorkProgressKind::Begin {
                assert_eq!(title.as_deref(), Some("Indexing project"));
                assert_eq!(percentage, Some(0));
            }
            kinds.push(kind);
        }
    }
    assert_eq!(kinds[0], WorkProgressKind::Begin);
    assert_eq!(
        kinds
            .iter()
            .filter(|k| **k == WorkProgressKind::Report)
            .count(),
        20
    );
    f.wait_log("response", 2).await;
    let answered = f.methods("response").iter().any(|e| e["id"] == "wd-1");
    assert!(answered, "window/workDoneProgress/create must be answered");
    f.manager.shutdown_all().await;
}

#[test]
fn work_progress_params_parse() {
    use span_lsp::servers::manager::{parse_work_progress, WorkProgressKind};
    let begin = serde_json::json!({"token": 7, "value": {"kind": "begin", "title": "T", "percentage": 250}});
    let p = parse_work_progress(&begin).unwrap();
    assert_eq!(
        (p.token.as_str(), p.kind, p.title.as_deref(), p.percentage),
        ("7", WorkProgressKind::Begin, Some("T"), Some(100))
    );
    assert!(
        parse_work_progress(&serde_json::json!({"token": "x", "value": {"items": []}})).is_none()
    );
    assert!(
        parse_work_progress(&serde_json::json!({"token": [1], "value": {"kind": "end"}})).is_none()
    );
}
