//! LSP client implementation with lifecycle, request correlation, and document sync.
//!
//! Implements initialize/initialized/shutdown/exit lifecycle, request/response correlation,
//! server notifications and server-initiated requests, request cancellation and timeouts,
//! per the Language Server Protocol 3.17 specification.

use crate::document::DocumentRegistry;
use crate::error::{LspError, Result};
use crate::protocol::{
    Message, Notification, Request, RequestId, RequestIdGenerator, Response, ResponseError,
};
use crate::transport::{StdioReader, StdioWriter};
use lsp_types::*;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tokio::time::{timeout, Duration};
use tokio_util::sync::CancellationToken;

const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub enum ServerEvent {
    Notification {
        method: String,
        params: Option<Value>,
    },
    Request {
        id: RequestId,
        method: String,
        params: Option<Value>,
    },
    Diagnostics(PublishDiagnosticsParams),
}

struct PendingRequest {
    sender: oneshot::Sender<Result<Value>>,
}

pub struct LspClient {
    writer: Arc<StdioWriter>,
    process: Arc<Mutex<Child>>,
    id_gen: RequestIdGenerator,
    pending_requests: Arc<RwLock<HashMap<RequestId, PendingRequest>>>,
    documents: Arc<RwLock<DocumentRegistry>>,
    event_rx: Arc<Mutex<mpsc::UnboundedReceiver<ServerEvent>>>,
    initialized: Arc<RwLock<bool>>,
    shutdown_flag: Arc<RwLock<bool>>,
    receiver_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// Set by the receiver task as soon as the transport is gone (child exit or EOF).
    closed: Arc<AtomicBool>,
    capabilities: Arc<StdMutex<Option<ServerCapabilities>>>,
    workspace_folders: Arc<StdMutex<Vec<WorkspaceFolder>>>,
}

impl LspClient {
    pub async fn spawn(command: &str, args: &[String], cwd: Option<PathBuf>) -> Result<Self> {
        Self::spawn_with_env(command, args, cwd, &[]).await
    }

    /// Spawn a server with extra environment variables. Arguments are passed as an
    /// array, never through a shell.
    pub async fn spawn_with_env(
        command: &str,
        args: &[String],
        cwd: Option<PathBuf>,
        env: &[(String, String)],
    ) -> Result<Self> {
        let mut cmd = Command::new(command);
        cmd.args(args)
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }

        let mut child = cmd.spawn()?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| LspError::Protocol("Failed to capture stdin".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| LspError::Protocol("Failed to capture stdout".to_string()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| LspError::Protocol("Failed to capture stderr".to_string()))?;

        let writer = Arc::new(StdioWriter::new(stdin));
        let reader = StdioReader::new(stdout, stderr);

        let process = Arc::new(Mutex::new(child));
        let pending_requests = Arc::new(RwLock::new(HashMap::new()));
        let documents = Arc::new(RwLock::new(DocumentRegistry::new()));
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let initialized = Arc::new(RwLock::new(false));
        let shutdown_flag = Arc::new(RwLock::new(false));
        let closed = Arc::new(AtomicBool::new(false));

        let receiver_task = Self::spawn_receiver_task(
            reader,
            pending_requests.clone(),
            event_tx,
            shutdown_flag.clone(),
            process.clone(),
            closed.clone(),
        );

        Ok(Self {
            writer,
            process,
            id_gen: RequestIdGenerator::new(),
            pending_requests,
            documents,
            event_rx: Arc::new(Mutex::new(event_rx)),
            initialized,
            shutdown_flag,
            receiver_task: Arc::new(Mutex::new(Some(receiver_task))),
            closed,
            capabilities: Arc::new(StdMutex::new(None)),
            workspace_folders: Arc::new(StdMutex::new(Vec::new())),
        })
    }

