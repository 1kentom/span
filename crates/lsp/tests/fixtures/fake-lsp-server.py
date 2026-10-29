"""Minimal fake LSP server for manager tests.

Usage: fake-lsp-server.py MODE
Modes: progress, progress-open, nav, nav-flat, nav-modified, nav-hang (navigation requests), normal, slow-exit, slow-init, bad-init, nodef, hang, slow-shutdown, save-text, save, watched
Every message received is appended as one JSON line to $FAKE_LSP_LOG.
"""
import json
import os
import sys
import time

mode = sys.argv[1] if len(sys.argv) > 1 else "normal"
log_path = os.environ.get("FAKE_LSP_LOG")
docs = {}
state = {}


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


def progress_burst(mode):
    """Work done progress: create, begin, a burst of reports, and end (not for -open)."""
    send({"id": "wd-1", "method": "window/workDoneProgress/create", "params": {"token": "tok-1"}})
    send({"method": "$/progress", "params": {"token": "tok-1", "value": {
        "kind": "begin", "title": "Indexing project", "percentage": 0}}})
    for i in range(1, 21):
        send({"method": "$/progress", "params": {"token": "tok-1", "value": {
            "kind": "report", "message": "%d/20" % i, "percentage": i * 5 if mode != "progress-open" else 35}}})
    if mode != "progress-open":
        send({"method": "$/progress", "params": {"token": "tok-1", "value": {
            "kind": "end", "message": "done"}}})


NAV_CAPS = {
    "referencesProvider": True,
    "implementationProvider": True,
    "typeDefinitionProvider": {},
    "declarationProvider": True,
    "documentSymbolProvider": True,
    "workspaceSymbolProvider": True,
    "callHierarchyProvider": True,
    "typeHierarchyProvider": True,
    "documentHighlightProvider": True,
    "signatureHelpProvider": {"triggerCharacters": ["("]},
    "renameProvider": {"prepareProvider": True},
}


def rng(l1, c1, l2, c2):
    return {"start": {"line": l1, "character": c1}, "end": {"line": l2, "character": c2}}


def nav_item(uri, name="target"):
    return {"name": name, "kind": 12, "detail": "fn", "uri": uri,
            "range": rng(2, 0, 4, 1), "selectionRange": rng(2, 3, 2, 9),
            "data": {"opaque": [1, 2, {"k": "v"}]}}


def nav_reply(msg, mode):
    """Canned answers for the navigation requests, or False when not handled."""
    method = msg["method"]
    params = msg.get("params") or {}
    uri = (params.get("textDocument") or {}).get("uri") or (params.get("item") or {}).get("uri") or "file:///x"
    if method == "textDocument/references":
        if mode == "nav-modified" and not state.get("modified"):
            state["modified"] = True
            send({"id": msg["id"], "error": {"code": -32801, "message": "content modified"}})
            return True
        if mode == "nav-hang":
            return True
        reply(msg, [{"uri": uri, "range": rng(0, 0, 0, 3)},
                    {"uri": "file:///elsewhere/lib.d.ts", "range": rng(5, 1, 5, 4)}])
        state["include_declaration"] = params.get("context", {}).get("includeDeclaration")
    elif method == "textDocument/implementation":
        reply(msg, [{"targetUri": uri, "targetRange": rng(1, 0, 3, 1),
                     "targetSelectionRange": rng(1, 2, 1, 5)}])
    elif method == "textDocument/typeDefinition":
        reply(msg, {"uri": uri, "range": rng(7, 0, 7, 4)})
    elif method == "textDocument/declaration":
        reply(msg, [{"uri": uri, "range": rng(0, 1, 0, 2)}])
    elif method == "textDocument/documentSymbol":
        if mode == "nav-flat":
            reply(msg, [{"name": "Flat", "kind": 5, "containerName": "pkg",
                         "location": {"uri": uri, "range": rng(0, 0, 3, 1)}}])
        else:
            reply(msg, [{"name": "Outer", "kind": 5, "detail": "class",
                         "range": rng(0, 0, 9, 1), "selectionRange": rng(0, 6, 0, 11),
                         "children": [{"name": "inner", "kind": 6,
                                       "range": rng(1, 2, 3, 3), "selectionRange": rng(1, 2, 1, 7)}]}])
    elif method == "workspace/symbol":
        q = params.get("query", "")
        reply(msg, [{"name": q + "Sym", "kind": 12, "containerName": "mod",
                     "location": {"uri": uri if uri != "file:///x" else "file:///elsewhere/lib.d.ts",
                                  "range": rng(0, 0, 0, 3)}},
                    {"name": "Lazy", "kind": 5, "location": {"uri": "file:///elsewhere/lazy.d.ts"}}])
    elif method == "textDocument/prepareCallHierarchy" or method == "textDocument/prepareTypeHierarchy":
        reply(msg, [nav_item(uri)])
    elif method in ("callHierarchy/incomingCalls",):
        reply(msg, [{"from": nav_item(uri, "caller"), "fromRanges": [rng(3, 4, 3, 8)]}])
    elif method in ("callHierarchy/outgoingCalls",):
        reply(msg, [{"to": nav_item(uri, "callee"), "fromRanges": [rng(3, 4, 3, 8)]}])
    elif method in ("typeHierarchy/supertypes", "typeHierarchy/subtypes"):
        reply(msg, [nav_item(uri, method.split("/")[1])])
    elif method == "textDocument/documentHighlight":
        reply(msg, [{"range": rng(0, 0, 0, 3), "kind": 2}, {"range": rng(2, 0, 2, 3)}])
    elif method == "textDocument/signatureHelp":
        reply(msg, {"signatures": [{"label": "f(a, b)", "documentation": "doc",
                                    "parameters": [{"label": [2, 3]}, {"label": "b"}]}],
                    "activeSignature": 0, "activeParameter": 1})
    elif method == "textDocument/prepareRename":
        reply(msg, {"range": rng(0, 0, 0, 3), "placeholder": "old"})
    elif method == "textDocument/rename":
        reply(msg, {"changes": {uri: [{"range": rng(0, 0, 0, 3), "newText": params["newName"]}]}})
    elif method == "java/classFileContents":
        reply(msg, "public class Foo {}\n")
    else:
        return False
    return True


while True:
    msg = read()
    if msg is None:
        break
    method = msg.get("method")
    if method is None:
        log({"method": "response", "id": msg.get("id"), "result": msg.get("result"),
             "pid": os.getpid()})
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
        if mode.startswith("nav"):
            caps.update(NAV_CAPS)
        reply(msg, {"capabilities": caps})
    elif method == "initialized":
        if os.environ.get("FAKE_LSP_STDERR"):
            sys.stderr.write("fake stderr line\n")
            sys.stderr.flush()
        send({"id": "srv-1", "method": "workspace/configuration",
              "params": {"items": [{"section": "x"}]}})
        if mode == "watched":
            send({"id": "watch-1", "method": "client/registerCapability", "params": {
                "registrations": [{"id": "java-files", "method": "workspace/didChangeWatchedFiles",
                                   "registerOptions": {"watchers": [{"globPattern": "**/*.java"}]}}]}})
        if mode.startswith("progress"):
            progress_burst(mode)
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
        if mode == "slow-exit":
            time.sleep(float(os.environ.get("FAKE_LSP_EXIT_DELAY", "1.5")))
            log({"method": "exited-cleanly"})
        sys.exit(0)
    elif mode.startswith("nav") and "id" in msg and nav_reply(msg, mode):
        pass
    elif "id" in msg:
        send({"id": msg["id"], "error": {"code": -32601, "message": "no such method"}})
