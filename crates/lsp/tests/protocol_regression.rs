//! Protocol regression tests for the LSP client.
//!
//! Every process test spawns a real `python3 -I` script that speaks raw LSP bytes
//! over stdio, so each test controls exactly what is written and when. The script
//! logs every message it receives as one JSON line (`{"in": ...}`) to a file.

use lsp_types::*;
use serde_json::{json, Value};
use span_lsp::{LspClient, LspError, ServerEvent, TrackedDocument};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

const PRELUDE: &str = r##"
import json, os, sys, time
LOG = sys.argv[1]

def log(o):
    with open(LOG, "a") as f:
        f.write(json.dumps(o) + "\n")

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
    msg = json.loads(sys.stdin.buffer.read(int(headers["content-length"])))
    log({"in": msg})
    return msg

def frame(obj, pre=b"", post=b""):
    b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    return pre + b"Content-Length: %d\r\n" % len(b) + post + b"\r\n" + b

def put(data):
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()

def res(msg, result, **kw):
    return frame({"jsonrpc": "2.0", "id": msg["id"], "result": result}, **kw)

def note(method, params):
    return frame({"jsonrpc": "2.0", "method": method, "params": params})

def next_request():
    while True:
        m = read()
        if m is None:
            sys.exit(0)
        if "id" in m and "method" in m:
            return m

def serve_rest():
    while True:
        m = read()
        if m is None:
            sys.exit(0)
        meth = m.get("method")
        if meth == "exit":
            sys.exit(0)
        if "id" in m and meth:
            if meth == "textDocument/hover":
                put(res(m, {"contents": "ok"}))
            else:
                put(res(m, None))

m = read()
log({"pid": os.getpid()})
put(res(m, {"capabilities": {
    "positionEncoding": "utf-16",
    "textDocumentSync": {"openClose": True, "change": 2},
    "hoverProvider": True,
    "definitionProvider": True,
    "completionProvider": {},
}}))
read()  # initialized
"##;

struct Srv {
    _dir: tempfile::TempDir,
    log: PathBuf,
    client: LspClient,
}

async fn start(scenario: &str) -> Srv {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("server.py");
    std::fs::write(&script, format!("{PRELUDE}\n{scenario}\n")).unwrap();
    let log = dir.path().join("server.log");
    let client = LspClient::spawn(
        "python3",
        &[
            "-I".to_string(),
            script.to_string_lossy().into_owned(),
            log.to_string_lossy().into_owned(),
        ],
        None,
    )
    .await
    .unwrap();
    client
        .initialize(InitializeParams::default())
        .await
        .unwrap();
    Srv {
        _dir: dir,
        log,
        client,
    }
}

fn entries(log: &Path) -> Vec<Value> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// Messages the server received, in order.
fn received(log: &Path) -> Vec<Value> {
    entries(log)
        .into_iter()
        .filter_map(|e| e.get("in").cloned())
        .collect()
}

