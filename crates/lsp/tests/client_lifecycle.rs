//! Client lifecycle tests against a small inline python3 server.

mod common;

use lsp_types::*;
use span_lsp::{LspClient, LspError};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const SERVER: &str = r#"
import json, os, sys
mode = sys.argv[1]
log_path = os.environ["FAKE_LSP_LOG"]

def log(m):
    with open(log_path, "a") as f:
        f.write(json.dumps(m) + "\n")

def read():
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            break
        k, v = line.decode().split(":", 1)
        headers[k.lower()] = v.strip()
    return json.loads(sys.stdin.buffer.read(int(headers["content-length"])))

def reply_error(msg, code, message):
    b = json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": code, "message": message}}).encode()
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n" % len(b) + b)
    sys.stdout.buffer.flush()

completions = 0

def reply(msg, result):
    b = json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}).encode()
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n" % len(b) + b)
    sys.stdout.buffer.flush()

while True:
    msg = read()
    if msg is None:
        break
    method = msg.get("method")
    log({"method": method})
    if method == "initialize":
        caps = {"hoverProvider": True}
        if mode != "nocompletion":
            caps["completionProvider"] = {}
        else:
            caps["hoverProvider"] = False
        reply(msg, {"capabilities": caps})
    elif method == "textDocument/completion":
        completions += 1
        if mode == "modified_always" or (mode == "modified_twice" and completions <= 2):
            reply_error(msg, -32801, "content modified")
        else:
            reply(msg, {"isIncomplete": False, "items": []})
    elif method == "textDocument/hover":
        pass  # never answered
    elif method == "shutdown":
        reply(msg, None)
    elif method == "exit":
        sys.exit(0)
"#;

struct Fixture {
    _dir: tempfile::TempDir,
    log: PathBuf,
    client: LspClient,
}

async fn start(mode: &str) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("server.py");
    std::fs::write(&script, SERVER).unwrap();
    let log = dir.path().join("server.log");
    let (program, args) =
        common::python_args(&[script.to_string_lossy().into_owned(), mode.to_string()]);
    let client = LspClient::spawn_with_env(
        &program,
        &args,
        None,
        &[("FAKE_LSP_LOG".into(), log.to_string_lossy().into_owned())],
    )
    .await
    .unwrap();
    client
        .initialize(InitializeParams::default())
        .await
        .unwrap();
    Fixture {
        _dir: dir,
        log,
        client,
    }
}

fn logged_methods(log: &Path) -> Vec<String> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter_map(|v| v["method"].as_str().map(str::to_string))
        .collect()
}

fn uri() -> Uri {
    serde_json::from_value(serde_json::json!("file:///a.txt")).unwrap()
}

fn hover_params() -> HoverParams {
    HoverParams {
        text_document_position_params: TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri: uri() },
            position: Position::new(0, 0),
        },
        work_done_progress_params: Default::default(),
    }
}

fn completion_params() -> CompletionParams {
    CompletionParams {
        text_document_position: TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri: uri() },
            position: Position::new(0, 0),
        },
        work_done_progress_params: Default::default(),
        partial_result_params: Default::default(),
        context: None,
    }
}

async fn pending_hover_fails_fast(use_terminate: bool) {
    let f = start("normal").await;
    let client = std::sync::Arc::new(f.client);
    let c = client.clone();
    let hover = tokio::spawn(async move { c.hover(hover_params()).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    let started = Instant::now();
    if use_terminate {
        client.terminate().await;
    } else {
        client
            .shutdown_with_timeout(Duration::from_secs(2))
            .await
            .ok();
    }
    let result = tokio::time::timeout(Duration::from_secs(2), hover)
        .await
        .expect("hover must complete promptly")
        .unwrap();
    assert!(matches!(result, Err(LspError::Shutdown)), "{result:?}");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "took {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn pending_request_fails_with_shutdown_on_graceful_shutdown() {
    pending_hover_fails_fast(false).await;
}

#[tokio::test]
async fn pending_request_fails_with_shutdown_on_terminate() {
    pending_hover_fails_fast(true).await;
}

#[tokio::test]
async fn unadvertised_completion_and_hover_return_unsupported_without_sending() {
    let f = start("nocompletion").await;
    assert!(matches!(
        f.client.completion(completion_params()).await,
        Err(LspError::Unsupported(_))
    ));
    assert!(matches!(
        f.client.hover(hover_params()).await,
        Err(LspError::Unsupported(_))
    ));
    assert!(matches!(
        f.client
            .completion_with_cancel(completion_params(), Default::default())
            .await,
        Err(LspError::Unsupported(_))
    ));
    assert!(matches!(
        f.client
            .hover_with_cancel(hover_params(), Default::default())
            .await,
        Err(LspError::Unsupported(_))
    ));
    f.client.shutdown().await.unwrap();
    let methods = logged_methods(&f.log);
    assert!(
        !methods.iter().any(|m| m.starts_with("textDocument/")),
        "{methods:?}"
    );
}

fn count(log: &Path, method: &str) -> usize {
    logged_methods(log).iter().filter(|m| *m == method).count()
}

#[tokio::test]
async fn content_modified_is_retried_until_the_server_answers() {
    let f = start("modified_twice").await;
    let result = f.client.completion(completion_params()).await;
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(count(&f.log, "textDocument/completion"), 3);
}

#[tokio::test]
async fn content_modified_retries_are_bounded_and_the_error_is_surfaced() {
    let f = start("modified_always").await;
    let err = f.client.completion(completion_params()).await.unwrap_err();
    assert!(
        matches!(err, LspError::ServerError { code: -32801, .. }),
        "{err:?}"
    );
    // One attempt plus three retries, no more.
    assert_eq!(count(&f.log, "textDocument/completion"), 4);
}

#[tokio::test]
async fn cancelling_during_a_content_modified_backoff_returns_cancelled() {
    let f = start("modified_always").await;
    let token = tokio_util::sync::CancellationToken::new();
    let t = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(60)).await;
        t.cancel();
    });
    let started = Instant::now();
    let err = f
        .client
        .completion_with_cancel(completion_params(), token)
        .await
        .unwrap_err();
    assert!(matches!(err, LspError::Cancelled), "{err:?}");
    assert!(started.elapsed() < Duration::from_secs(2));
}
