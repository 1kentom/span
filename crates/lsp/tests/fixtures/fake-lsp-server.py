"""Minimal fake LSP server for manager tests.

Usage: fake-lsp-server.py MODE
Modes: normal, slow-init, bad-init, nodef, hang, slow-shutdown, save-text, save
Every message received is appended as one JSON line to $FAKE_LSP_LOG.
"""
import json
import os
import sys
import time

mode = sys.argv[1] if len(sys.argv) > 1 else "normal"
log_path = os.environ.get("FAKE_LSP_LOG")
docs = {}


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
    body = sys.stdin.buffer.read(int(headers["content-length"]))
    return json.loads(body)


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
        log({"method": "response", "id": msg.get("id"), "result": msg.get("result")})
        continue
    log({"method": method, "params": msg.get("params"), "id": msg.get("id"),
         "pid": os.getpid()})

    if method == "initialize":
        if mode == "bad-init":
            os._exit(3)
        if mode == "slow-init":
            time.sleep(1.0)
        caps = {
            "positionEncoding": "utf-16",
            "textDocumentSync": {"openClose": True, "change": 2},
            "hoverProvider": True,
            "completionProvider": {},
            "documentFormattingProvider": True,
        }
        if mode == "save-text":
            caps["textDocumentSync"]["save"] = {"includeText": True}
        elif mode == "save":
            caps["textDocumentSync"]["save"] = True
        if mode != "nodef":
            caps["definitionProvider"] = True
        reply(msg, {"capabilities": caps})
    elif method == "initialized":
        send({"id": "srv-1", "method": "workspace/configuration",
              "params": {"items": [{"section": "x"}]}})
    elif method == "textDocument/didOpen":
        item = msg["params"]["textDocument"]
        docs[item["uri"]] = item["text"]
        send({"method": "textDocument/publishDiagnostics",
              "params": {"uri": item["uri"], "diagnostics": [
                  {"range": {"start": {"line": 0, "character": 0},
                             "end": {"line": 0, "character": 1}},
                   "message": "opened"}]}})
    elif method == "textDocument/hover":
        uri = msg["params"]["textDocument"]["uri"]
        if "crash" in docs.get(uri, ""):
            os._exit(1)
        if mode == "hang":
            continue
        reply(msg, {"contents": "hover"})
    elif method == "textDocument/definition":
        reply(msg, None)
    elif method == "textDocument/formatting":
        reply(msg, [])
    elif method == "shutdown":
        if mode == "slow-shutdown":
            time.sleep(1.5)
        reply(msg, None)
    elif method == "exit":
        sys.exit(0)
    elif "id" in msg:
        send({"id": msg["id"], "error": {"code": -32601, "message": "no such method"}})
