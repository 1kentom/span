//! Integration tests for LSP client.

use super::*;
use lsp_types::*;
use serde_json::json;

#[test]
fn test_protocol_parsing() {
    // Test valid request
    let value = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "test",
        "params": {}
    });

    let msg = protocol::Message::parse(value).unwrap();
    assert!(matches!(msg, protocol::Message::Request(_)));

    // Test valid response
    let value = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "result": null
    });

    let msg = protocol::Message::parse(value).unwrap();
    assert!(matches!(msg, protocol::Message::Response(_)));

    // Test valid notification
    let value = json!({
        "jsonrpc": "2.0",
        "method": "test",
        "params": {}
    });

    let msg = protocol::Message::parse(value).unwrap();
    assert!(matches!(msg, protocol::Message::Notification(_)));
}

#[test]
fn test_utf16_positions() {
    let mut registry = DocumentRegistry::new();

    // Test with astral character (emoji, 2 UTF-16 code units)
    let content = "Hello 😀 World";
    registry.open(
        "file:///test.txt".to_string(),
        "text".to_string(),
        1,
        content.to_string(),
    );

    // Apply a change after the emoji
    // "😀" is at byte offset 6, UTF-16 offset 6
    // " World" starts at byte offset 10, UTF-16 offset 8 (6 + 2 for emoji)
    let change = TextDocumentContentChangeEvent {
        range: Some(Range {
            start: Position {
                line: 0,
                character: 8,
            }, // After emoji in UTF-16
            end: Position {
                line: 0,
                character: 14,
            }, // End of "World" in UTF-16
        }),
        range_length: None,
        text: " Universe".to_string(),
    };

    registry
        .update("file:///test.txt", vec![change], 2)
        .unwrap();

    let doc = registry.get("file:///test.txt").unwrap();
    assert_eq!(doc.content(), "Hello 😀 Universe");
}

#[test]
fn test_version_tracking() {
    let mut registry = DocumentRegistry::new();

    registry.open(
        "file:///test.txt".to_string(),
        "text".to_string(),
        1,
        "Hello".to_string(),
    );

    // Valid version increment
    let change = TextDocumentContentChangeEvent {
        range: None,
        range_length: None,
        text: "World".to_string(),
    };

    registry
        .update("file:///test.txt", vec![change], 2)
        .unwrap();

    let doc = registry.get("file:///test.txt").unwrap();
    assert_eq!(doc.version, 2);

    // Stale version should fail
    let change = TextDocumentContentChangeEvent {
        range: None,
        range_length: None,
        text: "Fail".to_string(),
    };

    let result = registry.update("file:///test.txt", vec![change], 2);
    assert!(matches!(result, Err(LspError::VersionMismatch { .. })));
}

#[test]
fn test_request_id_generation() {
    let gen = protocol::RequestIdGenerator::new();

    let id1 = gen.next();
    let id2 = gen.next();

    assert!(id1 != id2);
}

#[test]
fn test_document_line_tracking() {
    let doc = TrackedDocument::new(
        "file:///test.txt".to_string(),
        "text".to_string(),
        1,
        "Line 1\nLine 2\nLine 3".to_string(),
    );

    assert_eq!(doc.version, 1);
    assert_eq!(doc.content(), "Line 1\nLine 2\nLine 3");
}
