//! Integration tests using real subprocess LSP server.

use lsp_types::*;
use span_lsp::{LspClient, LspError, ServerEvent};
use std::path::PathBuf;
use std::time::Duration;

fn test_uri(s: &str) -> lsp_types::Uri {
    serde_json::from_value(serde_json::json!(s)).unwrap()
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mock-server.mjs")
}

async fn spawn_server(mode: &str) -> Result<LspClient, LspError> {
    let fixture = fixture_path();
    LspClient::spawn(
        "node",
        &[fixture.to_str().unwrap().to_string(), mode.to_string()],
        None,
    )
    .await
}

#[tokio::test]
async fn test_full_lifecycle() {
    let client = spawn_server("normal").await.unwrap();

    let init_params = InitializeParams {
        process_id: Some(std::process::id()),
        capabilities: ClientCapabilities::default(),
        ..Default::default()
    };

    let result = client.initialize(init_params).await.unwrap();
    assert!(result.capabilities.text_document_sync.is_some());
    assert!(result.capabilities.completion_provider.is_some());
    assert!(result.capabilities.hover_provider.is_some());

    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn test_fragmented_and_coalesced_frames() {
    let client = spawn_server("fragmented").await.unwrap();

    let init_params = InitializeParams {
        capabilities: ClientCapabilities::default(),
        ..Default::default()
    };

    client.initialize(init_params).await.unwrap();

    let uri = test_uri("file:///test.txt");

    let params1 = CompletionParams {
        text_document_position: TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
            position: Position {
                line: 0,
                character: 0,
            },
        },
        context: None,
        work_done_progress_params: WorkDoneProgressParams::default(),
        partial_result_params: PartialResultParams::default(),
    };

    let params2 = CompletionParams {
        text_document_position: TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
            position: Position {
                line: 0,
                character: 1,
            },
        },
        context: None,
        work_done_progress_params: WorkDoneProgressParams::default(),
        partial_result_params: PartialResultParams::default(),
    };

    let fut1 = client.completion(params1);
    let fut2 = client.completion(params2);

    let (result1, result2) = tokio::join!(fut1, fut2);

    assert!(result1.is_ok());
    assert!(result2.is_ok());

    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn test_request_correlation() {
    let client = spawn_server("normal").await.unwrap();

    let init_params = InitializeParams {
        capabilities: ClientCapabilities::default(),
        ..Default::default()
    };

    client.initialize(init_params).await.unwrap();

    let uri = test_uri("file:///test.txt");

    let completion_params = CompletionParams {
        text_document_position: TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
            position: Position {
                line: 0,
                character: 5,
            },
        },
        context: None,
        work_done_progress_params: WorkDoneProgressParams::default(),
        partial_result_params: PartialResultParams::default(),
    };

    let result = client.completion(completion_params).await.unwrap();

    if let Some(CompletionResponse::Array(items)) = result {
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].label, "test_completion");
    } else {
        panic!("Expected completion items");
    }

    let hover_params = HoverParams {
        text_document_position_params: TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri },
            position: Position {
                line: 0,
                character: 5,
            },
        },
        work_done_progress_params: WorkDoneProgressParams::default(),
    };

    let hover = client.hover(hover_params).await.unwrap();
    assert!(hover.is_some());

    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn test_timeout_behavior() {
    let client = spawn_server("timeout").await.unwrap();

    let init_params = InitializeParams {
        capabilities: ClientCapabilities::default(),
        ..Default::default()
    };

    client.initialize(init_params).await.unwrap();

    let uri = test_uri("file:///test.txt");

    let completion_params = CompletionParams {
        text_document_position: TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri },
            position: Position {
                line: 0,
                character: 0,
            },
        },
        context: None,
        work_done_progress_params: WorkDoneProgressParams::default(),
        partial_result_params: PartialResultParams::default(),
    };

    let result = client.completion(completion_params).await;
    assert!(matches!(result, Err(LspError::Timeout)));
}