    fn spawn_receiver_task(
        mut reader: StdioReader,
        pending_requests: Arc<RwLock<HashMap<RequestId, PendingRequest>>>,
        event_tx: mpsc::UnboundedSender<ServerEvent>,
        shutdown_flag: Arc<RwLock<bool>>,
        process: Arc<Mutex<Child>>,
        closed: Arc<AtomicBool>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                if *shutdown_flag.read().await {
                    break;
                }

                let value = match reader.receive().await {
                    Ok(v) => v,
                    Err(e) => {
                        closed.store(true, Ordering::SeqCst);
                        if !*shutdown_flag.read().await {
                            eprintln!("[LSP] Transport error: {}", e);
                            Self::fail_pending_requests(&pending_requests, e).await;
                        }
                        break;
                    }
                };

                let message = match Message::parse(value) {
                    Ok(m) => m,
                    Err(e) => {
                        eprintln!("[LSP] Parse error: {}", e);
                        continue;
                    }
                };

                match message {
                    Message::Response(resp) => {
                        Self::handle_response(&pending_requests, resp).await;
                    }
                    Message::Notification(notif) => {
                        Self::handle_notification(&event_tx, notif).await;
                    }
                    Message::Request(req) => {
                        let _ = event_tx.send(ServerEvent::Request {
                            id: req.id,
                            method: req.method,
                            params: req.params,
                        });
                    }
                }
            }

            closed.store(true, Ordering::SeqCst);
            reader.shutdown();

            // Reap the child process
            if let Ok(mut child) = process.try_lock() {
                let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
                let _ = child.kill().await;
            }

