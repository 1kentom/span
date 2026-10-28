//! LSP client implementation with lifecycle, request correlation, and document sync.
//!
//! Implements initialize/initialized/shutdown/exit lifecycle, request/response correlation,
//! server notifications and server-initiated requests, request cancellation and timeouts,
//! per the Language Server Protocol 3.17 specification.

use crate::document::DocumentRegistry;
use crate::error::{LspError, Result};
use crate::protocol::{Message, Notification, Request, RequestId, RequestIdGenerator, Response};
use crate::transport::{StdioReader, StdioWriter};
use lsp_types::*;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tokio::time::{timeout, Duration};

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
}

impl LspClient {
    pub async fn spawn(command: &str, args: &[String], cwd: Option<PathBuf>) -> Result<Self> {
        let mut cmd = Command::new(command);
        cmd.args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

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

        let receiver_task = Self::spawn_receiver_task(
            reader,
            pending_requests.clone(),
            event_tx,
            shutdown_flag.clone(),
            process.clone(),
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
        })
    }

    fn spawn_receiver_task(
        mut reader: StdioReader,
        pending_requests: Arc<RwLock<HashMap<RequestId, PendingRequest>>>,
        event_tx: mpsc::UnboundedSender<ServerEvent>,
        shutdown_flag: Arc<RwLock<bool>>,
        process: Arc<Mutex<Child>>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                if *shutdown_flag.read().await {
                    break;
                }

                let value = match reader.receive().await {
                    Ok(v) => v,
                    Err(e) => {
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

    pub async fn next_event(&self) -> Option<ServerEvent> {
        self.event_rx.lock().await.recv().await
    }

    async fn send_request(&self, method: String, params: Option<Value>) -> Result<Value> {
        self.send_request_with_timeout(method, params, DEFAULT_REQUEST_TIMEOUT)
            .await
    }

    async fn send_request_with_timeout(
        &self,
        method: String,
        params: Option<Value>,
        timeout_duration: Duration,
    ) -> Result<Value> {
        if *self.shutdown_flag.read().await {
            return Err(LspError::Shutdown);
        }

        let id = self.id_gen.next();
        let request = Request::new(id.clone(), method.clone(), params);

        let (tx, rx) = oneshot::channel();

        {
            let mut pending = self.pending_requests.write().await;
            pending.insert(id.clone(), PendingRequest { sender: tx });
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

        let result = timeout(timeout_duration, rx).await;

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
        let value = serde_json::to_value(params)?;
        let result = self
            .send_request("initialize".to_string(), Some(value))
            .await?;

        let init_result: InitializeResult = serde_json::from_value(result)?;

        self.send_notification("initialized".to_string(), Some(serde_json::json!({})))
            .await?;

        *self.initialized.write().await = true;

        Ok(init_result)
    }

    pub async fn shutdown(&self) -> Result<()> {
        if *self.initialized.read().await {
            // Send shutdown request and wait for response
            self.send_request("shutdown".to_string(), None).await?;

            // Send exit notification
            self.send_notification("exit".to_string(), None).await?;
        }

        // Mark shutdown to stop receiver task
        *self.shutdown_flag.write().await = true;

        // Allow receiver task to finish
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Wait for child process to exit, then kill if needed
        if let Ok(mut child) = self.process.try_lock() {
            match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
                Ok(Ok(_)) => {}
                _ => {
                    let _ = child.kill().await;
                    let _ = tokio::time::timeout(Duration::from_millis(500), child.wait()).await;
                }
            }
        }

        // Wait for receiver task to complete
        if let Some(task) = self.receiver_task.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(1), task).await;
        }

        Ok(())
    }

    pub async fn completion(&self, params: CompletionParams) -> Result<Option<CompletionResponse>> {
        let value = serde_json::to_value(params)?;
        let result = self
            .send_request("textDocument/completion".to_string(), Some(value))
            .await?;

        if result.is_null() {
            return Ok(None);
        }

        Ok(Some(serde_json::from_value(result)?))
    }

    pub async fn hover(&self, params: HoverParams) -> Result<Option<Hover>> {
        let value = serde_json::to_value(params)?;
        let result = self
            .send_request("textDocument/hover".to_string(), Some(value))
            .await?;

        if result.is_null() {
            return Ok(None);
        }

        Ok(Some(serde_json::from_value(result)?))
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
        cancel_token: tokio_util::sync::CancellationToken,
    ) -> Result<Option<CompletionResponse>> {
        let value = serde_json::to_value(params)?;

        tokio::select! {
            result = self.send_request("textDocument/completion".to_string(), Some(value)) => {
                let result = result?;
                if result.is_null() {
                    return Ok(None);
                }
                Ok(Some(serde_json::from_value(result)?))
            }
            _ = cancel_token.cancelled() => {
                Err(LspError::Cancelled)
            }
        }
    }

    pub async fn hover_with_cancel(
        &self,
        params: HoverParams,
        cancel_token: tokio_util::sync::CancellationToken,
    ) -> Result<Option<Hover>> {
        let value = serde_json::to_value(params)?;

        tokio::select! {
            result = self.send_request("textDocument/hover".to_string(), Some(value)) => {
                let result = result?;
                if result.is_null() {
                    return Ok(None);
                }
                Ok(Some(serde_json::from_value(result)?))
            }
            _ = cancel_token.cancelled() => {
                Err(LspError::Cancelled)
            }
        }
    }

    pub async fn respond_to_request(&self, id: RequestId, result: Value) -> Result<()> {
        let response = Response::success(id, result);
        let value = serde_json::to_value(response)?;
        self.writer.send(&value).await
    }
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
