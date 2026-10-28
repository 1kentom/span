//! Lazy start, reuse, restart and shutdown of language server processes.
//!
//! One server instance exists per `(ServerId, workspace root)`. An instance is started
//! on first use by a lifecycle task that resolves the launch command, spawns the
//! process, runs `initialize`, flushes `didOpen` for every buffered document and only
//! then marks the instance `Ready`, all under one lock so that text queued while the
//! server was starting and later edits stay correctly ordered.
//!
//! Unsaved text lives in the manager's own [`TrackedDocument`] buffers, so it survives
//! a server crash: a restart reopens every buffered document with its latest text.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use lsp_types::{
    CallHierarchyIncomingCall, CallHierarchyIncomingCallsParams, CallHierarchyItem,
    CallHierarchyOutgoingCall, CallHierarchyOutgoingCallsParams, CallHierarchyPrepareParams,
    CompletionParams, CompletionResponse, DidChangeTextDocumentParams, DidCloseTextDocumentParams,
    DidOpenTextDocumentParams, DidSaveTextDocumentParams, DocumentFormattingParams,
    DocumentHighlight, DocumentHighlightParams, DocumentRangeFormattingParams,
    DocumentSymbolParams, DocumentSymbolResponse, GotoDefinitionParams, GotoDefinitionResponse,
    Hover, HoverParams, Location, PrepareRenameResponse, PublishDiagnosticsParams, ReferenceParams,
    RenameParams, SignatureHelp, SignatureHelpParams, TextDocumentContentChangeEvent,
    TextDocumentIdentifier, TextDocumentItem, TextDocumentPositionParams, TextDocumentSyncKind,
    TextEdit, TypeHierarchyItem, TypeHierarchyPrepareParams, TypeHierarchySubtypesParams,
    TypeHierarchySupertypesParams, VersionedTextDocumentIdentifier, WorkspaceEdit,
    WorkspaceSymbolParams, WorkspaceSymbolResponse,
};
use tokio::sync::{broadcast, watch, Mutex, OwnedMutexGuard};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::spec::{LaunchSpec, ServerId, ServerSpec};
use crate::{
    build_initialize_params, path_to_uri, LspClient, LspError, ServerEvent, TrackedDocument,
};

/// Failure to produce a launch command for a server (not installed, install failed...).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ServerError {
    #[error("language server {0:?} is not installed")]
    NotInstalled(ServerId),
    #[error("cannot launch language server: {0}")]
    Launch(String),
}

/// Turns a [`ServerId`] into a concrete launch command, typically by consulting the
/// install cache and runtime detection.
pub trait LaunchResolver: Send + Sync + 'static {
    fn resolve(&self, id: ServerId)
        -> impl Future<Output = Result<LaunchSpec, ServerError>> + Send;

    /// Like [`resolve`](Self::resolve) but also told the workspace root the instance
    /// is for, so a resolver can allocate per-workspace state (for example the JDT LS
    /// data directory). The default ignores the root and calls `resolve`.
    fn resolve_for(
        &self,
        id: ServerId,
        _root: &Path,
    ) -> impl Future<Output = Result<LaunchSpec, ServerError>> + Send {
        self.resolve(id)
    }
}

trait ErasedResolver: Send + Sync + 'static {
    fn resolve<'a>(
        &'a self,
        id: ServerId,
        root: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<LaunchSpec, ServerError>> + Send + 'a>>;
}

impl<R: LaunchResolver> ErasedResolver for R {
    fn resolve<'a>(
        &'a self,
        id: ServerId,
        root: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<LaunchSpec, ServerError>> + Send + 'a>> {
        Box::pin(LaunchResolver::resolve_for(self, id, root))
    }
}

#[derive(Debug, Clone)]
pub struct ManagerConfig {
    /// Upper bound for the `initialize` handshake.
    pub init_timeout: Duration,
    /// How long a server gets to exit after `shutdown`/`exit` before it is killed.
    pub shutdown_grace: Duration,
}