            drop(event_tx);
        })
    }

    async fn handle_response(
        pending_requests: &Arc<RwLock<HashMap<RequestId, PendingRequest>>>,
        response: Response,
    ) {
        let pending = {
            let mut requests = pending_requests.write().await;
            requests.remove(&response.id)
        };

        if let Some(pending) = pending {
            let result = if let Some(error) = response.error {
                Err(LspError::ServerError {
                    code: error.code,
                    message: error.message,
                    data: error.data,
                })
            } else {
                Ok(response.result.unwrap_or(Value::Null))
            };

            let _ = pending.sender.send(result);
        }
    }

    async fn handle_notification(
        event_tx: &mpsc::UnboundedSender<ServerEvent>,
        notification: Notification,
    ) {
        if notification.method == "textDocument/publishDiagnostics" {
            if let Some(ref params) = notification.params {
                if let Ok(diagnostics) =
                    serde_json::from_value::<PublishDiagnosticsParams>(params.clone())
                {
                    let _ = event_tx.send(ServerEvent::Diagnostics(diagnostics));
                    return;
                }
            }
        }

        let _ = event_tx.send(ServerEvent::Notification {
            method: notification.method,
            params: notification.params,
        });
    }

    async fn fail_pending_requests(
        pending_requests: &Arc<RwLock<HashMap<RequestId, PendingRequest>>>,
        error: LspError,
    ) {
        let pending = {
            let mut requests = pending_requests.write().await;
            std::mem::take(&mut *requests)
        };

        let error_msg = error.to_string();
        for (_, req) in pending {
            let _ = req.sender.send(Err(LspError::Protocol(error_msg.clone())));
        }
    }

    /// Complete every in-flight request with [`LspError::Shutdown`] right away.
    async fn fail_pending_with_shutdown(
        pending_requests: &Arc<RwLock<HashMap<RequestId, PendingRequest>>>,
    ) {
        let pending = {
            let mut requests = pending_requests.write().await;
            std::mem::take(&mut *requests)
        };
        for (_, req) in pending {
            let _ = req.sender.send(Err(LspError::Shutdown));
        }
    }

    pub async fn next_event(&self) -> Option<ServerEvent> {
        self.event_rx.lock().await.recv().await
    }

    async fn send_request(&self, method: String, params: Option<Value>) -> Result<Value> {
        self.send_request_inner(method, params, DEFAULT_REQUEST_TIMEOUT, None)
            .await
    }

    /// Core request path. When `cancel` fires the pending entry is dropped and a
    /// `$/cancelRequest` notification is sent so the server can stop working.
    async fn send_request_inner(
        &self,
        method: String,
        params: Option<Value>,
        timeout_duration: Duration,
        cancel: Option<&CancellationToken>,
    ) -> Result<Value> {
        if *self.shutdown_flag.read().await {
            return Err(LspError::Shutdown);
        }
        if self.is_closed() {
            return Err(LspError::Protocol("server transport is closed".to_string()));
        }

        let id = self.id_gen.next();
        let request = Request::new(id.clone(), method.clone(), params);

        let (tx, rx) = oneshot::channel();

        {
            let mut pending = self.pending_requests.write().await;
            pending.insert(id.clone(), PendingRequest { sender: tx });
        }
        // The receiver marks the client closed before it drains pending requests, so a
        // close that raced the insert above is caught here instead of waiting for the timeout.
        if self.is_closed() {
            self.pending_requests.write().await.remove(&id);
            return Err(LspError::Protocol("server transport is closed".to_string()));
        }

        let value = match request.to_value() {
            Ok(v) => v,
            Err(e) => {
                self.pending_requests.write().await.remove(&id);
                return Err(e);
            }
        };

        if let Err(e) = self.writer.send(&value).await {
            self.pending_requests.write().await.remove(&id);
            return Err(e);
        }

        let cancelled = async {
            match cancel {
                Some(token) => token.cancelled().await,
                None => std::future::pending::<()>().await,
            }
        };

        let result = tokio::select! {
            r = timeout(timeout_duration, rx) => r,
            _ = cancelled => {
                self.pending_requests.write().await.remove(&id);
                let cancel_params = serde_json::json!({ "id": id });
                let _ = self
                    .send_notification("$/cancelRequest".to_string(), Some(cancel_params))
                    .await;
                return Err(LspError::Cancelled);
            }
        };

        match result {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => {
                self.pending_requests.write().await.remove(&id);
                Err(LspError::Cancelled)
            }
            Err(_) => {
                self.pending_requests.write().await.remove(&id);
                let cancel_params = serde_json::json!({ "id": id });
                let _ = self
                    .send_notification("$/cancelRequest".to_string(), Some(cancel_params))
                    .await;
                Err(LspError::Timeout)
            }
        }
    }

    async fn send_notification(&self, method: String, params: Option<Value>) -> Result<()> {
        let notification = Notification::new(method, params);
        let value = notification.to_value()?;
        self.writer.send(&value).await
    }

    pub async fn initialize(&self, params: InitializeParams) -> Result<InitializeResult> {
        let folders = params.workspace_folders.clone().unwrap_or_default();
        let value = serde_json::to_value(params)?;
        let result = self
            .send_request("initialize".to_string(), Some(value))
            .await?;

        let init_result: InitializeResult = serde_json::from_value(result)?;

        if let Some(encoding) = &init_result.capabilities.position_encoding {
            if *encoding != PositionEncodingKind::UTF16 {
                return Err(LspError::Protocol(format!(
                    "server selected unsupported position encoding {}",
                    encoding.as_str()
                )));
            }
        }

        if let Ok(mut guard) = self.capabilities.lock() {
            *guard = Some(init_result.capabilities.clone());
        }
        if let Ok(mut guard) = self.workspace_folders.lock() {
            *guard = folders;
        }

        self.send_notification("initialized".to_string(), Some(serde_json::json!({})))
            .await?;

        *self.initialized.write().await = true;

        Ok(init_result)
    }

    /// True once the transport is gone (child exited or stdout reached EOF).
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Capabilities the server advertised in `initialize`, if initialized.
    pub fn server_capabilities(&self) -> Option<ServerCapabilities> {
        self.capabilities.lock().ok().and_then(|g| g.clone())
    }

    pub fn supports_completion(&self) -> bool {
        self.has_capability(|c| c.completion_provider.is_some())
    }

    pub fn supports_hover(&self) -> bool {
        self.has_capability(|c| match &c.hover_provider {
            Some(HoverProviderCapability::Simple(b)) => *b,
            Some(HoverProviderCapability::Options(_)) => true,
            None => false,
        })
    }

    pub fn supports_definition(&self) -> bool {
        self.has_capability(|c| one_of_enabled(&c.definition_provider))
    }

    pub fn supports_formatting(&self) -> bool {
        self.has_capability(|c| one_of_enabled(&c.document_formatting_provider))
    }

    pub fn supports_range_formatting(&self) -> bool {
        self.has_capability(|c| one_of_enabled(&c.document_range_formatting_provider))
    }

    /// How the server wants document changes: `None` means it does not want
    /// change notifications at all.
    pub fn text_document_sync_kind(&self) -> Option<TextDocumentSyncKind> {
        let caps = self.server_capabilities()?;
        match caps.text_document_sync? {
            TextDocumentSyncCapability::Kind(kind) => Some(kind),
            TextDocumentSyncCapability::Options(opts) => opts.change,
        }
        .filter(|k| *k != TextDocumentSyncKind::NONE)
    }

    fn has_capability(&self, f: impl Fn(&ServerCapabilities) -> bool) -> bool {
        self.server_capabilities().map(|c| f(&c)).unwrap_or(false)
    }

    fn require(&self, supported: bool, what: &str) -> Result<()> {
        if supported {
            Ok(())
        } else {
            Err(LspError::Unsupported(what.to_string()))
        }
    }

    /// Send `shutdown` then `exit`, wait for the child, and kill it if it does not
    /// exit in time. The child is always reaped. Uses a 5 second grace period.
    pub async fn shutdown(&self) -> Result<()> {
        self.shutdown_with_timeout(Duration::from_secs(5)).await
    }

    pub async fn shutdown_with_timeout(&self, grace: Duration) -> Result<()> {
        let mut outcome = Ok(());

        // Requests already in flight must not wait out their own timeout.
        Self::fail_pending_with_shutdown(&self.pending_requests).await;

        if *self.initialized.read().await && !self.is_closed() {
            if let Err(e) = self
                .send_request_inner("shutdown".to_string(), None, grace, None)
                .await
            {
                outcome = Err(e);
            }

            // Stop treating transport EOF as an error before the child goes away.
            *self.shutdown_flag.write().await = true;
            Self::fail_pending_with_shutdown(&self.pending_requests).await;

            // Send exit even if shutdown failed, so a half-alive server can leave.
            let _ = self.send_notification("exit".to_string(), None).await;
        } else {
            *self.shutdown_flag.write().await = true;
            Self::fail_pending_with_shutdown(&self.pending_requests).await;
        }

        self.reap(grace).await;

        if let Some(task) = self.receiver_task.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(1), task).await;
        }

        outcome
    }

    /// Kill the child immediately and reap it. Used when a server is unusable.
    pub async fn terminate(&self) {
        *self.shutdown_flag.write().await = true;
        Self::fail_pending_with_shutdown(&self.pending_requests).await;
        self.reap(Duration::ZERO).await;
        if let Some(task) = self.receiver_task.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(1), task).await;
        }
    }

    /// Wait up to `grace` for the child to exit on its own, then kill and wait.
    async fn reap(&self, grace: Duration) {
        let mut child = self.process.lock().await;
        match tokio::time::timeout(grace, child.wait()).await {
            Ok(Ok(_)) => {}
            _ => {
                let _ = child.kill().await;
                let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            }
        }
    }

    async fn typed_request<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
        cancel: Option<&CancellationToken>,
    ) -> Result<Option<T>> {
        let result = self
            .send_request_inner(
                method.to_string(),
                Some(params),
                DEFAULT_REQUEST_TIMEOUT,
                cancel,
            )
            .await?;

        if result.is_null() {
            return Ok(None);
        }

        Ok(Some(serde_json::from_value(result)?))
    }

    pub async fn completion(&self, params: CompletionParams) -> Result<Option<CompletionResponse>> {
        self.require(self.supports_completion(), "completion")?;
        let value = serde_json::to_value(params)?;
        self.typed_request("textDocument/completion", value, None)
            .await
    }

    pub async fn hover(&self, params: HoverParams) -> Result<Option<Hover>> {
        self.require(self.supports_hover(), "hover")?;
        let value = serde_json::to_value(params)?;
        self.typed_request("textDocument/hover", value, None).await
    }

    pub async fn definition(
        &self,
        params: GotoDefinitionParams,
    ) -> Result<Option<GotoDefinitionResponse>> {
        self.definition_inner(params, None).await
    }

    pub async fn definition_with_cancel(
        &self,
        params: GotoDefinitionParams,
        cancel_token: CancellationToken,
    ) -> Result<Option<GotoDefinitionResponse>> {
        self.definition_inner(params, Some(&cancel_token)).await
    }

    async fn definition_inner(
        &self,
        params: GotoDefinitionParams,
        cancel: Option<&CancellationToken>,
    ) -> Result<Option<GotoDefinitionResponse>> {
        self.require(self.supports_definition(), "textDocument/definition")?;
        let value = serde_json::to_value(params)?;
        self.typed_request("textDocument/definition", value, cancel)
            .await
    }

    pub async fn formatting(
        &self,
        params: DocumentFormattingParams,
    ) -> Result<Option<Vec<TextEdit>>> {
        self.formatting_inner(params, None).await
    }

    pub async fn formatting_with_cancel(
        &self,
        params: DocumentFormattingParams,
        cancel_token: CancellationToken,
    ) -> Result<Option<Vec<TextEdit>>> {
        self.formatting_inner(params, Some(&cancel_token)).await
    }

    async fn formatting_inner(
        &self,
        params: DocumentFormattingParams,
        cancel: Option<&CancellationToken>,
    ) -> Result<Option<Vec<TextEdit>>> {
        self.require(self.supports_formatting(), "textDocument/formatting")?;
        let value = serde_json::to_value(params)?;
        self.typed_request("textDocument/formatting", value, cancel)
            .await
    }

    pub async fn range_formatting(
        &self,
        params: DocumentRangeFormattingParams,
    ) -> Result<Option<Vec<TextEdit>>> {
        self.range_formatting_inner(params, None).await
    }

    pub async fn range_formatting_with_cancel(
        &self,
        params: DocumentRangeFormattingParams,
        cancel_token: CancellationToken,
    ) -> Result<Option<Vec<TextEdit>>> {
        self.range_formatting_inner(params, Some(&cancel_token))
            .await
    }

    async fn range_formatting_inner(
        &self,
        params: DocumentRangeFormattingParams,
        cancel: Option<&CancellationToken>,
    ) -> Result<Option<Vec<TextEdit>>> {
        self.require(
            self.supports_range_formatting(),
            "textDocument/rangeFormatting",
        )?;
        let value = serde_json::to_value(params)?;
        self.typed_request("textDocument/rangeFormatting", value, cancel)
            .await
    }

    pub async fn did_open(&self, params: DidOpenTextDocumentParams) -> Result<()> {
        let uri = params.text_document.uri.to_string();
        let language_id = params.text_document.language_id.clone();
        let version = params.text_document.version;
        let content = params.text_document.text.clone();

        {
            let mut docs = self.documents.write().await;
            docs.open(uri, language_id, version, content);
        }

        let value = serde_json::to_value(params)?;
        self.send_notification("textDocument/didOpen".to_string(), Some(value))
            .await
    }

    pub async fn did_change(&self, params: DidChangeTextDocumentParams) -> Result<()> {
        let uri = params.text_document.uri.to_string();
        let version = params.text_document.version;

        {
            let mut docs = self.documents.write().await;
            docs.update(&uri, params.content_changes.clone(), version)?;
        }

        let value = serde_json::to_value(params)?;
        self.send_notification("textDocument/didChange".to_string(), Some(value))
            .await
    }

    pub async fn did_close(&self, params: DidCloseTextDocumentParams) -> Result<()> {
        let uri = params.text_document.uri.to_string();

        {
            let mut docs = self.documents.write().await;
            docs.close(&uri);
        }

        let value = serde_json::to_value(params)?;
        self.send_notification("textDocument/didClose".to_string(), Some(value))
            .await
    }

    pub async fn cancel_request(&self, id: RequestId) -> Result<()> {
        if let Some(pending) = self.pending_requests.write().await.remove(&id) {
            let _ = pending.sender.send(Err(LspError::Cancelled));
        }

        let params = serde_json::json!({ "id": id });
        self.send_notification("$/cancelRequest".to_string(), Some(params))
            .await
    }

    pub async fn completion_with_cancel(
        &self,
        params: CompletionParams,
        cancel_token: CancellationToken,
    ) -> Result<Option<CompletionResponse>> {
        self.require(self.supports_completion(), "completion")?;
        let value = serde_json::to_value(params)?;
        self.typed_request("textDocument/completion", value, Some(&cancel_token))
            .await
    }

    pub async fn hover_with_cancel(
        &self,
        params: HoverParams,
        cancel_token: CancellationToken,
    ) -> Result<Option<Hover>> {
        self.require(self.supports_hover(), "hover")?;
        let value = serde_json::to_value(params)?;
        self.typed_request("textDocument/hover", value, Some(&cancel_token))
            .await
    }

    pub async fn respond_to_request(&self, id: RequestId, result: Value) -> Result<()> {
        let response = Response::success(id, result);
        let value = serde_json::to_value(response)?;
        self.writer.send(&value).await
    }
}

