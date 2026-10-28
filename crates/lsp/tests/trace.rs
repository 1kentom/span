//! Protocol trace (`SPAN_LSP_TRACE_DIR`) against the fake python server.

mod common;

use lsp_types::*;
use span_lsp::LspClient;
use std::path::Path;
use std::time::{Duration, Instant};

fn lines(path: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

#[tokio::test]
async fn trace_records_messages_and_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let trace_dir = dir.path().join("trace");
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-lsp-server.py");
    let (program, args) =
        common::python_args(&[script.to_string_lossy().into_owned(), "normal".to_string()]);
    let client = LspClient::spawn_traced(
        &program,
        &args,
        None,
        &[("FAKE_LSP_STDERR".into(), "1".into())],
        Some(&trace_dir),
    )
    .await
    .unwrap();
    client
        .initialize(InitializeParams::default())
        .await
        .unwrap();
    let uri: Uri = serde_json::from_value(serde_json::json!("file:///a.json")).unwrap();
    client
        .did_open(DidOpenTextDocumentParams {
            text_document: TextDocumentItem {
                uri,
                language_id: "json".into(),
                version: 7,
                text: "{}".into(),
            },
        })
        .await
        .unwrap();
    // The fake server answers didOpen with publishDiagnostics.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        assert!(Instant::now() < deadline, "no event within 20s");
        if let Some(span_lsp::ServerEvent::Diagnostics(_)) =
            tokio::time::timeout(Duration::from_secs(5), client.next_event())
                .await
                .ok()
                .flatten()
        {
            break;
        }
    }
    let _ = client.shutdown().await;

    let entries: Vec<_> = std::fs::read_dir(&trace_dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    let jsonl = entries
        .iter()
        .find(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .expect("jsonl trace file");
    let stderr = entries
        .iter()
        .find(|p| p.extension().is_some_and(|e| e == "stderr"))
        .expect("stderr trace file");
    let name = jsonl.file_name().unwrap().to_string_lossy();
    assert!(name.contains('-'), "named <server>-<pid>: {name}");

    let msgs = lines(jsonl);
    let open = msgs
        .iter()
        .find(|m| m["dir"] == "send" && m["method"] == "textDocument/didOpen")
        .expect("didOpen sent");
    assert_eq!(open["params"]["textDocument"]["version"], 7);
    assert_eq!(open["params"]["textDocument"]["text"], "{}");
    assert!(msgs
        .iter()
        .any(|m| m["dir"] == "recv" && m["method"] == "textDocument/publishDiagnostics"));
    assert!(msgs.iter().all(|m| m["ts"].is_string()));

    // The stderr pipe is drained asynchronously; give it a moment.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !std::fs::read_to_string(stderr)
        .unwrap_or_default()
        .contains("fake stderr line")
    {
        assert!(Instant::now() < deadline, "stderr not captured");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn no_trace_files_without_trace_dir() {
    let dir = tempfile::tempdir().unwrap();
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-lsp-server.py");
    let (program, args) =
        common::python_args(&[script.to_string_lossy().into_owned(), "normal".to_string()]);
    let client =
        LspClient::spawn_traced(&program, &args, Some(dir.path().to_path_buf()), &[], None)
            .await
            .unwrap();
    client
        .initialize(InitializeParams::default())
        .await
        .unwrap();
    let _ = client.shutdown().await;
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}