async fn wait_log(log: &Path, what: &str, pred: impl Fn(&[Value]) -> bool) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let e = entries(log);
        if pred(&e) {
            return e;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {what}: {e:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn server_pid(log: &Path) -> u32 {
    entries(log)
        .iter()
        .find_map(|e| e.get("pid").and_then(Value::as_u64))
        .expect("server logged its pid") as u32
}

/// `ps` state of a pid: `None` when the pid no longer exists (fully reaped).
fn ps_state(pid: u32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn uri() -> Uri {
    serde_json::from_value(json!("file:///a.txt")).unwrap()
}

fn position_params() -> TextDocumentPositionParams {
    TextDocumentPositionParams {
        text_document: TextDocumentIdentifier { uri: uri() },
        position: Position::new(0, 0),
    }
}

fn hover_params() -> HoverParams {
    HoverParams {
        text_document_position_params: position_params(),
        work_done_progress_params: Default::default(),
    }
}

fn completion_params() -> CompletionParams {
    CompletionParams {
        text_document_position: position_params(),
        work_done_progress_params: Default::default(),
        partial_result_params: Default::default(),
        context: None,
    }
}

fn definition_params() -> GotoDefinitionParams {
    GotoDefinitionParams {
        text_document_position_params: position_params(),
        work_done_progress_params: Default::default(),
        partial_result_params: Default::default(),
    }
}

fn hover_text(h: Option<Hover>) -> String {
    let v = serde_json::to_value(h.expect("hover result").contents).unwrap();
    v.as_str().expect("scalar hover contents").to_string()
}

async fn next_event(c: &LspClient) -> ServerEvent {
    tokio::time::timeout(Duration::from_secs(3), c.next_event())
        .await
        .expect("timed out waiting for a server event")
        .expect("event channel closed")
}

async fn hover_within(c: &LspClient, secs: u64) -> Result<Option<Hover>, LspError> {
    tokio::time::timeout(Duration::from_secs(secs), c.hover(hover_params()))
        .await
        .expect("hover hung instead of completing")
}

// ---------------------------------------------------------------------------
// Framing: split writes
// ---------------------------------------------------------------------------

const SPLIT_BODY: &str = r##"
TEXT = "héllo 日本語 \U0001F600 end"

def dribble(data, cuts, delay):
    prev = 0
    for c in sorted(set(cuts)) + [len(data)]:
        put(data[prev:c])
        time.sleep(delay)
        prev = c

m = next_request()
data = res(m, {"contents": TEXT})
hdr_end = data.index(b"\r\n\r\n") + 4
if PLAN == "bytes":
    dribble(data, range(1, len(data)), 0.001)
elif PLAN == "inside_header":
    dribble(data, [5, 16, hdr_end - 3, hdr_end - 2, hdr_end - 1], 0.05)
elif PLAN == "header_body":
    dribble(data, [hdr_end], 0.2)
elif PLAN == "mid_char":
    cuts = [
        data.index("é".encode()) + 1,
        data.index("日".encode()) + 1,
        data.index("日".encode()) + 2,
        data.index("\U0001F600".encode()) + 1,
        data.index("\U0001F600".encode()) + 2,
        data.index("\U0001F600".encode()) + 3,
    ]
    dribble(data, cuts, 0.05)
serve_rest()
"##;

async fn split_plan(plan: &str) {
    let s = start(&format!("PLAN = {plan:?}\n{SPLIT_BODY}")).await;
    let first = hover_within(&s.client, 10).await.unwrap();
    assert_eq!(
        hover_text(first),
        "h\u{e9}llo \u{65e5}\u{672c}\u{8a9e} \u{1F600} end"
    );
    // Buffer state after the split frame must be clean for the next frame.
    let second = hover_within(&s.client, 10).await.unwrap();
    assert_eq!(hover_text(second), "ok");
    s.client.shutdown().await.unwrap();
}

#[tokio::test]
async fn split_one_byte_per_write() {
    split_plan("bytes").await;
}

#[tokio::test]
async fn split_inside_header_name_and_terminator() {
    split_plan("inside_header").await;
}

#[tokio::test]
async fn split_between_header_and_body() {
    split_plan("header_body").await;
}

#[tokio::test]
async fn split_inside_multibyte_utf8_characters() {
    split_plan("mid_char").await;
}

// ---------------------------------------------------------------------------
// Framing: coalesced writes, extra headers, byte lengths
// ---------------------------------------------------------------------------

#[tokio::test]
async fn coalesced_notification_response_notification_in_one_write() {
    let s = start(
        r##"
m = next_request()
put(note("window/logMessage", {"type": 3, "message": "before"})
    + res(m, {"contents": "coalesced"})
    + note("window/logMessage", {"type": 3, "message": "after"}))
serve_rest()
"##,
    )
    .await;
    let h = hover_within(&s.client, 5).await.unwrap();
    assert_eq!(hover_text(h), "coalesced");
    for expected in ["before", "after"] {
        match next_event(&s.client).await {
            ServerEvent::Notification { method, params } => {
                assert_eq!(method, "window/logMessage");
                assert_eq!(params.unwrap()["message"], expected);
            }
            _ => panic!("expected logMessage notification {expected}"),
        }
    }
    s.client.shutdown().await.unwrap();
}

#[tokio::test]
async fn extra_content_type_header_before_and_after_content_length() {
    let s = start(
        r##"
CT = b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n"
m = next_request()
put(res(m, {"contents": "ct-before"}, pre=CT))
m = next_request()
put(res(m, {"contents": "ct-after"}, post=CT))
m = next_request()
put(res(m, {"contents": "ct-both"}, pre=CT, post=b"X-Extra: 1\r\n" + CT))
serve_rest()
"##,
    )
    .await;
    for expected in ["ct-before", "ct-after", "ct-both"] {
        let h = hover_within(&s.client, 5).await.unwrap();
        assert_eq!(hover_text(h), expected);
    }
    s.client.shutdown().await.unwrap();
}

#[tokio::test]
async fn content_length_counts_bytes_not_characters() {
    let s = start(
        r##"
m = next_request()
body = {"contents": "日本語\U0001F600é"}
raw = res(m, body)
assert len(raw.split(b"\r\n\r\n", 1)[1]) > len("日本語\U0001F600é") + 20
put(raw)
put(res(next_request(), {"contents": "next"}))
serve_rest()
"##,
    )
    .await;
    let first = s.client.hover(hover_params()).await.unwrap();
    assert_eq!(hover_text(first), "\u{65e5}\u{672c}\u{8a9e}\u{1F600}\u{e9}");
    let second = hover_within(&s.client, 5).await.unwrap();
    assert_eq!(hover_text(second), "next");
    s.client.shutdown().await.unwrap();
}

// ---------------------------------------------------------------------------
// Malformed frames
// ---------------------------------------------------------------------------

const MALFORMED_BODY: &str = r##"
BADS = {
    "nohdr": b'X-Other: 1\r\n\r\n{"jsonrpc":"2.0","id":2,"result":null}',
    "badlen": b"Content-Length: abc\r\n\r\n{}",
    "badjson": b"Content-Length: 9\r\n\r\n{not json",
    "badutf8": b"Content-Length: 4\r\n\r\n\xff\xfe\xfd\xfc",
    "hugehdr": b"X-Big: " + b"a" * 3000,
}
m = next_request()
put(BADS[KIND])
serve_rest()
"##;

async fn start_malformed(kind: &str) -> Srv {
    start(&format!("KIND = {kind:?}\n{MALFORMED_BODY}")).await
}

const FATAL_KINDS: [&str; 5] = ["nohdr", "badlen", "badjson", "badutf8", "hugehdr"];

#[tokio::test]
async fn malformed_frame_fails_pending_request_without_hanging() {
    for kind in FATAL_KINDS {
        let s = start_malformed(kind).await;
        let r = hover_within(&s.client, 5).await;
        assert!(r.is_err(), "{kind}: expected an error, got {r:?}");
        // State after a framing error: the transport is torn down and the client
        // reports it (no resynchronisation is attempted).
        assert!(s.client.is_closed(), "{kind}: client should report closed");
        s.client.terminate().await;
    }
}

#[tokio::test]
async fn request_after_fatal_frame_fails_fast_instead_of_waiting_for_timeout() {
    for kind in ["nohdr", "badjson"] {
        let s = start_malformed(kind).await;
        assert!(hover_within(&s.client, 5).await.is_err());
        // The transport is gone. A new request must fail promptly, not sit in the
        // pending map until the 30 second default timeout.
        let started = Instant::now();
        let r = tokio::time::timeout(Duration::from_secs(5), s.client.hover(hover_params())).await;
        match r {
            Ok(Err(_)) => {}
            other => panic!(
                "{kind}: request on a dead transport must error fast, got {other:?} after {:?}",
                started.elapsed()
            ),
        }
        s.client.terminate().await;
    }
}

#[tokio::test]
async fn valid_json_that_is_not_a_message_is_skipped_and_client_stays_usable() {
    let s = start(
        r##"
m = next_request()
put(frame({"foo": 1}))
put(frame([1, 2, 3]))
put(res(m, {"contents": "survived"}))
serve_rest()
"##,
    )
    .await;
    let h = hover_within(&s.client, 5).await.unwrap();
    assert_eq!(hover_text(h), "survived");
    assert!(!s.client.is_closed());
    let again = hover_within(&s.client, 5).await.unwrap();
    assert_eq!(hover_text(again), "ok");
    s.client.shutdown().await.unwrap();
}

// ---------------------------------------------------------------------------
// Correlation and interleaving
// ---------------------------------------------------------------------------

const OUT_OF_ORDER_BODY: &str = r##"
reqs = [next_request() for _ in range(3)]
answers = {
    "textDocument/hover": {"contents": "hover-answer"},
    "textDocument/completion": [{"label": "completion-answer"}],
    "textDocument/definition": {
        "uri": "file:///def.rs",
        "range": {"start": {"line": 3, "character": 0}, "end": {"line": 3, "character": 1}},
    },
}
frames = [res(r, answers[r["method"]]) for r in reversed(reqs)]
if COALESCE:
    put(b"".join(frames))
else:
    for f in frames:
        put(f)
        time.sleep(0.05)
serve_rest()
"##;

async fn out_of_order(coalesce: bool) {
    let flag = if coalesce { "True" } else { "False" };
    let s = start(&format!("COALESCE = {flag}\n{OUT_OF_ORDER_BODY}")).await;
    let (h, c, d) = tokio::join!(
        s.client.hover(hover_params()),
        s.client.completion(completion_params()),
        s.client.definition(definition_params()),
    );
    assert_eq!(hover_text(h.unwrap()), "hover-answer");
    match c.unwrap().expect("completion result") {
        CompletionResponse::Array(items) => {
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].label, "completion-answer");
        }
        other => panic!("unexpected completion shape {other:?}"),
    }
    match d.unwrap().expect("definition result") {
        GotoDefinitionResponse::Scalar(loc) => {
            assert_eq!(loc.uri.as_str(), "file:///def.rs");
            assert_eq!(loc.range.start.line, 3);
        }
        other => panic!("unexpected definition shape {other:?}"),
    }
    s.client.shutdown().await.unwrap();
}

#[tokio::test]
async fn three_concurrent_requests_answered_in_reverse_order() {
    out_of_order(false).await;
}

#[tokio::test]
async fn three_concurrent_requests_answered_in_reverse_order_in_one_write() {
    out_of_order(true).await;
}

#[tokio::test]
async fn notifications_arriving_between_request_and_response_are_delivered() {
    let s = start(
        r##"
m = next_request()
put(note("textDocument/publishDiagnostics", {"uri": "file:///a.txt", "diagnostics": []}))
put(note("custom/progress", {"n": 1}))
time.sleep(0.2)
put(res(m, {"contents": "after-notifications"}))
serve_rest()
"##,
    )
    .await;
    let h = hover_within(&s.client, 5).await.unwrap();
    assert_eq!(hover_text(h), "after-notifications");
    match next_event(&s.client).await {
        ServerEvent::Diagnostics(d) => assert_eq!(d.uri.as_str(), "file:///a.txt"),
        _ => panic!("expected diagnostics first"),
    }
    match next_event(&s.client).await {
        ServerEvent::Notification { method, params } => {
            assert_eq!(method, "custom/progress");
            assert_eq!(params.unwrap()["n"], 1);
        }
        _ => panic!("expected custom/progress second"),
    }
    s.client.shutdown().await.unwrap();
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cancelled_request_sends_cancel_with_its_id_and_late_responses_are_ignored() {
    let s = start(
        r##"
m = next_request()
log({"hover_id": m["id"]})
while True:
    c = read()
    if c is None:
        sys.exit(0)
    if c.get("method") == "$/cancelRequest":
        put(frame({"jsonrpc": "2.0", "id": 99999, "result": None}))
        put(res(m, {"contents": "late"}))
        break
serve_rest()
"##,
    )
    .await;
    let token = CancellationToken::new();
    let t2 = token.clone();
    let client = std::sync::Arc::new(s.client);
    let c2 = client.clone();
    let task = tokio::spawn(async move { c2.hover_with_cancel(hover_params(), t2).await });

    let e = wait_log(&s.log, "hover id", |e| {
        e.iter().any(|x| x.get("hover_id").is_some())
    })
    .await;
    let hover_id = e.iter().find_map(|x| x.get("hover_id").cloned()).unwrap();
    token.cancel();
    let r = task.await.unwrap();
    assert!(matches!(r, Err(LspError::Cancelled)), "{r:?}");

    wait_log(&s.log, "cancelRequest", |e| {
        e.iter().any(|x| x["in"]["method"] == "$/cancelRequest")
    })
    .await;
    let cancels: Vec<Value> = received(&s.log)
        .into_iter()
        .filter(|m| m["method"] == "$/cancelRequest")
        .collect();
    assert_eq!(cancels.len(), 1, "{cancels:?}");
    assert_eq!(cancels[0]["params"]["id"], hover_id);

    // The late reply for the cancelled id and the reply for an unknown id are
    // dropped; the next request still works and nothing crashed.
    let next = hover_within(&client, 5).await.unwrap();
    assert_eq!(hover_text(next), "ok");
    assert!(!client.is_closed());
    client.shutdown().await.unwrap();
}

// ---------------------------------------------------------------------------
// Server-initiated requests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn server_requests_are_answered_with_matching_id_type_and_result() {
    let s = start(
        r##"
m = next_request()
put(frame({"jsonrpc": "2.0", "id": "srv-7", "method": "workspace/configuration",
           "params": {"items": [{"section": "a"}, {"section": "b"}]}}))
put(frame({"jsonrpc": "2.0", "id": 41, "method": "custom/unknown", "params": {}}))
put(frame({"jsonrpc": "2.0", "id": 0, "method": "window/workDoneProgress/create",
           "params": {"token": "t"}}))
got = 0
while got < 3:
    r = read()
    if r is None:
        sys.exit(0)
    if "method" not in r:
        got += 1
put(res(m, {"contents": "after-requests"}))
serve_rest()
"##,
    )
    .await;
    let client = std::sync::Arc::new(s.client);
    let c2 = client.clone();
    let hover = tokio::spawn(async move { c2.hover(hover_params()).await });

    for _ in 0..3 {
        match next_event(&client).await {
            ServerEvent::Request { id, method, params } => {
                client
                    .reply_to_server_request(id, &method, params.as_ref())
                    .await
                    .unwrap();
            }
            _ => panic!("expected a server request"),
        }
    }
    let h = tokio::time::timeout(Duration::from_secs(5), hover)
        .await
        .expect("hover hung")
        .unwrap()
        .unwrap();
    assert_eq!(hover_text(h), "after-requests");

    let replies: Vec<Value> = received(&s.log)
        .into_iter()
        .filter(|m| m.get("method").is_none())
        .collect();
    assert_eq!(replies.len(), 3, "{replies:?}");
    let by_id = |id: Value| replies.iter().find(|r| r["id"] == id).cloned();

    let cfg = by_id(json!("srv-7")).expect("string id preserved");
    assert_eq!(cfg["result"], json!([{}, {}]));
    let unknown = by_id(json!(41)).expect("numeric id preserved");
    assert_eq!(unknown["error"]["code"], -32601);
    let progress = by_id(json!(0)).expect("zero id preserved");
    assert!(progress["result"].is_null() && progress.get("error").is_none());
    client.shutdown().await.unwrap();
}

// ---------------------------------------------------------------------------
// Document versions on the wire
// ---------------------------------------------------------------------------

fn range_change(sl: u32, sc: u32, el: u32, ec: u32, text: &str) -> TextDocumentContentChangeEvent {
    TextDocumentContentChangeEvent {
        range: Some(Range::new(Position::new(sl, sc), Position::new(el, ec))),
        range_length: None,
        text: text.to_string(),
    }
}

fn did_change(
    version: i32,
    changes: Vec<TextDocumentContentChangeEvent>,
) -> DidChangeTextDocumentParams {
    DidChangeTextDocumentParams {
        text_document: VersionedTextDocumentIdentifier {
            uri: uri(),
            version,
        },
        content_changes: changes,
    }
}

#[tokio::test]
async fn rapid_did_change_versions_strictly_increase_on_the_wire() {
    let s = start("serve_rest()").await;
    let c = &s.client;
    c.did_open(DidOpenTextDocumentParams {
        text_document: TextDocumentItem {
            uri: uri(),
            language_id: "text".into(),
            version: 1,
            text: "a\u{1F600}b\n\u{65e5}\u{672c}\u{8a9e}".into(),
        },
    })
    .await
    .unwrap();

    // Emoji (2 UTF-16 units) on line 0, CJK (1 unit each) on line 1.
    c.did_change(did_change(2, vec![range_change(0, 1, 0, 3, "X")]))
        .await
        .unwrap();
    c.did_change(did_change(3, vec![range_change(1, 1, 1, 2, "\u{1F600}")]))
        .await
        .unwrap();
    for v in 4..=21 {
        c.did_change(did_change(v, vec![range_change(0, 0, 0, 0, "-")]))
            .await
            .unwrap();
    }

    // Repeated, lower and zero versions are rejected locally and never sent.
    for bad in [21, 20, 1, 0] {
        let r = c
            .did_change(did_change(bad, vec![range_change(0, 0, 0, 0, "!")]))
            .await;
        assert!(
            matches!(r, Err(LspError::VersionMismatch { .. })),
            "v{bad}: {r:?}"
        );
    }
    // A change that fails to apply must not consume its version number.
    let r = c
        .did_change(did_change(22, vec![range_change(9, 0, 9, 0, "!")]))
        .await;
    assert!(r.is_err(), "out of range line must be rejected");
    c.did_change(did_change(22, vec![range_change(0, 0, 0, 0, "+")]))
        .await
        .unwrap();

    // Barrier: the server handles stdin in order, so once hover is answered every
    // earlier notification is in the log.
    assert_eq!(hover_text(hover_within(c, 5).await.unwrap()), "ok");
    let versions: Vec<i64> = received(&s.log)
        .iter()
        .filter(|m| m["method"] == "textDocument/didChange")
        .map(|m| m["params"]["textDocument"]["version"].as_i64().unwrap())
        .collect();
    assert_eq!(versions, (2..=22).collect::<Vec<i64>>());
    s.client.shutdown().await.unwrap();
}

// ---------------------------------------------------------------------------
// UTF-16 range edits (TrackedDocument)
// ---------------------------------------------------------------------------

fn doc(text: &str) -> TrackedDocument {
    TrackedDocument::new("file:///a.txt".into(), "text".into(), 1, text.into())
}

fn edit(text: &str, changes: Vec<TextDocumentContentChangeEvent>) -> String {
    let mut d = doc(text);
    d.apply_changes(changes, 2).unwrap();
    d.content().to_string()
}

#[test]
fn utf16_edit_replaces_an_emoji_by_two_units() {
    assert_eq!(
        edit("a\u{1F600}b", vec![range_change(0, 1, 0, 3, "X")]),
        "aXb"
    );
}

#[test]
fn utf16_edit_inserts_right_after_an_emoji() {
    assert_eq!(
        edit("a\u{1F600}b", vec![range_change(0, 3, 0, 3, "!")]),
        "a\u{1F600}!b"
    );
}

#[test]
fn utf16_edit_cjk_is_one_unit_per_character() {
    assert_eq!(
        edit(
            "\u{65e5}\u{672c}\u{8a9e}",
            vec![range_change(0, 1, 0, 2, "X")]
        ),
        "\u{65e5}X\u{8a9e}"
    );
    assert_eq!(
        edit(
            "\u{65e5}\u{672c}\u{8a9e}",
            vec![range_change(0, 3, 0, 3, "!")]
        ),
        "\u{65e5}\u{672c}\u{8a9e}!"
    );
}

#[test]
fn utf16_edit_combining_mark_is_its_own_unit() {
    let text = "e\u{301}x";
    assert_eq!(edit(text, vec![range_change(0, 1, 0, 2, "")]), "ex");
    assert_eq!(
        edit(text, vec![range_change(0, 0, 0, 2, "\u{e9}")]),
        "\u{e9}x"
    );
}

#[test]
fn utf16_edit_spans_lines_with_crlf_and_astral_characters() {
    let text = "x\u{1F600}\r\n\u{65e5}\u{672c}\r\nz";
    assert_eq!(
        edit(text, vec![range_change(1, 1, 2, 0, "|")]),
        "x\u{1F600}\r\n\u{65e5}|z"
    );
    // Start of the third line is addressed by line, not by counting the CRLF.
    assert_eq!(
        edit(text, vec![range_change(0, 3, 0, 3, "!")]),
        "x\u{1F600}!\r\n\u{65e5}\u{672c}\r\nz"
    );
}

#[test]
fn utf16_later_changes_in_one_event_see_earlier_results() {
    // First change grows the emoji run, second addresses the shifted `b`.
    let out = edit(
        "a\u{1F600}b",
        vec![
            range_change(0, 1, 0, 3, "\u{1F600}\u{1F600}"),
            range_change(0, 5, 0, 6, "Z"),
        ],
    );
    assert_eq!(out, "a\u{1F600}\u{1F600}Z");
}

#[test]
fn utf16_range_length_is_counted_in_code_units() {
    let mut ok = range_change(0, 1, 0, 3, "X");
    ok.range_length = Some(2);
    assert_eq!(edit("a\u{1F600}b", vec![ok]), "aXb");

    let mut bad = range_change(0, 1, 0, 3, "X");
    bad.range_length = Some(1);
    let mut d = doc("a\u{1F600}b");
    assert!(d.apply_changes(vec![bad], 2).is_err());
    assert_eq!(d.content(), "a\u{1F600}b");
    assert_eq!(d.version, 1);
}

#[test]
fn utf16_position_inside_surrogate_pair_or_past_line_end_is_rejected_atomically() {
    let mut d = doc("a\u{1F600}b");
    for bad in [
        range_change(0, 2, 0, 3, "X"),
        range_change(0, 0, 0, 99, "X"),
    ] {
        // Second change is invalid, so the valid first change must not stick.
        let r = d.apply_changes(vec![range_change(0, 0, 0, 1, "Q"), bad], 2);
        assert!(r.is_err());
        assert_eq!(d.content(), "a\u{1F600}b");
        assert_eq!(d.version, 1);
    }
}

// ---------------------------------------------------------------------------
// Child cleanup
// ---------------------------------------------------------------------------

#[tokio::test]
async fn dropping_the_client_kills_and_reaps_the_child() {
    let s = start("serve_rest()").await;
    let pid = server_pid(&s.log);
    assert!(
        ps_state(pid).is_some(),
        "server should be alive before drop"
    );
    drop(s.client);

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        // Yield to the runtime so tokio can reap the killed child.
        tokio::time::sleep(Duration::from_millis(50)).await;
        match ps_state(pid) {
            None => break,
            Some(state) => assert!(
                Instant::now() < deadline,
                "pid {pid} still present after drop (ps state {state:?}, Z means zombie)"
            ),
        }
    }
}

#[tokio::test]
async fn shutdown_kills_and_reaps_a_server_that_ignores_shutdown_and_exit() {
    let s = start("time.sleep(120)").await;
    let pid = server_pid(&s.log);
    assert!(ps_state(pid).is_some());
    let started = Instant::now();
    let _ = s
        .client
        .shutdown_with_timeout(Duration::from_millis(300))
        .await;
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(
        ps_state(pid),
        None,
        "stubborn child must be gone and reaped"
    );
}