impl LspClient {
    pub async fn respond_with_error(
        &self,
        id: RequestId,
        code: i64,
        message: impl Into<String>,
    ) -> Result<()> {
        let response = Response::error(id, ResponseError::new(code, message.into(), None));
        let value = serde_json::to_value(response)?;
        self.writer.send(&value).await
    }

    /// Answer a server-initiated request with the reply a minimal client owes it, so
    /// the server never waits forever. Unknown methods get MethodNotFound.
    pub async fn reply_to_server_request(
        &self,
        id: RequestId,
        method: &str,
        params: Option<&Value>,
    ) -> Result<()> {
        let result = match method {
            // One empty settings object per requested item. `null` is legal LSP but
            // the VS Code CSS/SCSS/Less server then silently skips validation, while
            // `{}` makes it fall back to its defaults.
            "workspace/configuration" => {
                let count = params
                    .and_then(|p| p.get("items"))
                    .and_then(|i| i.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                Value::Array(vec![serde_json::json!({}); count])
            }
            "client/registerCapability"
            | "client/unregisterCapability"
            | "window/workDoneProgress/create"
            | "workspace/diagnostic/refresh"
            | "workspace/codeLens/refresh"
            | "workspace/semanticTokens/refresh"
            | "workspace/inlayHint/refresh" => Value::Null,
            // No action item chosen.
            "window/showMessageRequest" => Value::Null,
            "window/showDocument" => serde_json::json!({ "success": false }),
            "workspace/applyEdit" => serde_json::json!({
                "applied": false,
                "failureReason": "this client does not apply server-initiated edits"
            }),
            "workspace/workspaceFolders" => {
                let folders = self
                    .workspace_folders
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_default();
                serde_json::to_value(folders)?
            }
            _ => {
                return self
                    .respond_with_error(
                        id,
                        crate::protocol::error_codes::METHOD_NOT_FOUND,
                        format!("method not supported by client: {method}"),
                    )
                    .await;
            }
        };
        self.respond_to_request(id, result).await
    }
}

fn one_of_enabled<T>(opt: &Option<OneOf<bool, T>>) -> bool {
    match opt {
        Some(OneOf::Left(b)) => *b,
        Some(OneOf::Right(_)) => true,
        None => false,
    }
}

/// Convert an absolute filesystem path to a `file://` URI.
pub fn path_to_uri(path: &Path) -> Result<Uri> {
    let url = url::Url::from_file_path(path)
        .map_err(|_| LspError::Protocol(format!("not an absolute path: {}", path.display())))?;
    url.as_str()
        .parse::<Uri>()
        .map_err(|e| LspError::Protocol(format!("invalid uri {}: {}", url, e)))
}

/// Client capabilities Span declares: UTF-16 positions plus synchronization,
/// completion, hover, definition, formatting and publishDiagnostics.
pub fn client_capabilities() -> ClientCapabilities {
    let markup = Some(vec![MarkupKind::Markdown, MarkupKind::PlainText]);
    ClientCapabilities {
        general: Some(GeneralClientCapabilities {
            position_encodings: Some(vec![PositionEncodingKind::UTF16]),
            ..Default::default()
        }),
        text_document: Some(TextDocumentClientCapabilities {
            synchronization: Some(TextDocumentSyncClientCapabilities {
                dynamic_registration: Some(false),
                will_save: Some(false),
                will_save_wait_until: Some(false),
                did_save: Some(false),
            }),
            completion: Some(CompletionClientCapabilities {
                dynamic_registration: Some(false),
                completion_item: Some(CompletionItemCapability {
                    // The VS Code HTML, CSS and JSON servers only advertise
                    // `completionProvider` to clients that support snippets, so
                    // declaring `false` made completion "unsupported" for them.
                    snippet_support: Some(true),
                    documentation_format: markup.clone(),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            hover: Some(HoverClientCapabilities {
                dynamic_registration: Some(false),
                content_format: markup,
            }),
            definition: Some(GotoCapability {
                dynamic_registration: Some(false),
                link_support: Some(false),
            }),
            formatting: Some(DocumentFormattingClientCapabilities {
                dynamic_registration: Some(false),
            }),
            range_formatting: Some(DocumentRangeFormattingClientCapabilities {
                dynamic_registration: Some(false),
            }),
            publish_diagnostics: Some(PublishDiagnosticsClientCapabilities {
                related_information: Some(true),
                version_support: Some(true),
                ..Default::default()
            }),
            ..Default::default()
        }),
        workspace: Some(WorkspaceClientCapabilities {
            configuration: Some(true),
            workspace_folders: Some(true),
            ..Default::default()
        }),
        window: Some(WindowClientCapabilities {
            work_done_progress: Some(true),
            ..Default::default()
        }),
        ..Default::default()
    }
}

/// Build `InitializeParams` with the root uri, a single workspace folder named after
/// the root directory, `initializationOptions` and [`client_capabilities`].
pub fn build_initialize_params(
    root: &Path,
    initialization_options: Option<Value>,
) -> Result<InitializeParams> {
    let uri = path_to_uri(root)?;
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "workspace".to_string());
    #[allow(deprecated)]
    Ok(InitializeParams {
        process_id: Some(std::process::id()),
        client_info: Some(ClientInfo {
            name: "span".to_string(),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
        }),
        root_uri: Some(uri.clone()),
        initialization_options,
        capabilities: client_capabilities(),
        workspace_folders: Some(vec![WorkspaceFolder { uri, name }]),
        ..Default::default()
    })
}

impl Drop for LspClient {
    fn drop(&mut self) {
        if let Ok(mut flag) = self.shutdown_flag.try_write() {
            *flag = true;
        }

        if let Ok(mut child) = self.process.try_lock() {
            let _ = child.start_kill();
        }

        if let Ok(mut task_guard) = self.receiver_task.try_lock() {
            if let Some(task) = task_guard.take() {
                task.abort();
            }
        }
    }
}
