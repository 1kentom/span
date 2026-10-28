"""Fake language server for the desktop service tests.

Usage: fake-lsp-server.py MODE
Modes: normal, slow-hover, fail-format, hang-format, slow-shutdown
Every message received is appended as one JSON line to $FAKE_LSP_LOG, together with the
server's pid so tests can check that the process is gone.
"""
import json
import os
import sys
import time

mode = sys.argv[1] if len(sys.argv) > 1 else "normal"
log_path = os.environ.get("FAKE_LSP_LOG")


def log(entry):
    if log_path:
        with open(log_path, "a") as f:
            f.write(json.dumps(entry) + "\n")


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


def send(msg):
    msg["jsonrpc"] = "2.0"
    b = json.dumps(msg).encode()
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n" % len(b) + b)
    sys.stdout.buffer.flush()


def reply(msg, result):
    send({"id": msg["id"], "result": result})


while True:
    msg = read()
    if msg is None:
        break
    method = msg.get("method")
    if method is None:
        continue
    log({"method": method, "params": msg.get("params"), "pid": os.getpid()})
    if method == "initialize":
        reply(msg, {"capabilities": {
            "positionEncoding": "utf-16",
            "textDocumentSync": {"openClose": True, "change": 2, "save": True},
            "hoverProvider": True,
            "completionProvider": {},
            "definitionProvider": True,
            "documentFormattingProvider": True,
        }})
    elif method == "textDocument/didOpen":
        item = msg["params"]["textDocument"]
        send({"method": "textDocument/publishDiagnostics",
              "params": {"uri": item["uri"], "version": item["version"], "diagnostics": [
                  {"range": {"start": {"line": 0, "character": 0},
                             "end": {"line": 0, "character": 1}},
                   "severity": 2, "source": "fake", "code": "F1", "message": "opened"}]}})
    elif method == "textDocument/completion":
        reply(msg, {"isIncomplete": False, "items": [
            {"label": "alpha", "kind": 3, "detail": "fn alpha"},
            {"label": "beta", "insertText": "beta($1)", "insertTextFormat": 2}]})
    elif method == "textDocument/hover":
        if mode == "slow-hover":
            time.sleep(1.0)
        reply(msg, {"contents": {"kind": "markdown", "value": "hover"}})
    elif method == "textDocument/definition":
        reply(msg, None)
    elif method == "textDocument/formatting":
        if mode == "fail-format":
            send({"id": msg["id"], "error": {"code": -32603, "message": "formatter exploded"}})
        elif mode == "hang-format":
            continue
        else:
            reply(msg, [{"range": {"start": {"line": 0, "character": 0},
                                   "end": {"line": 0, "character": 0}}, "newText": "// "}])
    elif method == "shutdown":
        if mode == "slow-shutdown":
            time.sleep(30)
        reply(msg, None)
    elif method == "exit":
        sys.exit(0)
    elif "id" in msg:
        send({"id": msg["id"], "error": {"code": -32601, "message": "no such method"}})