impl Default for ManagerConfig {
    fn default() -> Self {
        Self {
            init_timeout: Duration::from_secs(60),
            shutdown_grace: Duration::from_secs(5),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerState {
    Starting,
    Ready,
    /// Launch or `initialize` failed; the message says why.
    Failed(String),
    /// The process went away while it was `Ready`.
    Crashed,
    Stopped,
}

/// The three stages of a `$/progress` work done report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkProgressKind {
    Begin,
    Report,
    End,
}

/// Parse the params of a `$/progress` notification that carries work done progress.
/// Other progress payloads (partial results) are ignored.
pub fn parse_work_progress(
    params: &serde_json::Value,
) -> Option<(
    String,
    WorkProgressKind,
    Option<String>,
    Option<String>,
    Option<u32>,
)> {
    let token = match params.get("token")? {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        _ => return None,
    };
    let value = params.get("value")?;
    let kind = match value.get("kind")?.as_str()? {
        "begin" => WorkProgressKind::Begin,
        "report" => WorkProgressKind::Report,
        "end" => WorkProgressKind::End,
        _ => return None,
    };
    let text = |key: &str| value.get(key).and_then(|v| v.as_str()).map(str::to_owned);
    let percentage = value
        .get("percentage")
        .and_then(|v| v.as_u64())
        .map(|p| p.min(100) as u32);
    Some((token, kind, text("title"), text("message"), percentage))
}

/// Broadcast to subscribers; slow receivers may lag and miss events.
#[derive(Debug, Clone)]
pub enum ManagerEvent {
    /// Work done progress (`$/progress`) from a server: indexing, importing, building.
    Progress {
        server: ServerId,
        root: PathBuf,
        token: String,
        kind: WorkProgressKind,
        title: Option<String>,
        message: Option<String>,
        percentage: Option<u32>,
    },
    StateChanged {
        server: ServerId,
        root: PathBuf,
        state: ServerState,
    },
    Diagnostics {
        server: ServerId,
        root: PathBuf,
        params: PublishDiagnosticsParams,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum ManagerError {
    #[error("unknown language server {0:?}")]
    UnknownServer(ServerId),
    #[error("language server is not running")]
    NotStarted,
    #[error("language server is not ready: {0:?}")]
    NotReady(ServerState),
    #[error("language server does not support {0}")]
    Unsupported(String),
    #[error("language server crashed: {0}")]
    ServerCrashed(String),
    #[error("request cancelled")]
    Cancelled,
    #[error("language server failed to initialize: {0}")]
    InitializeFailed(String),
    #[error(transparent)]
    Lsp(LspError),
}

type Key = (ServerId, PathBuf);

struct Inner {
    docs: HashMap<String, TrackedDocument>,
    /// Last version used by a document that was closed. A reopened document continues
    /// from here, so diagnostics a server published for the earlier life of the
    /// document can never be mistaken for the new one.
    closed_versions: HashMap<String, i32>,
    client: Option<Arc<LspClient>>,
    ready: bool,
    /// Set under the instance lock once the buffers were handed to a replacement or
    /// the instance was shut down. A caller that finds it set must look the instance
    /// up again, so an edit or open can never land in an orphaned instance.
    retired: bool,
}

struct Instance {
    id: ServerId,
    root: PathBuf,
    state_tx: watch::Sender<ServerState>,
    events: broadcast::Sender<ManagerEvent>,
    inner: Arc<Mutex<Inner>>,
    stop: CancellationToken,
    task: StdMutex<Option<JoinHandle<()>>>,
}

impl Instance {
    fn set_state(&self, state: ServerState) {
        self.state_tx.send_replace(state.clone());
        let _ = self.events.send(ManagerEvent::StateChanged {
            server: self.id,
            root: self.root.clone(),
            state,
        });
    }

    fn state(&self) -> ServerState {
        self.state_tx.borrow().clone()
    }

    fn is_live(&self) -> bool {
        matches!(self.state(), ServerState::Starting | ServerState::Ready)
    }

    async fn fail(&self, message: String) {
        let mut inner = self.inner.lock().await;
        inner.ready = false;
        inner.client = None;
        self.set_state(ServerState::Failed(message));
    }
}

/// Chooses the `initialize` options for a server at start time, given whether the
/// project may run its own code (build scripts, proc macros, Gradle and Maven import).
/// `(server, server root, global run project code flag)`; the root lets the provider decide
/// per workspace trust.
pub type OptionsProvider = Arc<dyn Fn(ServerId, &Path, bool) -> serde_json::Value + Send + Sync>;

struct ManagerShared {
    run_project_code: AtomicBool,
    options_provider: StdMutex<Option<OptionsProvider>>,
    specs: HashMap<ServerId, ServerSpec>,
    resolver: Arc<dyn ErasedResolver>,
    config: ManagerConfig,
    instances: Mutex<HashMap<Key, Arc<Instance>>>,
    events: broadcast::Sender<ManagerEvent>,
}

/// Owns every running language server. Cheap to clone.
#[derive(Clone)]
pub struct Manager {
    shared: Arc<ManagerShared>,
}

/// Defines a manager wrapper for one navigation request on a ready server. Capability
/// gating, cancellation and `ContentModified` retries live in the client's shared path.
macro_rules! manager_nav {
    ($name:ident, $client_fn:ident, $params:ty, $out:ty) => {
        pub async fn $name(
            &self,
            id: ServerId,
            root: &Path,
            params: $params,
            cancel: Option<CancellationToken>,
        ) -> Result<Option<$out>, ManagerError> {
            let client = self.ready_client(id, root).await?;
            client
                .$client_fn(params, cancel.unwrap_or_default())
                .await
                .map_err(|e| map_err(&client, e))
        }
    };
}

impl Manager {
    pub fn new<R: LaunchResolver>(
        specs: Vec<ServerSpec>,
        resolver: Arc<R>,
        config: ManagerConfig,
    ) -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            shared: Arc::new(ManagerShared {
                run_project_code: AtomicBool::new(false),
                options_provider: StdMutex::new(None),
                specs: specs.into_iter().map(|s| (s.id, s)).collect(),
                resolver,
                config,
                instances: Mutex::new(HashMap::new()),
                events,
            }),
        }
    }

    /// Replace the per start initialization options. Without a provider each spec's own
    /// `initialization_options` are sent.
    pub fn set_options_provider(&self, provider: OptionsProvider) {
        *self
            .shared
            .options_provider
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(provider);
    }

    /// Whether servers started from now on may run the project's own code. Defaults to
    /// false. Running servers keep the options they were started with: restart them.
    pub fn set_run_project_code(&self, allow: bool) {
        self.shared.run_project_code.store(allow, Ordering::SeqCst);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ManagerEvent> {
        self.shared.events.subscribe()
    }

    /// Start the server for `(id, root)` unless a live instance already exists. A
    /// crashed, failed or stopped instance is replaced and its buffered documents are
    /// carried over. Returns immediately; watch the receiver for `Ready`.
    pub async fn start(
        &self,
        id: ServerId,
        root: &Path,
    ) -> Result<watch::Receiver<ServerState>, ManagerError> {
        self.start_impl(id, root, true).await
    }

    /// `replace_failed` is false for implicit starts (opening a document): a `Failed`
    /// instance is then kept, so a broken install is not retried on every open.
    async fn start_impl(
        &self,
        id: ServerId,
        root: &Path,
        replace_failed: bool,
    ) -> Result<watch::Receiver<ServerState>, ManagerError> {
        let spec = self
            .shared
            .specs
            .get(&id)
            .ok_or(ManagerError::UnknownServer(id))?
            .clone();
        let key = (id, root.to_path_buf());

        let mut map = self.shared.instances.lock().await;
        let mut docs = HashMap::new();
        if let Some(existing) = map.get(&key) {
            let keep = existing.is_live()
                || (!replace_failed && matches!(existing.state(), ServerState::Failed(_)));
            if keep {
                return Ok(existing.state_tx.subscribe());
            }
            let mut old = existing.inner.lock().await;
            old.retired = true;
            docs = std::mem::take(&mut old.docs);
        }

        let (state_tx, state_rx) = watch::channel(ServerState::Starting);
        let inst = Arc::new(Instance {
            id,
            root: root.to_path_buf(),
            state_tx,
            events: self.shared.events.clone(),
            inner: Arc::new(Mutex::new(Inner {
                docs,
                closed_versions: HashMap::new(),
                client: None,
                ready: false,
                retired: false,
            })),
            stop: CancellationToken::new(),
            task: StdMutex::new(None),
        });
        let _ = self.shared.events.send(ManagerEvent::StateChanged {
            server: id,
            root: root.to_path_buf(),
            state: ServerState::Starting,
        });
        let provider = self
            .shared
            .options_provider
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let options = match provider {
            Some(provider) => provider(
                id,
                root,
                self.shared.run_project_code.load(Ordering::SeqCst),
            ),
            None => spec.initialization_options.clone(),
        };
        let handle = tokio::spawn(run_instance(
            inst.clone(),
            spec,
            options,
            self.shared.resolver.clone(),
            self.shared.config.clone(),
        ));
        *inst.task.lock().unwrap() = Some(handle);
        map.insert(key, inst);
        Ok(state_rx)
    }

    pub async fn state(&self, id: ServerId, root: &Path) -> Option<ServerState> {
        self.get(id, root).await.map(|i| i.state())
    }

    /// Wait until the instance leaves `Starting`. `Ok` only if it became `Ready`.
    pub async fn wait_ready(
        &self,
        id: ServerId,
        root: &Path,
        limit: Duration,
    ) -> Result<(), ManagerError> {
        let inst = self.get(id, root).await.ok_or(ManagerError::NotStarted)?;
        let mut rx = inst.state_tx.subscribe();
        let waited =
            tokio::time::timeout(limit, rx.wait_for(|s| !matches!(s, ServerState::Starting))).await;
        let state = match waited {
            Ok(Ok(s)) => s.clone(),
            Ok(Err(_)) => ServerState::Stopped,
            Err(_) => return Err(ManagerError::NotReady(ServerState::Starting)),
        };
        match state {
            ServerState::Ready => Ok(()),
            ServerState::Failed(m) => Err(ManagerError::InitializeFailed(m)),
            ServerState::Crashed => Err(ManagerError::ServerCrashed("process exited".into())),
            other => Err(ManagerError::NotReady(other)),
        }
    }

    /// Open (or replace) a document. Starts the server lazily. While the server is
    /// still starting the text is only buffered and sent with the initial `didOpen`.
    /// Returns the document version.
    pub async fn open_document(
        &self,
        id: ServerId,
        root: &Path,
        path: &Path,
        language_id: &str,
        text: String,
    ) -> Result<i32, ManagerError> {
        let uri = path_to_uri(path).map_err(ManagerError::Lsp)?;
        loop {
            self.start_impl(id, root, false).await?;
            let Some((inst, mut inner)) = self.lock_current(id, root).await else {
                continue;
            };
            let result = open_locked(&mut inner, uri.clone(), language_id, text.clone()).await;
            // A Failed server is not respawned by an implicit open: the text stays
            // buffered for the next explicit start, and the caller is told why.
            if let ServerState::Failed(m) = inst.state() {
                result?;
                return Err(ManagerError::NotReady(ServerState::Failed(m)));
            }
            return result;
        }
    }

    /// Apply edits to the buffered document and forward them to the server if it is
    /// ready and wants change notifications. Returns the new version.
    pub async fn change_document(
        &self,
        id: ServerId,
        root: &Path,
        path: &Path,
        changes: Vec<TextDocumentContentChangeEvent>,
    ) -> Result<i32, ManagerError> {
        let uri = path_to_uri(path).map_err(ManagerError::Lsp)?;
        let (_inst, mut inner) = self
            .lock_current(id, root)
            .await
            .ok_or(ManagerError::NotStarted)?;
        change_locked(&mut inner, uri, changes).await
    }

    pub async fn close_document(
        &self,
        id: ServerId,
        root: &Path,
        path: &Path,
    ) -> Result<(), ManagerError> {
        let uri = path_to_uri(path).map_err(ManagerError::Lsp)?;
        let (_inst, mut inner) = self
            .lock_current(id, root)
            .await
            .ok_or(ManagerError::NotStarted)?;
        let key = uri.to_string();
        if let Some(doc) = inner.docs.remove(&key) {
            inner.closed_versions.insert(key, doc.version);
        }
        if inner.ready {
            if let Some(client) = inner.client.clone() {
                client
                    .did_close(DidCloseTextDocumentParams {
                        text_document: TextDocumentIdentifier { uri },
                    })
                    .await
                    .map_err(|e| map_err(&client, e))?;
            }
        }
        Ok(())
    }

    /// Tell the server a tracked document was saved. Sent only to a ready server whose
    /// capabilities ask for `didSave`; the text is included only when it asks for that.
    /// Anything else is a no-op, never an error.
    pub async fn save_document(
        &self,
        id: ServerId,
        root: &Path,
        path: &Path,
    ) -> Result<(), ManagerError> {
        let uri = path_to_uri(path).map_err(ManagerError::Lsp)?;
        let Some((_inst, inner)) = self.lock_current(id, root).await else {
            return Ok(());
        };
        if !inner.ready {
            return Ok(());
        }
        let Some(client) = inner.client.clone() else {
            return Ok(());
        };
        let Some(include_text) = client.wants_did_save() else {
            return Ok(());
        };
        let Some(doc) = inner.docs.get(&uri.to_string()) else {
            return Ok(());
        };
        let text = include_text.then(|| doc.content().to_string());
        client
            .did_save(DidSaveTextDocumentParams {
                text_document: TextDocumentIdentifier { uri },
                text,
            })
            .await
            .map_err(|e| map_err(&client, e))
    }

    /// Current buffered text of a document, if the manager tracks it.
    pub async fn document_text(&self, id: ServerId, root: &Path, path: &Path) -> Option<String> {
        let inst = self.get(id, root).await?;
        let uri = path_to_uri(path).ok()?;
        let inner = inst.inner.lock().await;
        inner
            .docs
            .get(&uri.to_string())
            .map(|d| d.content().to_string())
    }

    /// Capabilities the ready server advertised in `initialize`, if it is ready.
    pub async fn capabilities(
        &self,
        id: ServerId,
        root: &Path,
    ) -> Option<lsp_types::ServerCapabilities> {
        let inst = self.get(id, root).await?;
        let inner = inst.inner.lock().await;
        if !inner.ready {
            return None;
        }
        inner.client.as_ref()?.server_capabilities()
    }

    pub async fn completion(
        &self,
        id: ServerId,
        root: &Path,
        params: CompletionParams,
        cancel: Option<CancellationToken>,
    ) -> Result<Option<CompletionResponse>, ManagerError> {
        let client = self.ready_client(id, root).await?;
        client
            .completion_with_cancel(params, cancel.unwrap_or_default())
            .await
            .map_err(|e| map_err(&client, e))
    }

    pub async fn hover(
        &self,
        id: ServerId,
        root: &Path,
        params: HoverParams,
        cancel: Option<CancellationToken>,
    ) -> Result<Option<Hover>, ManagerError> {
        let client = self.ready_client(id, root).await?;
        client
            .hover_with_cancel(params, cancel.unwrap_or_default())
            .await
            .map_err(|e| map_err(&client, e))
    }

    pub async fn definition(
        &self,
        id: ServerId,
        root: &Path,
        params: GotoDefinitionParams,
        cancel: Option<CancellationToken>,
    ) -> Result<Option<GotoDefinitionResponse>, ManagerError> {
        let client = self.ready_client(id, root).await?;
        client
            .definition_with_cancel(params, cancel.unwrap_or_default())
            .await
            .map_err(|e| map_err(&client, e))
    }

    pub async fn formatting(
        &self,
        id: ServerId,
        root: &Path,
        params: DocumentFormattingParams,
        cancel: Option<CancellationToken>,
    ) -> Result<Option<Vec<TextEdit>>, ManagerError> {
        let client = self.ready_client(id, root).await?;
        client
            .formatting_with_cancel(params, cancel.unwrap_or_default())
            .await
            .map_err(|e| map_err(&client, e))
    }

    pub async fn range_formatting(
        &self,
        id: ServerId,
        root: &Path,
        params: DocumentRangeFormattingParams,
        cancel: Option<CancellationToken>,
    ) -> Result<Option<Vec<TextEdit>>, ManagerError> {
        let client = self.ready_client(id, root).await?;
        client
            .range_formatting_with_cancel(params, cancel.unwrap_or_default())
            .await
            .map_err(|e| map_err(&client, e))
    }

    /// Whether the ready server advertised `typeHierarchyProvider`.
    pub async fn supports_type_hierarchy(&self, id: ServerId, root: &Path) -> bool {
        match self.ready_client(id, root).await {
            Ok(client) => client.supports_type_hierarchy(),
            Err(_) => false,
        }
    }

    /// JDT LS `java/classFileContents` for a `jdt://` URI.
    pub async fn class_file_contents(
        &self,
        id: ServerId,
        root: &Path,
        uri: &str,
        cancel: Option<CancellationToken>,
    ) -> Result<Option<String>, ManagerError> {
        let client = self.ready_client(id, root).await?;
        client
            .class_file_contents(uri, cancel.unwrap_or_default())
            .await
            .map_err(|e| map_err(&client, e))
    }

    manager_nav!(
        references,
        references_with_cancel,
        ReferenceParams,
        Vec<Location>
    );
    manager_nav!(
        implementation,
        implementation_with_cancel,
        GotoDefinitionParams,
        GotoDefinitionResponse
    );
    manager_nav!(
        type_definition,
        type_definition_with_cancel,
        GotoDefinitionParams,
        GotoDefinitionResponse
    );
    manager_nav!(
        declaration,
        declaration_with_cancel,
        GotoDefinitionParams,
        GotoDefinitionResponse
    );
    manager_nav!(
        document_symbols,
        document_symbols_with_cancel,
        DocumentSymbolParams,
        DocumentSymbolResponse
    );
    manager_nav!(
        workspace_symbols,
        workspace_symbols_with_cancel,
        WorkspaceSymbolParams,
        WorkspaceSymbolResponse
    );
    manager_nav!(
        prepare_call_hierarchy,
        prepare_call_hierarchy_with_cancel,
        CallHierarchyPrepareParams,
        Vec<CallHierarchyItem>
    );
    manager_nav!(
        incoming_calls,
        incoming_calls_with_cancel,
        CallHierarchyIncomingCallsParams,
        Vec<CallHierarchyIncomingCall>
    );
    manager_nav!(
        outgoing_calls,
        outgoing_calls_with_cancel,
        CallHierarchyOutgoingCallsParams,
        Vec<CallHierarchyOutgoingCall>
    );
    manager_nav!(
        prepare_type_hierarchy,
        prepare_type_hierarchy_with_cancel,
        TypeHierarchyPrepareParams,
        Vec<TypeHierarchyItem>
    );
    manager_nav!(
        type_supertypes,
        type_supertypes_with_cancel,
        TypeHierarchySupertypesParams,
        Vec<TypeHierarchyItem>
    );
    manager_nav!(
        type_subtypes,
        type_subtypes_with_cancel,
        TypeHierarchySubtypesParams,
        Vec<TypeHierarchyItem>
    );
    manager_nav!(
        document_highlights,
        document_highlights_with_cancel,
        DocumentHighlightParams,
        Vec<DocumentHighlight>
    );
    manager_nav!(
        signature_help,
        signature_help_with_cancel,
        SignatureHelpParams,
        SignatureHelp
    );
    manager_nav!(
        prepare_rename,
        prepare_rename_with_cancel,
        TextDocumentPositionParams,
        PrepareRenameResponse
    );
    manager_nav!(rename, rename_with_cancel, RenameParams, WorkspaceEdit);

    /// Stop one server (graceful, then kill) and forget it, including its buffers.
    pub async fn shutdown(&self, id: ServerId, root: &Path) {
        let inst = self
            .shared
            .instances
            .lock()
            .await
            .remove(&(id, root.to_path_buf()));
        if let Some(inst) = inst {
            self.stop_instance(&inst).await;
        }
    }

    pub async fn shutdown_all(&self) {
        self.shutdown_all_within(None).await;
    }

    /// Stop every server in parallel. With `limit`, servers that have not stopped
    /// politely by then are killed outright, so no child outlives the call.
    pub async fn shutdown_all_within(&self, limit: Option<Duration>) {
        let all: Vec<Arc<Instance>> = self
            .shared
            .instances
            .lock()
            .await
            .drain()
            .map(|(_, i)| i)
            .collect();
        let mut clients = Vec::new();
        for inst in &all {
            if let Some(c) = inst.inner.lock().await.client.clone() {
                clients.push(c);
            }
        }
        // Stop every server at once, so the caller's overall bound covers all of them
        // rather than the sum of the per-server graces.
        let mut set = tokio::task::JoinSet::new();
        for inst in all {
            let this = self.clone();
            set.spawn(async move { this.stop_instance(&inst).await });
        }
        let drain = async { while set.join_next().await.is_some() {} };
        let Some(limit) = limit else {
            drain.await;
            return;
        };
        if tokio::time::timeout(limit, drain).await.is_ok() {
            return;
        }
        set.abort_all();
        let mut kills = tokio::task::JoinSet::new();
        for client in clients {
            kills.spawn(async move { client.terminate().await });
        }
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            while kills.join_next().await.is_some() {}
        })
        .await;
    }

    async fn stop_instance(&self, inst: &Arc<Instance>) {
        inst.stop.cancel();
        let task = inst.task.lock().unwrap().take();
        if let Some(task) = task {
            let _ = task.await;
        }
        let client = {
            let mut inner = inst.inner.lock().await;
            inner.ready = false;
            inner.retired = true;
            inner.client.take()
        };
        if let Some(client) = client {
            let _ = client
                .shutdown_with_timeout(self.shared.config.shutdown_grace)
                .await;
        }
        inst.set_state(ServerState::Stopped);
    }

    /// Lock the current instance for `(id, root)`. If the instance was retired between
    /// the lookup and the lock (replaced by a restart, or shut down), look again, so
    /// the caller always works on the instance that owns the buffers.
    async fn lock_current(
        &self,
        id: ServerId,
        root: &Path,
    ) -> Option<(Arc<Instance>, OwnedMutexGuard<Inner>)> {
        loop {
            let inst = self.get(id, root).await?;
            let guard = inst.inner.clone().lock_owned().await;
            if !guard.retired {
                return Some((inst, guard));
            }
            drop(guard);
            tokio::task::yield_now().await;
        }
    }

    async fn get(&self, id: ServerId, root: &Path) -> Option<Arc<Instance>> {
        self.shared
            .instances
            .lock()
            .await
            .get(&(id, root.to_path_buf()))
            .cloned()
    }

    async fn ready_client(
        &self,
        id: ServerId,
        root: &Path,
    ) -> Result<Arc<LspClient>, ManagerError> {
        let inst = self.get(id, root).await.ok_or(ManagerError::NotStarted)?;
        let inner = inst.inner.lock().await;
        if !inner.ready {
            return Err(match inst.state() {
                ServerState::Crashed => crashed(),
                other => ManagerError::NotReady(other),
            });
        }
        let client = inner.client.clone().ok_or(ManagerError::NotStarted)?;
        if client.is_closed() {
            return Err(crashed());
        }
        Ok(client)
    }
}

async fn open_locked(
    inner: &mut Inner,
    uri: lsp_types::Uri,
    language_id: &str,
    text: String,
) -> Result<i32, ManagerError> {
    let key = uri.to_string();
    if inner.docs.contains_key(&key) {
        let change = TextDocumentContentChangeEvent {
            range: None,
            range_length: None,
            text,
        };
        return change_locked(inner, uri, vec![change]).await;
    }
    let version = inner
        .closed_versions
        .remove(&key)
        .map_or(1, |v| v.saturating_add(1));
    inner.docs.insert(
        key.clone(),
        TrackedDocument::new(key, language_id.to_string(), version, text.clone()),
    );
    if inner.ready {
        if let Some(client) = inner.client.clone() {
            client
                .did_open(DidOpenTextDocumentParams {
                    text_document: TextDocumentItem {
                        uri,
                        language_id: language_id.to_string(),
                        version,
                        text,
                    },
                })
                .await
                .map_err(|e| map_err(&client, e))?;
        }
    }
    Ok(version)
}

async fn change_locked(
    inner: &mut Inner,
    uri: lsp_types::Uri,
    changes: Vec<TextDocumentContentChangeEvent>,
) -> Result<i32, ManagerError> {
    let client = if inner.ready {
        inner.client.clone()
    } else {
        None
    };
    let doc = inner
        .docs
        .get_mut(&uri.to_string())
        .ok_or_else(|| ManagerError::Lsp(LspError::DocumentNotTracked(uri.to_string())))?;
    let version = doc.version + 1;
    doc.apply_changes(changes.clone(), version)
        .map_err(ManagerError::Lsp)?;
    let full_text = doc.content().to_string();

    let Some(client) = client else {
        return Ok(version);
    };
    let content_changes = match client.text_document_sync_kind() {
        Some(TextDocumentSyncKind::FULL) => vec![TextDocumentContentChangeEvent {
            range: None,
            range_length: None,
            text: full_text,
        }],
        Some(_) => changes,
        None => return Ok(version),
    };
    client
        .did_change(DidChangeTextDocumentParams {
            text_document: VersionedTextDocumentIdentifier { uri, version },
            content_changes,
        })
        .await
        .map_err(|e| map_err(&client, e))?;
    Ok(version)
}

fn crashed() -> ManagerError {
    ManagerError::ServerCrashed("process exited".into())
}

fn map_err(client: &LspClient, e: LspError) -> ManagerError {
    match e {
        LspError::Cancelled => ManagerError::Cancelled,
        LspError::Unsupported(s) => ManagerError::Unsupported(s),
        other if client.is_closed() => ManagerError::ServerCrashed(other.to_string()),
        LspError::ProcessExited(m) => ManagerError::ServerCrashed(m),
        other => ManagerError::Lsp(other),
    }
}

async fn run_instance(
    inst: Arc<Instance>,
    spec: ServerSpec,
    initialization_options: serde_json::Value,
    resolver: Arc<dyn ErasedResolver>,
    config: ManagerConfig,
) {
    let launch = tokio::select! {
        _ = inst.stop.cancelled() => return,
        r = resolver.resolve(spec.id, &inst.root) => r,
    };
    let launch = match launch {
        Ok(l) => l,
        Err(e) => return inst.fail(e.to_string()).await,
    };

    let program = launch.program.to_string_lossy().into_owned();
    let client = match LspClient::spawn_with_env(
        &program,
        &launch.args,
        Some(inst.root.clone()),
        &launch.env,
    )
    .await
    {
        Ok(c) => Arc::new(c),
        Err(e) => return inst.fail(format!("spawn failed: {e}")).await,
    };

    // Answer server requests from the start, including those sent during initialize.
    tokio::spawn(pump_events(inst.clone(), client.clone()));

    let options = match &initialization_options {
        serde_json::Value::Null => None,
        v => Some(v.clone()),
    };
    let params = match build_initialize_params(&inst.root, options) {
        Ok(p) => p,
        Err(e) => {
            client.terminate().await;
            return inst.fail(e.to_string()).await;
        }
    };

    let init = tokio::select! {
        _ = inst.stop.cancelled() => {
            client.terminate().await;
            return;
        }
        r = tokio::time::timeout(config.init_timeout, client.initialize(params)) => r,
    };
    match init {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            client.terminate().await;
            return inst.fail(e.to_string()).await;
        }
        Err(_) => {
            client.terminate().await;
            return inst.fail("initialize timed out".into()).await;
        }
    }

