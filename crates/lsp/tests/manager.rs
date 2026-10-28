//! Manager tests against a python3 fake language server.

use lsp_types::*;
use serde_json::Value;
use span_lsp::path_to_uri;
use span_lsp::servers::manager::{
    LaunchResolver, Manager, ManagerConfig, ManagerError, ManagerEvent, ServerError, ServerState,
};
use span_lsp::servers::spec::{LaunchSpec, Runtime, RuntimeRequirement, ServerId, ServerSpec};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const ID: ServerId = ServerId::Json;
const WAIT: Duration = Duration::from_secs(15);

struct Resolver {
    mode: &'static str,
    log: PathBuf,
    missing: bool,
}

impl LaunchResolver for Resolver {
    async fn resolve(&self, _id: ServerId) -> Result<LaunchSpec, ServerError> {
        if self.missing {
            return Err(ServerError::NotInstalled(ID));
        }
        let script =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-lsp-server.py");
        Ok(LaunchSpec {
            program: PathBuf::from("python3"),
            args: vec![script.to_string_lossy().into_owned(), self.mode.to_string()],
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
    let manager = Manager::new(
        vec![spec],
        Arc::new(Resolver {
            mode,
            log: log.clone(),
            missing,
        }),
        ManagerConfig {
            init_timeout: Duration::from_secs(10),
            shutdown_grace: Duration::from_secs(3),
        },
    );
    Fixture {
        _dir: dir,
        root,
        log,
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
    assert_eq!(resp["result"], serde_json::json!([null]));

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

    f.ready().await;
    assert_eq!(f.methods("initialize").len(), 2);
    f.wait_log("textDocument/didOpen", 2).await;
    let opens = f.methods("textDocument/didOpen");
    assert_eq!(opens.len(), 2);
    assert_eq!(opens[1]["params"]["textDocument"]["text"], "crash");
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
    f.manager.shutdown_all().await;
}

#[tokio::test]
async fn shutdown_all_sends_shutdown_and_exit() {
    let f = fixture("normal");
    f.ready().await;
    f.manager.shutdown_all().await;
    assert_eq!(f.methods("shutdown").len(), 1);
    assert_eq!(f.methods("exit").len(), 1);
    assert_eq!(f.manager.state(ID, &f.root).await, None);
}
