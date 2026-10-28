//! Language server service: owns the [`Manager`], keeps it in sync with the rope
//! buffers automatically, and answers the `lsp_*` commands.
//!
//! Design notes:
//! - Buffer commands never wait for a language server. The hooks below update a
//!   per-document shadow copy of the text, convert the app's UTF-16 deltas to LSP
//!   changes and push them on an ordered queue; one worker applies the queue to the
//!   [`Manager`]. Failures become [`LanguageServerError`] events.
//! - A server that is not installed is never started and nothing is downloaded until
//!   the user opts in (`languageServers.autoInstall` or `lsp_install`). While gated the
//!   shadow text keeps the document, and it is replayed when the server becomes usable.
//! - Replies are stamped with the buffer revision and server epoch they were computed
//!   against and dropped as [`LspErrorDto::Stale`] if either moved.

mod dto;
mod paths;
mod position;
mod provision;

pub use dto::*;
use provision::{CatalogProvisioner, GatedResolver, InstallFailure, Provisioner, RuntimeIssue};
use serde::Serialize;
use span_core::{BufferRevision, BufferSnapshot, CoreWorkspace, Settings, TextEdit};
use span_lsp::lsp_types::{self as lsp, Uri};
use span_lsp::servers::catalog::{self, ALL_SERVERS};
use span_lsp::servers::install::InstallProgress;
use span_lsp::servers::manager::{
    LaunchResolver, Manager, ManagerConfig, ManagerError, ManagerEvent,
};
use span_lsp::servers::{ServerId, ServerSpec};
use specta::Type;
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::State;
use tauri_specta::Event;
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

/// Documents above this size are not sent to language servers.
const MAX_DOC_BYTES: usize = 4 * 1024 * 1024;
/// How long a request waits for queued edits to reach the server.
const SYNC_WAIT: Duration = Duration::from_secs(5);
/// Upper bound for one queued manager call, so a stuck server cannot stall the queue.
const OP_TIMEOUT: Duration = Duration::from_secs(20);
const VERSION_HISTORY: usize = 64;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerStateChanged {
    pub server: LanguageServerId,
    pub root: String,
    pub state: LanguageServerStateDto,
}

#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerInstallProgress {
    pub server: LanguageServerId,
    pub version: String,
    pub phase: InstallPhase,
    pub received: Option<u64>,
    pub total: Option<u64>,
    pub message: Option<String>,
}

/// `version` is the LSP document version the server reported on; `revision` is the
/// buffer revision that version corresponds to, when known.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsPublished {
    pub path: String,
    pub version: Option<i32>,
    pub revision: Option<u64>,
    pub diagnostics: Vec<DiagnosticDto>,
}

/// A background synchronisation or install failure that no command could return.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerError {
    pub server: LanguageServerId,
    pub path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone)]
pub enum LspEvent {
    State(LanguageServerStateChanged),
    Install(LanguageServerInstallProgress),
    Diagnostics(DiagnosticsPublished),
    Error(LanguageServerError),
}

/// Servers that execute the project's own build code unless restricted.
const PROJECT_CODE_SERVERS: [ServerId; 2] = [ServerId::RustAnalyzer, ServerId::Jdtls];

pub type EventSink = Arc<dyn Fn(LspEvent) + Send + Sync>;

pub fn tauri_sink(app: tauri::AppHandle) -> EventSink {
    Arc::new(move |event| {
        let result = match event {
            LspEvent::State(e) => e.emit(&app),
            LspEvent::Install(e) => e.emit(&app),
            LspEvent::Diagnostics(e) => e.emit(&app),
            LspEvent::Error(e) => e.emit(&app),
        };
        if let Err(error) = result {
            eprintln!("Could not emit language server event: {error}");
        }
    })
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LspSettings {
    pub auto_install: bool,
    pub disabled: HashSet<ServerId>,
    pub java_home: Option<PathBuf>,
    pub node_path: Option<PathBuf>,
    /// Let rust-analyzer and JDT LS run the project's own build code.
    pub run_project_code: bool,
    pub tab_size: u32,
}

impl Default for LspSettings {
    fn default() -> Self {
        Self {
            auto_install: false,
            disabled: HashSet::new(),
            java_home: None,
            node_path: None,
            run_project_code: false,
            tab_size: 2,
        }
    }
}

impl From<&Settings> for LspSettings {
    fn from(settings: &Settings) -> Self {
        let ls = &settings.language_servers;
        Self {
            auto_install: ls.auto_install,
            disabled: ALL_SERVERS
                .iter()
                .copied()
                .filter(|id| !ls.is_enabled(dto::settings_key(*id)))
                .collect(),
            // Defence in depth: core already rejects relative paths and ignores these
            // keys in workspace files; the provisioner must never probe anything else.
            java_home: ls
                .java_home
                .as_ref()
                .map(PathBuf::from)
                .filter(|p| p.is_absolute()),
            node_path: ls
                .node_path
                .as_ref()
                .map(PathBuf::from)
                .filter(|p| p.is_absolute()),
            run_project_code: ls.run_project_code,
            tab_size: settings.tab_size,
        }
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Why a server will not be started for now.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Gate {
    NeedsInstall,
    Installing,
    InstallFailed { reason: String, retryable: bool },
    RuntimeMissing(RuntimeIssue),
}

#[derive(Clone)]
struct DocRef {
    abs: PathBuf,
    server: ServerId,
    root: PathBuf,
    language_id: &'static str,
}

struct Doc {
    r: DocRef,
    text: String,
    revision: u64,
    /// Sequence number of the last queue entry for this document.
    seq: u64,
}

enum Op {
    Open {
        d: DocRef,
        text: String,
        revision: u64,
    },
    Change {
        d: DocRef,
        changes: Vec<lsp::TextDocumentContentChangeEvent>,
        revision: u64,
    },
    Close {
        d: DocRef,
    },
    /// `textDocument/didSave`, when the server asks for it.
    Save {
        d: DocRef,
    },
    Reset {
        keys: Vec<(ServerId, PathBuf)>,
    },
    Stop {
        server: ServerId,
    },
    Resume {
        server: ServerId,
    },
    Restart {
        server: ServerId,
    },
}

struct Queued {
    seq: u64,
    op: Op,
}

#[derive(Default)]
struct Shared {
    root: Option<PathBuf>,
    /// Incremented whenever the workspace changes.
    generation: u64,
    settings: LspSettings,
    docs: HashMap<PathBuf, Doc>,
    next_seq: u64,
    gates: HashMap<ServerId, Gate>,
    installed: HashSet<ServerId>,
    runtime_ok: HashSet<ServerId>,
    epochs: HashMap<ServerId, u64>,
    states: HashMap<(ServerId, PathBuf), LanguageServerStateDto>,
    versions: HashMap<PathBuf, VecDeque<(i32, u64)>>,
    last_error: HashMap<ServerId, String>,
}

pub struct LanguageServers {
    manager: Manager,
    provisioner: Arc<dyn Provisioner>,
    sink: EventSink,
    state: Mutex<Shared>,
    tx: mpsc::UnboundedSender<Queued>,
    processed: watch::Sender<u64>,
    requests: Mutex<HashMap<String, CancellationToken>>,
    request_timeout: Duration,
}

/// Cheap to clone, managed by Tauri.
pub type LspService = Arc<LanguageServers>;

pub struct ServiceConfig {
    pub request_timeout: Duration,
    pub manager: ManagerConfig,
}

impl Default for ServiceConfig {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(15),
            manager: ManagerConfig::default(),
        }
    }
}

/// Production service: catalog resolver under `cache_root`, opt-in installs.
pub fn production(cache_root: PathBuf, sink: EventSink) -> Result<LspService, String> {
    let provisioner = Arc::new(CatalogProvisioner::new(cache_root)?);
    let resolver = Arc::new(GatedResolver::new(provisioner.clone()));
    Ok(LanguageServers::new(
        resolver,
        provisioner,
        sink,
        ServiceConfig::default(),
    ))
}

/// Test seam: the production wiring (catalog resolver, gated installs) with a
/// caller supplied download source, so integration tests can count downloads.
pub fn production_with_fetch(
    cache_root: PathBuf,
    fetch: Arc<dyn span_lsp::servers::install::Fetch>,
    sink: EventSink,
    config: ServiceConfig,
) -> LspService {
    let provisioner = Arc::new(CatalogProvisioner::with_fetch(cache_root, fetch));
    let resolver = Arc::new(GatedResolver::new(provisioner.clone()));
    LanguageServers::new(resolver, provisioner, sink, config)
}

fn lock(m: &Mutex<Shared>) -> MutexGuard<'_, Shared> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn absolute(root: &Path, path: &str) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        paths::normalize_path(p)
    } else {
        paths::join_normalized(root, path)
    }
}