    let mut inner = inst.inner.lock().await;
    if inst.stop.is_cancelled() {
        drop(inner);
        client.terminate().await;
        return;
    }
    let mut docs: Vec<&TrackedDocument> = inner.docs.values().collect();
    docs.sort_by(|a, b| a.uri.cmp(&b.uri));
    for doc in docs {
        let Ok(uri) = doc.uri.parse() else { continue };
        let opened = client
            .did_open(DidOpenTextDocumentParams {
                text_document: TextDocumentItem {
                    uri,
                    language_id: doc.language_id.clone(),
                    version: doc.version,
                    text: doc.content().to_string(),
                },
            })
            .await;
        if let Err(e) = opened {
            drop(inner);
            client.terminate().await;
            return inst.fail(format!("didOpen failed: {e}")).await;
        }
    }
    inner.client = Some(client.clone());
    inner.ready = true;
    inst.set_state(ServerState::Ready);
    if client.is_closed() {
        inner.ready = false;
        inner.client = None;
        inst.set_state(ServerState::Crashed);
    }
}

async fn pump_events(inst: Arc<Instance>, client: Arc<LspClient>) {
    while let Some(event) = client.next_event().await {
        match event {
            ServerEvent::Request { id, method, params } => {
                let _ = client
                    .reply_to_server_request(id, &method, params.as_ref())
                    .await;
            }
            ServerEvent::Diagnostics(params) => {
                let _ = inst.events.send(ManagerEvent::Diagnostics {
                    server: inst.id,
                    root: inst.root.clone(),
                    params,
                });
            }
            ServerEvent::Notification { method, params } => {
                if method == "$/progress" {
                    if let Some((token, kind, title, message, percentage)) =
                        params.as_ref().and_then(parse_work_progress)
                    {
                        let _ = inst.events.send(ManagerEvent::Progress {
                            server: inst.id,
                            root: inst.root.clone(),
                            token,
                            kind,
                            title,
                            message,
                            percentage,
                        });
                    }
                }
            }
        }
    }
    if inst.stop.is_cancelled() {
        return;
    }
    let mut inner = inst.inner.lock().await;
    let same = inner
        .client
        .as_ref()
        .map(|c| Arc::ptr_eq(c, &client))
        .unwrap_or(false);
    if inner.ready && same {
        inner.ready = false;
        inner.client = None;
        inst.set_state(ServerState::Crashed);
    }
}