#[tokio::test]
async fn test_diagnostics_event() {
    let client = spawn_server("normal").await.unwrap();

    let init_params = InitializeParams {
        capabilities: ClientCapabilities::default(),
        ..Default::default()
    };

    client.initialize(init_params).await.unwrap();

    let uri = test_uri("file:///test.txt");

    client
        .did_open(DidOpenTextDocumentParams {
            text_document: TextDocumentItem {
                uri: uri.clone(),
                language_id: "text".to_string(),
                version: 1,
                text: "test content".to_string(),
            },
        })
        .await
        .unwrap();

    let event_result = tokio::time::timeout(Duration::from_secs(2), client.next_event()).await;

    match event_result {
        Ok(Some(ServerEvent::Diagnostics(diag))) => {
            assert_eq!(diag.diagnostics.len(), 1);
            assert_eq!(diag.diagnostics[0].message, "Test diagnostic");
        }
        Ok(Some(_)) => panic!("Expected diagnostics event, got other event"),
        Ok(None) => panic!("Event channel closed unexpectedly"),
        Err(_) => panic!("Timeout waiting for diagnostics"),
    }

    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn test_document_sync() {
    let client = spawn_server("normal").await.unwrap();

    let init_params = InitializeParams {
        capabilities: ClientCapabilities::default(),
        ..Default::default()
    };

    client.initialize(init_params).await.unwrap();

    let uri = test_uri("file:///test.txt");

    client
        .did_open(DidOpenTextDocumentParams {
            text_document: TextDocumentItem {
                uri: uri.clone(),
                language_id: "text".to_string(),
                version: 1,
                text: "Hello World".to_string(),
            },
        })
        .await
        .unwrap();

    tokio::time::timeout(Duration::from_millis(100), client.next_event())
        .await
        .ok();

    client
        .did_change(DidChangeTextDocumentParams {
            text_document: VersionedTextDocumentIdentifier {
                uri: uri.clone(),
                version: 2,
            },
            content_changes: vec![TextDocumentContentChangeEvent {
                range: Some(Range {
                    start: Position {
                        line: 0,
                        character: 6,
                    },
                    end: Position {
                        line: 0,
                        character: 11,
                    },
                }),
                range_length: None,
                text: "Universe".to_string(),
            }],
        })
        .await
        .unwrap();

    client
        .did_close(DidCloseTextDocumentParams {
            text_document: TextDocumentIdentifier { uri },
        })
        .await
        .unwrap();

    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn test_utf16_document_edits() {
    let client = spawn_server("normal").await.unwrap();

    let init_params = InitializeParams {
        capabilities: ClientCapabilities::default(),
        ..Default::default()
    };

    client.initialize(init_params).await.unwrap();

    let uri = test_uri("file:///test.txt");

    client
        .did_open(DidOpenTextDocumentParams {
            text_document: TextDocumentItem {
                uri: uri.clone(),
                language_id: "text".to_string(),
                version: 1,
                text: "Hello 😀 World".to_string(),
            },
        })
        .await
        .unwrap();

    tokio::time::timeout(Duration::from_millis(100), client.next_event())
        .await
        .ok();

    client
        .did_change(DidChangeTextDocumentParams {
            text_document: VersionedTextDocumentIdentifier {
                uri: uri.clone(),
                version: 2,
            },
            content_changes: vec![TextDocumentContentChangeEvent {
                range: Some(Range {
                    start: Position {
                        line: 0,
                        character: 8,
                    },
                    end: Position {
                        line: 0,
                        character: 14,
                    },
                }),
                range_length: None,
                text: "Universe".to_string(),
            }],
        })
        .await
        .unwrap();

    client
        .did_close(DidCloseTextDocumentParams {
            text_document: TextDocumentIdentifier { uri },
        })
        .await
        .unwrap();

    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn test_bounded_stderr() {
    let client = spawn_server("stderr").await.unwrap();

    let init_params = InitializeParams {
        capabilities: ClientCapabilities::default(),
        ..Default::default()
    };

    client.initialize(init_params).await.unwrap();

    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn test_server_crash_during_request() {
    let client = spawn_server("crash").await.unwrap();

    let init_params = InitializeParams {
        capabilities: ClientCapabilities::default(),
        ..Default::default()
    };

    client.initialize(init_params).await.unwrap();

    let uri = test_uri("file:///test.txt");

    let completion_params = CompletionParams {
        text_document_position: TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri },
            position: Position {
                line: 0,
                character: 0,
            },
        },
        context: None,
        work_done_progress_params: WorkDoneProgressParams::default(),
        partial_result_params: PartialResultParams::default(),
    };

    let result = client.completion(completion_params).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_stale_version_rejection() {
    let client = spawn_server("normal").await.unwrap();

    let init_params = InitializeParams {
        capabilities: ClientCapabilities::default(),
        ..Default::default()
    };

    client.initialize(init_params).await.unwrap();

    let uri = test_uri("file:///test.txt");

    client
        .did_open(DidOpenTextDocumentParams {
            text_document: TextDocumentItem {
                uri: uri.clone(),
                language_id: "text".to_string(),
                version: 1,
                text: "Hello".to_string(),
            },
        })
        .await
        .unwrap();

    tokio::time::timeout(Duration::from_millis(100), client.next_event())
        .await
        .ok();

    client
        .did_change(DidChangeTextDocumentParams {
            text_document: VersionedTextDocumentIdentifier {
                uri: uri.clone(),
                version: 2,
            },
            content_changes: vec![TextDocumentContentChangeEvent {
                range: None,
                range_length: None,
                text: "World".to_string(),
            }],
        })
        .await
        .unwrap();

    let result = client
        .did_change(DidChangeTextDocumentParams {
            text_document: VersionedTextDocumentIdentifier {
                uri: uri.clone(),
                version: 1,
            },
            content_changes: vec![TextDocumentContentChangeEvent {
                range: None,
                range_length: None,
                text: "Stale".to_string(),
            }],
        })
        .await;

    assert!(matches!(result, Err(LspError::VersionMismatch { .. })));

    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn test_multi_edit_transactional() {
    let client = spawn_server("normal").await.unwrap();

    let init_params = InitializeParams {
        capabilities: ClientCapabilities::default(),
        ..Default::default()
    };

    client.initialize(init_params).await.unwrap();

    let uri = test_uri("file:///test.txt");

    client
        .did_open(DidOpenTextDocumentParams {
            text_document: TextDocumentItem {
                uri: uri.clone(),
                language_id: "text".to_string(),
                version: 1,
                text: "Hello World".to_string(),
            },
        })
        .await
        .unwrap();

    tokio::time::timeout(Duration::from_millis(100), client.next_event())
        .await
        .ok();

    client
        .did_change(DidChangeTextDocumentParams {
            text_document: VersionedTextDocumentIdentifier {
                uri: uri.clone(),
                version: 2,
            },
            content_changes: vec![
                TextDocumentContentChangeEvent {
                    range: Some(Range {
                        start: Position {
                            line: 0,
                            character: 0,
                        },
                        end: Position {
                            line: 0,
                            character: 5,
                        },
                    }),
                    range_length: None,
                    text: "Goodbye".to_string(),
                },
                TextDocumentContentChangeEvent {
                    range: Some(Range {
                        start: Position {
                            line: 0,
                            character: 6,
                        },
                        end: Position {
                            line: 0,
                            character: 11,
                        },
                    }),
                    range_length: None,
                    text: "Universe".to_string(),
                },
            ],
        })
        .await
        .unwrap();

    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn test_malformed_protocol() {
    let client = spawn_server("malformed").await.unwrap();

    let init_params = InitializeParams {
        capabilities: ClientCapabilities::default(),
        ..Default::default()
    };

    let result = tokio::time::timeout(Duration::from_secs(2), client.initialize(init_params)).await;

    assert!(result.is_ok());
    let init_result = result.unwrap();
    assert!(init_result.is_err());
}

#[tokio::test]
async fn test_caller_driven_cancellation() {
    let client = spawn_server("cancel").await.unwrap();

    let init_params = InitializeParams {
        capabilities: ClientCapabilities::default(),
        ..Default::default()
    };

    client.initialize(init_params).await.unwrap();

    let uri = test_uri("file:///test.txt");

    let completion_params = CompletionParams {
        text_document_position: TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri },
            position: Position {
                line: 0,
                character: 0,
            },
        },
        context: None,
        work_done_progress_params: WorkDoneProgressParams::default(),
        partial_result_params: PartialResultParams::default(),
    };

    let cancel_token = tokio_util::sync::CancellationToken::new();
    let cancel_token_clone = cancel_token.clone();

    let request_task = tokio::spawn(async move {
        client
            .completion_with_cancel(completion_params, cancel_token_clone)
            .await
    });

    tokio::time::sleep(Duration::from_millis(50)).await;
    cancel_token.cancel();

    let result = request_task.await.unwrap();
    assert!(matches!(result, Err(LspError::Cancelled)));
}

#[tokio::test]
async fn test_server_initiated_request() {
    let client = spawn_server("server-request").await.unwrap();

    let init_params = InitializeParams {
        capabilities: ClientCapabilities::default(),
        ..Default::default()
    };

    client.initialize(init_params).await.unwrap();

    let event_result = tokio::time::timeout(Duration::from_secs(2), client.next_event()).await;

    match event_result {
        Ok(Some(ServerEvent::Request { id, method, .. })) => {
            assert_eq!(method, "workspace/configuration");

            let response = serde_json::json!({ "value": "test-response" });
            client.respond_to_request(id, response).await.unwrap();
        }
        Ok(Some(_)) => panic!("Expected server request event"),
        Ok(None) => panic!("Event channel closed unexpectedly"),
        Err(_) => panic!("Timeout waiting for server request"),
    }

    client.shutdown().await.unwrap();
}