/// Nearest ancestor of `file` (inside `workspace`) holding a root marker.
fn server_root(spec: &ServerSpec, file: &Path, workspace: &Path) -> PathBuf {
    let mut dir = file.parent();
    while let Some(d) = dir {
        if !d.starts_with(workspace) {
            break;
        }
        if spec.root_markers.iter().any(|m| d.join(m).exists()) {
            return d.to_path_buf();
        }
        if d == workspace {
            break;
        }
        dir = d.parent();
    }
    workspace.to_path_buf()
}

impl LanguageServers {
    pub fn new<R: LaunchResolver>(
        resolver: Arc<R>,
        provisioner: Arc<dyn Provisioner>,
        sink: EventSink,
        config: ServiceConfig,
    ) -> LspService {
        let manager = Manager::new(catalog::all_specs(), resolver, config.manager);
        manager.set_options_provider(Arc::new(catalog::initialization_options));
        let (tx, rx) = mpsc::unbounded_channel();
        let service = Arc::new(Self {
            manager,
            provisioner,
            sink,
            state: Mutex::new(Shared::default()),
            tx,
            processed: watch::channel(0).0,
            requests: Mutex::new(HashMap::new()),
            request_timeout: config.request_timeout,
        });
        let mut events = service.manager.subscribe();
        let forwarder = service.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => forwarder.forward(event),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        });
        let worker = service.clone();
        tauri::async_runtime::spawn(async move { worker.run(rx).await });
        service
    }

    fn emit(&self, event: LspEvent) {
        (self.sink)(event);
    }

    fn push(&self, st: &mut Shared, op: Op) -> u64 {
        st.next_seq += 1;
        let seq = st.next_seq;
        let _ = self.tx.send(Queued { seq, op });
        seq
    }

    fn epoch(st: &Shared, server: ServerId) -> u64 {
        st.epochs.get(&server).copied().unwrap_or(0)
    }

    fn bump_epoch(st: &mut Shared, server: ServerId) {
        *st.epochs.entry(server).or_insert(0) += 1;
    }

    fn root_string(st: &Shared) -> String {
        st.root
            .as_ref()
            .map(|r| r.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    // -----------------------------------------------------------------------
    // Buffer lifecycle hooks (synchronous, infallible, never touch a server)
    // -----------------------------------------------------------------------

    /// A workspace was opened (or reopened). Closes everything of the previous one.
    pub fn workspace_changed(&self, root: PathBuf, settings: &Settings) {
        let new = LspSettings::from(settings);
        self.provisioner.configure(&new);
        self.manager.set_run_project_code(new.run_project_code);
        let mut st = lock(&self.state);
        let mut keys: HashSet<(ServerId, PathBuf)> = st.states.keys().cloned().collect();
        keys.extend(st.docs.values().map(|d| (d.r.server, d.r.root.clone())));
        for server in ALL_SERVERS {
            Self::bump_epoch(&mut st, server);
        }
        st.generation += 1;
        st.docs.clear();
        st.versions.clear();
        st.states.clear();
        st.last_error.clear();
        st.installed.clear();
        st.runtime_ok.clear();
        st.gates.retain(|_, g| *g == Gate::Installing);
        st.settings = new;
        st.root = Some(paths::normalize_path(&root));
        self.push(
            &mut st,
            Op::Reset {
                keys: keys.into_iter().collect(),
            },
        );
    }

    /// Apply changed settings: enable or disable servers, switch overrides, and start
    /// pending installs when auto install was just turned on.
    pub fn apply_settings(self: &Arc<Self>, settings: &Settings) {
        let new = LspSettings::from(settings);
        self.provisioner.configure(&new);
        self.manager.set_run_project_code(new.run_project_code);
        let mut pending_install = Vec::new();
        {
            let mut st = lock(&self.state);
            let old = std::mem::replace(&mut st.settings, new.clone());
            if old.node_path != new.node_path || old.java_home != new.java_home {
                st.runtime_ok.clear();
                st.gates
                    .retain(|_, g| !matches!(g, Gate::RuntimeMissing(_)));
            }
            for server in ALL_SERVERS {
                let was = old.disabled.contains(&server);
                let now = new.disabled.contains(&server);
                if now && !was {
                    Self::bump_epoch(&mut st, server);
                    self.push(&mut st, Op::Stop { server });
                } else if was && !now {
                    self.push(&mut st, Op::Resume { server });
                }
            }
            if old.run_project_code != new.run_project_code {
                // Running servers keep the options they were started with, so the two
                // that execute project code are restarted with the new ones.
                for server in PROJECT_CODE_SERVERS {
                    let running = st.states.keys().any(|(s, _)| *s == server)
                        || st.docs.values().any(|d| d.r.server == server);
                    if running && !new.disabled.contains(&server) {
                        Self::bump_epoch(&mut st, server);
                        self.push(&mut st, Op::Restart { server });
                    }
                }
            }
            if new.auto_install && !old.auto_install {
                pending_install = st
                    .gates
                    .iter()
                    .filter(|(s, g)| **g == Gate::NeedsInstall && !new.disabled.contains(*s))
                    .map(|(s, _)| *s)
                    .collect();
            }
        }
        for server in pending_install {
            self.begin_install(server);
        }
    }

    /// Track (or refresh) a document from a buffer snapshot: open, reload after a
    /// save or format, or reconcile after an out of band change. Older snapshots than
    /// the tracked revision are ignored.
    pub fn on_snapshot(&self, snapshot: &BufferSnapshot) {
        self.sync_snapshot(snapshot, false);
    }

    /// The buffer was reloaded from disk: close and reopen the document so the server
    /// starts from the on disk text with a fresh version counter.
    pub fn on_discard(&self, snapshot: &BufferSnapshot) {
        self.sync_snapshot(snapshot, true);
    }

    /// Whether a workspace relative path is a file a language server handles.
    pub fn handles_path(&self, path: &str) -> bool {
        catalog::lookup_path(Path::new(path)).is_some()
    }

    /// The buffer was written to disk: tell the server (`didSave`) if it tracks the
    /// document. Queued, so saving never waits for a server. Call after `on_snapshot`
    /// with the saved snapshot so a formatted save is sent first.
    pub fn on_saved(&self, snapshot: &BufferSnapshot) {
        let mut st = lock(&self.state);
        self.saved_locked(&mut st, snapshot);
    }

    /// The workspace generation. It changes whenever a workspace is opened, so a caller
    /// that awaits something can tell afterwards that the workspace moved underneath it.
    pub fn generation(&self) -> u64 {
        lock(&self.state).generation
    }

    /// `on_snapshot` followed by `on_saved` for a snapshot produced while the workspace
    /// generation was `generation`. Dropped (returns false) when another workspace has
    /// been opened since, so one workspace's text never reaches another's servers.
    pub fn after_save(&self, generation: u64, snapshot: &BufferSnapshot) -> bool {
        let mut st = lock(&self.state);
        if st.generation != generation {
            return false;
        }
        self.sync_locked(&mut st, snapshot, false);
        self.saved_locked(&mut st, snapshot);
        true
    }

    fn saved_locked(&self, st: &mut Shared, snapshot: &BufferSnapshot) {
        let Some(root) = st.root.clone() else { return };
        let abs = paths::join_normalized(&root, &snapshot.path);
        let Some(d) = st.docs.get(&abs).map(|doc| doc.r.clone()) else {
            return;
        };
        self.push(st, Op::Save { d });
    }

    /// A file or folder left its path (deleted, trashed or renamed away): close every
    /// tracked document at or under it and forget its versions. Returns the workspace
    /// relative paths that were closed.
    pub fn on_closed(&self, path: &str) -> Vec<String> {
        let mut st = lock(&self.state);
        let Some(root) = st.root.clone() else {
            return Vec::new();
        };
        let prefix = paths::join_normalized(&root, path);
        let mut gone: Vec<PathBuf> = st
            .docs
            .keys()
            .filter(|abs| abs.starts_with(&prefix))
            .cloned()
            .collect();
        gone.sort();
        let mut closed = Vec::new();
        for abs in gone {
            let Some(doc) = st.docs.remove(&abs) else {
                continue;
            };
            st.versions.remove(&abs);
            self.push(&mut st, Op::Close { d: doc.r });
            closed.push(dto::display_path(&root, &abs));
        }
        closed
    }

    fn sync_snapshot(&self, snapshot: &BufferSnapshot, reopen: bool) {
        let mut st = lock(&self.state);
        self.sync_locked(&mut st, snapshot, reopen);
    }

    fn sync_locked(&self, st: &mut Shared, snapshot: &BufferSnapshot, reopen: bool) {
        let Some(workspace) = st.root.clone() else {
            return;
        };
        let abs = paths::join_normalized(&workspace, &snapshot.path);
        let Some((server, language_id)) = catalog::lookup_path(&abs) else {
            return;
        };
        if let Some(doc) = st.docs.get(&abs) {
            if snapshot.revision <= doc.revision && !reopen {
                return;
            }
        } else if snapshot.text.len() > MAX_DOC_BYTES {
            return;
        }
        let r = match st.docs.get(&abs) {
            Some(doc) => doc.r.clone(),
            None => DocRef {
                root: server_root(&catalog::spec(server), &abs, &workspace),
                abs: abs.clone(),
                server,
                language_id,
            },
        };
        let known = st.docs.contains_key(&abs);
        if reopen && known {
            st.versions.remove(&abs);
            let seq = self.push(st, Op::Close { d: r.clone() });
            if let Some(doc) = st.docs.get_mut(&abs) {
                doc.seq = seq;
            }
        }
        let seq = self.push(
            st,
            Op::Open {
                d: r.clone(),
                text: snapshot.text.clone(),
                revision: snapshot.revision,
            },
        );
        st.docs.insert(
            abs,
            Doc {
                r,
                text: snapshot.text.clone(),
                revision: snapshot.revision,
                seq,
            },
        );
    }

    /// `CoreWorkspace::edit_buffer_delta` plus automatic language server sync. The sync
    /// part cannot fail the edit.
    pub fn edit_buffer_delta(
        &self,
        workspace: &mut CoreWorkspace,
        path: &str,
        expected_revision: u64,
        changes: Vec<TextEdit>,
    ) -> span_core::Result<BufferRevision> {
        let result = workspace.edit_buffer_delta(path, expected_revision, changes.clone())?;
        if result.revision != expected_revision {
            self.after_edit(workspace, expected_revision, &result, &changes);
        }
        Ok(result)
    }

    fn after_edit(
        &self,
        workspace: &CoreWorkspace,
        expected_revision: u64,
        result: &BufferRevision,
        edits: &[TextEdit],
    ) {
        let mut st = lock(&self.state);
        let Some(root) = st.root.clone() else { return };
        let abs = paths::join_normalized(&root, &result.path);
        let (r, converted) = {
            let Some(doc) = st.docs.get_mut(&abs) else {
                return;
            };
            let converted = if doc.revision == expected_revision {
                position::convert_edits(&doc.text, edits).ok()
            } else {
                None
            };
            // Move the new text into the shadow copy; only the changes go to the queue.
            let changes = converted.map(|converted| {
                doc.text = converted.text;
                doc.revision = result.revision;
                converted.changes
            });
            (doc.r.clone(), changes)
        };
        let op = match converted {
            Some(changes) => Op::Change {
                d: r,
                changes,
                revision: result.revision,
            },
            None => {
                // Shadow out of step (or an offset the converter rejects): resend all.
                let Ok(snapshot) = workspace.buffer_snapshot(&result.path) else {
                    return;
                };
                if let Some(doc) = st.docs.get_mut(&abs) {
                    doc.text = snapshot.text.clone();
                    doc.revision = snapshot.revision;
                }
                Op::Open {
                    d: r,
                    text: snapshot.text,
                    revision: snapshot.revision,
                }
            }
        };
        let seq = self.push(&mut st, op);
        if let Some(doc) = st.docs.get_mut(&abs) {
            doc.seq = seq;
        }
    }

    // -----------------------------------------------------------------------
    // Worker
    // -----------------------------------------------------------------------

    async fn run(self: Arc<Self>, mut rx: mpsc::UnboundedReceiver<Queued>) {
        // Per document: queue entries up to this sequence number are already contained
        // in a full resend and must be skipped.
        let mut synced: HashMap<PathBuf, u64> = HashMap::new();
        while let Some(queued) = rx.recv().await {
            let seq = queued.seq;
            let server = match &queued.op {
                Op::Open { d, .. } | Op::Change { d, .. } | Op::Close { d } | Op::Save { d } => {
                    Some(d.server)
                }
                Op::Stop { server } | Op::Resume { server } | Op::Restart { server } => {
                    Some(*server)
                }
                Op::Reset { .. } => None,
            };
            if tokio::time::timeout(OP_TIMEOUT, self.handle(queued, &mut synced))
                .await
                .is_err()
            {
                if let Some(server) = server {
                    self.report(server, None, "a language server operation timed out".into());
                }
            }
            self.processed.send_replace(seq);
        }
    }

    fn skip(synced: &HashMap<PathBuf, u64>, d: &DocRef, seq: u64) -> bool {
        synced.get(&d.abs).is_some_and(|s| seq <= *s)
    }

    async fn handle(self: &Arc<Self>, queued: Queued, synced: &mut HashMap<PathBuf, u64>) {
        let seq = queued.seq;
        match queued.op {
            Op::Open { d, text, revision } => {
                if Self::skip(synced, &d, seq) || !self.admit(d.server).await {
                    return;
                }
                self.open(&d, text, revision).await;
            }
            Op::Change {
                d,
                changes,
                revision,
            } => {
                if Self::skip(synced, &d, seq) || !self.admit(d.server).await {
                    return;
                }
                match self
                    .manager
                    .change_document(d.server, &d.root, &d.abs, changes)
                    .await
                {
                    Ok(version) => self.record(&d.abs, version, revision),
                    Err(_) => self.resync(&d, synced).await,
                }
            }
            Op::Close { d } => {
                if Self::skip(synced, &d, seq) {
                    return;
                }
                let _ = self.manager.close_document(d.server, &d.root, &d.abs).await;
                lock(&self.state).versions.remove(&d.abs);
            }
            Op::Save { d } => {
                // A notification only: failures here are not worth a visible error, the
                // next edit resynchronises the document anyway.
                let _ = self.manager.save_document(d.server, &d.root, &d.abs).await;
            }
            Op::Reset { keys } => {
                for (server, root) in keys {
                    self.manager.shutdown(server, &root).await;
                }
                synced.clear();
            }
            Op::Stop { server } => self.stop(server).await,
            Op::Resume { server } => self.resume(server, synced).await,
            Op::Restart { server } => {
                self.stop(server).await;
                self.resume(server, synced).await;
            }
        }
    }

    async fn open(&self, d: &DocRef, text: String, revision: u64) {
        match self
            .manager
            .open_document(d.server, &d.root, &d.abs, d.language_id, text)
            .await
        {
            Ok(version) => self.record(&d.abs, version, revision),
            // Not ready: the text stays buffered and the state event says why.
            Err(ManagerError::NotReady(_)) => {}
            Err(error) => self.report(d.server, Some(&d.abs), error.to_string()),
        }
    }

    /// Resend the whole current text of a document the server fell out of step on.
    async fn resync(&self, d: &DocRef, synced: &mut HashMap<PathBuf, u64>) {
        let current = lock(&self.state)
            .docs
            .get(&d.abs)
            .map(|doc| (doc.text.clone(), doc.revision, doc.seq));
        let Some((text, revision, seq)) = current else {
            return;
        };
        match self
            .manager
            .open_document(d.server, &d.root, &d.abs, d.language_id, text)
            .await
        {
            Ok(version) => {
                self.record(&d.abs, version, revision);
                synced.insert(d.abs.clone(), seq);
            }
            Err(ManagerError::NotReady(_)) => {
                synced.insert(d.abs.clone(), seq);
            }
            Err(error) => self.report(d.server, Some(&d.abs), error.to_string()),
        }
    }

    async fn stop(&self, server: ServerId) {
        let roots: Vec<PathBuf> = {
            let mut st = lock(&self.state);
            let roots = st
                .states
                .keys()
                .filter(|(s, _)| *s == server)
                .map(|(_, r)| r.clone())
                .collect();
            st.states.retain(|(s, _), _| *s != server);
            roots
        };
        for root in roots {
            self.manager.shutdown(server, &root).await;
        }
    }

    async fn resume(self: &Arc<Self>, server: ServerId, synced: &mut HashMap<PathBuf, u64>) {
        if !self.admit(server).await {
            return;
        }
        let mut docs: Vec<(DocRef, String, u64, u64)> = lock(&self.state)
            .docs
            .values()
            .filter(|d| d.r.server == server)
            .map(|d| (d.r.clone(), d.text.clone(), d.revision, d.seq))
            .collect();
        docs.sort_by(|a, b| a.0.abs.cmp(&b.0.abs));
        for (d, text, revision, seq) in docs {
            self.open(&d, text, revision).await;
            synced.insert(d.abs.clone(), seq);
        }
    }

    fn record(&self, abs: &Path, version: i32, revision: u64) {
        let mut st = lock(&self.state);
        let history = st.versions.entry(abs.to_path_buf()).or_default();
        history.push_back((version, revision));
        while history.len() > VERSION_HISTORY {
            history.pop_front();
        }
    }

    /// Surface a failure as an event, once per distinct message per server.
    fn report(&self, server: ServerId, path: Option<&Path>, message: String) {
        let display = {
            let mut st = lock(&self.state);
            if st.last_error.get(&server) == Some(&message) {
                return;
            }
            st.last_error.insert(server, message.clone());
            path.map(|p| match &st.root {
                Some(root) => dto::display_path(root, p),
                None => p.to_string_lossy().into_owned(),
            })
        };
        self.emit(LspEvent::Error(LanguageServerError {
            server: server.into(),
            path: display,
            message,
        }));
    }

    // -----------------------------------------------------------------------
    // Gating: nothing starts, and nothing downloads, unless allowed
    // -----------------------------------------------------------------------

    fn gate_state(&self, gate: &Gate, server: ServerId) -> LanguageServerStateDto {
        match gate {
            Gate::NeedsInstall => LanguageServerStateDto::NeedsInstall {
                version: self.provisioner.version(server),
                size_hint: self.provisioner.size_hint(server),
            },
            Gate::Installing => LanguageServerStateDto::Installing,
            Gate::InstallFailed { reason, retryable } => LanguageServerStateDto::InstallFailed {
                reason: reason.clone(),
                retryable: *retryable,
            },
            Gate::RuntimeMissing(issue) => LanguageServerStateDto::RuntimeMissing {
                runtime: issue.runtime.clone(),
                required_version: issue.required,
                found: issue.found.clone(),
            },
        }
    }

    fn gate_error(&self, gate: &Gate, server: ServerId) -> LspErrorDto {
        match gate {
            Gate::NeedsInstall => LspErrorDto::NeedsInstall {
                server: server.into(),
                version: self.provisioner.version(server),
                size_hint: self.provisioner.size_hint(server),
            },
            Gate::Installing => LspErrorDto::NotReady {
                message: "language server is being installed".into(),
            },
            Gate::InstallFailed { reason, retryable } => LspErrorDto::InstallFailed {
                server: server.into(),
                reason: reason.clone(),
                retryable: *retryable,
            },
            Gate::RuntimeMissing(issue) => LspErrorDto::RuntimeMissing {
                server: server.into(),
                runtime: issue.runtime.clone(),
                required_version: issue.required,
                found: issue.found.clone(),
            },
        }
    }

    fn set_gate(&self, server: ServerId, gate: Gate) {
        let (root, state) = {
            let mut st = lock(&self.state);
            st.gates.insert(server, gate.clone());
            (Self::root_string(&st), self.gate_state(&gate, server))
        };
        self.emit(LspEvent::State(LanguageServerStateChanged {
            server: server.into(),
            root,
            state,
        }));
    }

    /// May the manager be asked to start this server now?
    async fn admit(self: &Arc<Self>, server: ServerId) -> bool {
        let (disabled, gated, installed, runtime_ok, auto) = {
            let st = lock(&self.state);
            (
                st.settings.disabled.contains(&server),
                st.gates.contains_key(&server),
                st.installed.contains(&server),
                st.runtime_ok.contains(&server),
                st.settings.auto_install,
            )
        };
        if disabled || gated {
            return false;
        }
        // The runtime first: a download that could never run is not offered.
        if !runtime_ok {
            match self.provisioner.check_runtime(server).await {
                Ok(()) => {
                    lock(&self.state).runtime_ok.insert(server);
                }
                Err(issue) => {
                    self.set_gate(server, Gate::RuntimeMissing(issue));
                    return false;
                }
            }
        }
        if !installed {
            if self.provisioner.is_installed(server).await {
                lock(&self.state).installed.insert(server);
            } else {
                if auto {
                    self.begin_install(server);
                } else {
                    self.set_gate(server, Gate::NeedsInstall);
                }
                return false;
            }
        }
        true
    }

    /// Start installing in the background (idempotent while one is running).
    fn begin_install(self: &Arc<Self>, server: ServerId) {
        {
            let st = lock(&self.state);
            if st.gates.get(&server) == Some(&Gate::Installing) {
                return;
            }
        }
        self.set_gate(server, Gate::Installing);
        let this = self.clone();
        tauri::async_runtime::spawn(async move { this.install_task(server).await });
    }

    async fn install_task(self: Arc<Self>, server: ServerId) {
        if let Err(issue) = self.provisioner.check_runtime(server).await {
            self.set_gate(server, Gate::RuntimeMissing(issue));
            return;
        }
        let version = self.provisioner.version(server);
        let (tx, mut rx) = mpsc::channel(256);
        let forwarder = {
            let this = self.clone();
            let version = version.clone();
            tauri::async_runtime::spawn(async move {
                let mut last = Instant::now() - Duration::from_secs(1);
                while let Some(progress) = rx.recv().await {
                    if let Some(event) = Self::progress_event(server, &version, progress) {
                        let chunk = event.phase == InstallPhase::Downloading;
                        let done = event.received.is_some() && event.received == event.total;
                        if chunk && !done && last.elapsed() < Duration::from_millis(100) {
                            continue;
                        }
                        last = Instant::now();
                        this.emit(LspEvent::Install(event));
                    }
                }
            })
        };
        let result = self.provisioner.install(server, tx).await;
        let _ = forwarder.await;
        match result {
            Ok(()) => {
                {
                    let mut st = lock(&self.state);
                    st.gates.remove(&server);
                    st.installed.insert(server);
                    st.last_error.remove(&server);
                    self.push(&mut st, Op::Resume { server });
                }
                self.emit(LspEvent::Install(Self::phase_event(
                    server,
                    &version,
                    InstallPhase::Finished,
                    None,
                )));
            }
            Err(InstallFailure { reason, retryable }) => {
                self.emit(LspEvent::Install(Self::phase_event(
                    server,
                    &version,
                    InstallPhase::Failed,
                    Some(reason.clone()),
                )));
                self.report(server, None, format!("install failed: {reason}"));
                self.set_gate(server, Gate::InstallFailed { reason, retryable });
            }
        }
    }

    fn phase_event(
        server: ServerId,
        version: &str,
        phase: InstallPhase,
        message: Option<String>,
    ) -> LanguageServerInstallProgress {
        LanguageServerInstallProgress {
            server: server.into(),
            version: version.to_owned(),
            phase,
            received: None,
            total: None,
            message,
        }
    }

    fn progress_event(
        server: ServerId,
        version: &str,
        progress: InstallProgress,
    ) -> Option<LanguageServerInstallProgress> {
        let event = |phase| Self::phase_event(server, version, phase, None);
        Some(match progress {
            InstallProgress::Started { .. } => event(InstallPhase::Started),
            InstallProgress::AlreadyInstalled { .. } => event(InstallPhase::AlreadyInstalled),
            InstallProgress::WaitingForLock => event(InstallPhase::WaitingForLock),
            InstallProgress::Downloading {
                received, total, ..
            } => {
                let mut e = event(InstallPhase::Downloading);
                e.received = Some(received);
                e.total = total;
                e
            }
            InstallProgress::Reused { .. } => event(InstallPhase::Reused),
            InstallProgress::Verifying { .. } => event(InstallPhase::Verifying),
            InstallProgress::Extracting { .. } => event(InstallPhase::Extracting),
            InstallProgress::Finalizing => event(InstallPhase::Finalizing),
            // Finished is emitted by the task once the server is usable.
            InstallProgress::Finished { .. } | InstallProgress::Pruned { .. } => return None,
        })
    }

    // -----------------------------------------------------------------------
    // Manager events
    // -----------------------------------------------------------------------

    fn forward(&self, event: ManagerEvent) {
        match event {
            ManagerEvent::StateChanged {
                server,
                root,
                state,
            } => {
                let dto = LanguageServerStateDto::from(&state);
                {
                    let mut st = lock(&self.state);
                    // A server stopped by a workspace change reports `Stopped` after the
                    // reset already forgot its root; that late event must not bring the
                    // old root back into the status list.
                    if dto == LanguageServerStateDto::Stopped
                        && !st.states.contains_key(&(server, root.clone()))
                    {
                        return;
                    }
                    st.states.insert((server, root.clone()), dto.clone());
                    if dto == LanguageServerStateDto::Ready {
                        st.last_error.remove(&server);
                    }
                }
                self.emit(LspEvent::State(LanguageServerStateChanged {
                    server: server.into(),
                    root: root.to_string_lossy().into_owned(),
                    state: dto,
                }));
            }
            ManagerEvent::Diagnostics { params, .. } => {
                let Ok(url) = tauri::Url::parse(params.uri.as_str()) else {
                    return;
                };
                let Ok(abs) = url.to_file_path() else { return };
                let abs = paths::normalize_path(&abs);
                let (path, revision) = {
                    let st = lock(&self.state);
                    if !st.docs.contains_key(&abs) {
                        return;
                    }
                    let revision = params.version.and_then(|v| {
                        st.versions
                            .get(&abs)?
                            .iter()
                            .rev()
                            .find(|(version, _)| *version == v)
                            .map(|(_, rev)| *rev)
                    });
                    let path = match &st.root {
                        Some(root) => dto::display_path(root, &abs),
                        None => abs.to_string_lossy().into_owned(),
                    };
                    (path, revision)
                };
                self.emit(LspEvent::Diagnostics(DiagnosticsPublished {
                    path,
                    version: params.version,
                    revision,
                    diagnostics: params
                        .diagnostics
                        .into_iter()
                        .map(dto::map_diagnostic)
                        .collect(),
                }));
            }
        }
    }

    // -----------------------------------------------------------------------
    // Requests
    // -----------------------------------------------------------------------

    fn begin_request(self: &Arc<Self>, id: Option<String>) -> Result<RequestGuard, LspErrorDto> {
        let token = CancellationToken::new();
        if let Some(id) = &id {
            let mut requests = self.requests.lock().unwrap_or_else(|e| e.into_inner());
            if requests.contains_key(id) {
                return Err(LspErrorDto::other("request id is already active"));
            }
            requests.insert(id.clone(), token.clone());
        }
        Ok(RequestGuard {
            service: self.clone(),
            id,
            token,
        })
    }

    pub fn cancel(&self, request_id: &str) {
        if let Some(token) = self
            .requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(request_id)
        {
            token.cancel();
        }
    }

    /// Wait until every queue entry pushed so far has been applied.
    #[cfg(test)]
    pub async fn flush(&self) {
        let target = lock(&self.state).next_seq;
        let mut rx = self.processed.subscribe();
        let _ = rx.wait_for(|done| *done >= target).await;
    }

    async fn wait_processed(
        &self,
        target: u64,
        token: &CancellationToken,
    ) -> Result<(), LspErrorDto> {
        let mut rx = self.processed.subscribe();
        tokio::select! {
            _ = token.cancelled() => Err(LspErrorDto::Cancelled),
            r = tokio::time::timeout(SYNC_WAIT, rx.wait_for(|done| *done >= target)) => match r {
                Ok(_) => Ok(()),
                Err(_) => Err(LspErrorDto::NotReady {
                    message: "language server is still catching up with your edits".into(),
                }),
            },
        }
    }

    fn check_target(&self, path: &str) -> Result<Prepared, LspErrorDto> {
        let st = lock(&self.state);
        let root = st
            .root
            .clone()
            .ok_or_else(|| LspErrorDto::other("open a folder first"))?;
        let abs = absolute(&root, path);
        let Some(doc) = st.docs.get(&abs) else {
            return Err(if catalog::lookup_path(&abs).is_none() {
                LspErrorDto::Unsupported {
                    message: "no language server handles this file type".into(),
                }
            } else {
                LspErrorDto::NotReady {
                    message: "the document is not open".into(),
                }
            });
        };
        let server = doc.r.server;
        if st.settings.disabled.contains(&server) {
            return Err(LspErrorDto::Unsupported {
                message: "this language server is disabled in settings".into(),
            });
        }
        if let Some(gate) = st.gates.get(&server) {
            return Err(self.gate_error(gate, server));
        }
        Ok(Prepared {
            server,
            root: doc.r.root.clone(),
            workspace: root,
            abs,
            revision: doc.revision,
            epoch: Self::epoch(&st, server),
            generation: st.generation,
            tab_size: st.settings.tab_size,
            seq: st.next_seq,
        })
    }

    async fn prepare(
        &self,
        path: &str,
        token: &CancellationToken,
    ) -> Result<Prepared, LspErrorDto> {
        let prepared = self.check_target(path)?;
        self.wait_processed(prepared.seq, token).await?;
        // The queued open may have just discovered the server cannot start.
        let again = self.check_target(path)?;
        if again.revision != prepared.revision || again.generation != prepared.generation {
            return Err(LspErrorDto::Stale);
        }
        Ok(again)
    }

    /// Reply guard: drop the data if anything it depends on moved.
    fn finish<T>(
        &self,
        p: &Prepared,
        token: &CancellationToken,
        data: T,
    ) -> Result<LspResponse<T>, LspErrorDto> {
        if token.is_cancelled() {
            return Err(LspErrorDto::Cancelled);
        }
        let st = lock(&self.state);
        let current = st.docs.get(&p.abs).map(|d| d.revision);
        if st.generation != p.generation
            || current != Some(p.revision)
            || Self::epoch(&st, p.server) != p.epoch
        {
            return Err(LspErrorDto::Stale);
        }
        Ok(LspResponse {
            revision: p.revision,
            epoch: p.epoch,
            data,
        })
    }

    async fn request<T, F, Fut>(
        self: &Arc<Self>,
        path: &str,
        request_id: Option<String>,
        call: F,
    ) -> Result<LspResponse<T>, LspErrorDto>
    where
        F: FnOnce(Call) -> Fut,
        Fut: Future<Output = Result<T, ManagerError>>,
    {
        let guard = self.begin_request(request_id)?;
        let p = self.prepare(path, &guard.token).await?;
        let uri = span_lsp::path_to_uri(&p.abs).map_err(|e| LspErrorDto::other(e.to_string()))?;
        let call = call(Call {
            manager: self.manager.clone(),
            server: p.server,
            root: p.root.clone(),
            uri,
            token: guard.token.clone(),
            tab_size: p.tab_size,
            workspace: p.workspace.clone(),
        });
        let outcome = tokio::select! {
            _ = guard.token.cancelled() => return Err(LspErrorDto::Cancelled),
            r = tokio::time::timeout(self.request_timeout, call) => r,
        };
        let data = match outcome {
            Ok(result) => result.map_err(LspErrorDto::from)?,
            Err(_) => {
                guard.token.cancel();
                return Err(LspErrorDto::NotReady {
                    message: "the language server did not answer in time".into(),
                });
            }
        };
        self.finish(&p, &guard.token, data)
    }

    pub async fn completion(
        self: &Arc<Self>,
        path: &str,
        position: PositionDto,
        trigger_character: Option<String>,
        request_id: Option<String>,
    ) -> Result<LspResponse<CompletionListDto>, LspErrorDto> {
        self.request(path, request_id, |c| async move {
            let context = Some(lsp::CompletionContext {
                trigger_kind: if trigger_character.is_some() {
                    lsp::CompletionTriggerKind::TRIGGER_CHARACTER
                } else {
                    lsp::CompletionTriggerKind::INVOKED
                },
                trigger_character,
            });
            let params = lsp::CompletionParams {
                text_document_position: lsp::TextDocumentPositionParams::new(
                    lsp::TextDocumentIdentifier::new(c.uri),
                    position.into(),
                ),
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
                context,
            };
            let r = c
                .manager
                .completion(c.server, &c.root, params, Some(c.token))
                .await?;
            Ok(dto::map_completion(r))
        })
        .await
    }

    pub async fn hover(
        self: &Arc<Self>,
        path: &str,
        position: PositionDto,
        request_id: Option<String>,
    ) -> Result<LspResponse<Option<HoverDto>>, LspErrorDto> {
        self.request(path, request_id, |c| async move {
            let params = lsp::HoverParams {
                text_document_position_params: lsp::TextDocumentPositionParams::new(
                    lsp::TextDocumentIdentifier::new(c.uri),
                    position.into(),
                ),
                work_done_progress_params: Default::default(),
            };
            let r = c
                .manager
                .hover(c.server, &c.root, params, Some(c.token))
                .await?;
            Ok(dto::map_hover(r))
        })
        .await
    }

    pub async fn definition(
        self: &Arc<Self>,
        path: &str,
        position: PositionDto,
        request_id: Option<String>,
    ) -> Result<LspResponse<Vec<LocationDto>>, LspErrorDto> {
        self.request(path, request_id, |c| async move {
            let params = lsp::GotoDefinitionParams {
                text_document_position_params: lsp::TextDocumentPositionParams::new(
                    lsp::TextDocumentIdentifier::new(c.uri),
                    position.into(),
                ),
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
            };
            let r = c
                .manager
                .definition(c.server, &c.root, params, Some(c.token))
                .await?;
            Ok(dto::map_definition(&c.workspace, r))
        })
        .await
    }

    /// Format edits for the UI to apply. Never changes the buffer and never touches
    /// saving: a failing or slow server only yields a typed error here.
    pub async fn format(
        self: &Arc<Self>,
        path: &str,
        range: Option<RangeDto>,
        request_id: Option<String>,
    ) -> Result<LspResponse<Vec<TextEditDto>>, LspErrorDto> {
        self.request(path, request_id, |c| async move {
            let options = lsp::FormattingOptions {
                tab_size: c.tab_size,
                insert_spaces: true,
                ..Default::default()
            };
            let document = lsp::TextDocumentIdentifier::new(c.uri);
            let edits = match range {
                None => {
                    let params = lsp::DocumentFormattingParams {
                        text_document: document,
                        options,
                        work_done_progress_params: Default::default(),
                    };
                    c.manager
                        .formatting(c.server, &c.root, params, Some(c.token))
                        .await?
                }
                Some(range) => {
                    let params = lsp::DocumentRangeFormattingParams {
                        text_document: document,
                        range: range.into(),
                        options,
                        work_done_progress_params: Default::default(),
                    };
                    c.manager
                        .range_formatting(c.server, &c.root, params, Some(c.token))
                        .await?
                }
            };
            Ok(dto::map_edits(edits))
        })
        .await
    }

    // -----------------------------------------------------------------------
    // Install, restart, status
    // -----------------------------------------------------------------------

    /// Opt in to installing a server. Returns once the install is started (or the
    /// server turned out to be installed); progress arrives as events.
    pub async fn install(self: &Arc<Self>, server: ServerId) -> Result<(), LspErrorDto> {
        if lock(&self.state).settings.disabled.contains(&server) {
            return Err(LspErrorDto::other(
                "this language server is disabled in settings",
            ));
        }
        if self.provisioner.is_installed(server).await {
            let mut st = lock(&self.state);
            st.installed.insert(server);
            if st.gates.remove(&server).is_some() {
                self.push(&mut st, Op::Resume { server });
            }
            return Ok(());
        }
        self.begin_install(server);
        Ok(())
    }

    /// Stop and start a server again with the buffered text of its documents. Also the
    /// retry path after a start failure or a fixed runtime. Bumps the server epoch.
    pub async fn restart(self: &Arc<Self>, server: ServerId) -> Result<(), LspErrorDto> {
        let seq = {
            let mut st = lock(&self.state);
            if st.settings.disabled.contains(&server) {
                return Err(LspErrorDto::other(
                    "this language server is disabled in settings",
                ));
            }
            Self::bump_epoch(&mut st, server);
            st.installed.remove(&server);
            st.runtime_ok.remove(&server);
            st.last_error.remove(&server);
            if st.gates.get(&server) != Some(&Gate::Installing) {
                st.gates.remove(&server);
            }
            self.push(&mut st, Op::Restart { server })
        };
        let mut rx = self.processed.subscribe();
        let _ = tokio::time::timeout(Duration::from_secs(30), rx.wait_for(|d| *d >= seq)).await;
        let st = lock(&self.state);
        match st.gates.get(&server) {
            Some(gate) => Err(self.gate_error(gate, server)),
            None => Ok(()),
        }
    }

    pub async fn status(self: &Arc<Self>) -> Vec<ServerStatusDto> {
        let (settings, gates, states, epochs) = {
            let st = lock(&self.state);
            (
                st.settings.clone(),
                st.gates.clone(),
                st.states.clone(),
                st.epochs.clone(),
            )
        };
        let mut rows = Vec::new();
        for server in ALL_SERVERS {
            let enabled = !settings.disabled.contains(&server);
            let installed = self.provisioner.is_installed(server).await;
            let epoch = epochs.get(&server).copied().unwrap_or(0);
            let gate = gates.get(&server).map(|g| self.gate_state(g, server));
            let mut roots: Vec<(&PathBuf, &LanguageServerStateDto)> = states
                .iter()
                .filter(|((s, _), _)| *s == server)
                .map(|((_, r), v)| (r, v))
                .collect();
            roots.sort_by(|a, b| a.0.cmp(b.0));
            let push = |root: Option<&PathBuf>, state: Option<&LanguageServerStateDto>| {
                let state = if !enabled {
                    LanguageServerStateDto::Disabled
                } else if let Some(gate) = &gate {
                    gate.clone()
                } else {
                    state.cloned().unwrap_or(LanguageServerStateDto::NotStarted)
                };
                (root.cloned(), state)
            };
            let mut entries = Vec::new();
            if roots.is_empty() {
                entries.push(push(None, None));
            }
            for (root, state) in roots {
                entries.push(push(Some(root), Some(state)));
            }
            for (root, state) in entries {
                let capabilities = match (&root, &state) {
                    (Some(root), LanguageServerStateDto::Ready) => self
                        .manager
                        .capabilities(server, root)
                        .await
                        .map(|c| CapabilitiesDto::from(&c)),
                    _ => None,
                };
                rows.push(ServerStatusDto {
                    server: server.into(),
                    root: root.map(|r| r.to_string_lossy().into_owned()),
                    state,
                    installed,
                    enabled,
                    version: self.provisioner.version(server),
                    epoch,
                    capabilities,
                });
            }
        }
        rows
    }

    /// App exit: stop every server, bounded so quitting can never hang.
    pub fn shutdown_blocking(self: &Arc<Self>, limit: Duration) {
        let manager = self.manager.clone();
        // The runtime must exist before any timer is created, so everything that
        // uses a timeout lives inside the future handed to block_on.
        tauri::async_runtime::block_on(async move {
            manager.shutdown_all_within(Some(limit)).await;
        });
    }
}

struct Prepared {
    server: ServerId,
    root: PathBuf,
    workspace: PathBuf,
    abs: PathBuf,
    revision: u64,
    epoch: u64,
    generation: u64,
    tab_size: u32,
    seq: u64,
}

pub struct Call {
    manager: Manager,
    server: ServerId,
    root: PathBuf,
    uri: Uri,
    token: CancellationToken,
    tab_size: u32,
    workspace: PathBuf,
}

struct RequestGuard {
    service: Arc<LanguageServers>,
    id: Option<String>,
    token: CancellationToken,
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        if let Some(id) = &self.id {
            self.service
                .requests
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(id);
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn lsp_completion(
    lsp: State<'_, LspService>,
    path: String,
    position: PositionDto,
    trigger_character: Option<String>,
    request_id: Option<String>,
) -> Result<LspResponse<CompletionListDto>, LspErrorDto> {
    lsp.inner()
        .clone()
        .completion(&path, position, trigger_character, request_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_hover(
    lsp: State<'_, LspService>,
    path: String,
    position: PositionDto,
    request_id: Option<String>,
) -> Result<LspResponse<Option<HoverDto>>, LspErrorDto> {
    lsp.inner().clone().hover(&path, position, request_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_definition(
    lsp: State<'_, LspService>,
    path: String,
    position: PositionDto,
    request_id: Option<String>,
) -> Result<LspResponse<Vec<LocationDto>>, LspErrorDto> {
    lsp.inner()
        .clone()
        .definition(&path, position, request_id)
        .await
}

/// Returns edits in UTF-16 positions of the document at the stamped `revision`. The
/// buffer is not changed; apply the edits in the editor, then it syncs as usual.
#[tauri::command]
#[specta::specta]
pub async fn lsp_format(
    lsp: State<'_, LspService>,
    path: String,
    range: Option<RangeDto>,
    request_id: Option<String>,
) -> Result<LspResponse<Vec<TextEditDto>>, LspErrorDto> {
    lsp.inner().clone().format(&path, range, request_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_cancel(lsp: State<'_, LspService>, request_id: String) -> Result<(), String> {
    lsp.cancel(&request_id);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_install(
    lsp: State<'_, LspService>,
    server: LanguageServerId,
) -> Result<(), LspErrorDto> {
    lsp.inner().clone().install(server.into()).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_restart(
    lsp: State<'_, LspService>,
    server: LanguageServerId,
) -> Result<(), LspErrorDto> {
    lsp.inner().clone().restart(server.into()).await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_status(lsp: State<'_, LspService>) -> Result<Vec<ServerStatusDto>, String> {
    Ok(lsp.inner().clone().status().await)
}

#[cfg(test)]
mod tests;
