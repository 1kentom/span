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
mod intel;
mod nav_service;
mod navigation;
mod paths;
mod position;
mod provision;
mod trust;

pub use dto::*;
pub use intel::*;
pub use navigation::*;
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
pub use trust::*;

/// Documents above this size are not sent to language servers.
const MAX_DOC_BYTES: usize = 4 * 1024 * 1024;
/// How long a request waits for queued edits to reach the server.
const SYNC_WAIT: Duration = Duration::from_secs(5);
/// Upper bound for one queued manager call, so a stuck server cannot stall the queue.
const OP_TIMEOUT: Duration = Duration::from_secs(20);
const VERSION_HISTORY: usize = 64;
const MAX_PENDING_WATCH_EVENTS: usize = 1024;
const MAX_WATCH_DELIVERIES: usize = 32;
const MAX_WATCH_TARGETS: usize = 32;

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
    /// Bytes received across every artifact of the install. Never decreases.
    pub overall_received: u64,
    /// Bytes expected across every artifact, when known.
    pub overall_total: Option<u64>,
    /// Zero based index of the artifact being worked on.
    pub artifact_index: u32,
    pub artifact_count: u32,
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
    WorkProgress(LanguageServerWorkProgress),
    Diagnostics(DiagnosticsPublished),
    Error(LanguageServerError),
}

/// Servers that execute the project's own build code unless restricted.
const PROJECT_CODE_SERVERS: [ServerId; 2] = [ServerId::RustAnalyzer, ServerId::Jdtls];

pub type EventSink = Arc<dyn Fn(LspEvent) + Send + Sync>;

pub fn tauri_sink(app: tauri::AppHandle) -> EventSink {
    Arc::new(move |event| {
        match event {
            LspEvent::State(e) => crate::events::emit(&app, &e),
            LspEvent::Install(e) => crate::events::emit(&app, &e),
            LspEvent::WorkProgress(e) => crate::events::emit(&app, &e),
            LspEvent::Diagnostics(e) => crate::events::emit(&app, &e),
            LspEvent::Error(e) => crate::events::emit(&app, &e),
        };
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
    WatchedFiles {
        generation: u64,
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

struct WatchedDelivery {
    changes: Vec<lsp::FileEvent>,
    targets: Vec<(ServerId, PathBuf, u64)>,
}

struct PendingWatchedFiles {
    generation: u64,
    deliveries: Vec<WatchedDelivery>,
    events: usize,
    incomplete: bool,
    warning_targets: HashMap<ServerId, u64>,
}

#[derive(Default)]
struct Shared {
    root: Option<PathBuf>,
    /// Incremented whenever the workspace changes.
    generation: u64,
    settings: LspSettings,
    docs: HashMap<PathBuf, Doc>,
    next_seq: u64,
    watched_files: Option<PendingWatchedFiles>,
    gates: HashMap<ServerId, Gate>,
    installed: HashSet<ServerId>,
    runtime_ok: HashSet<ServerId>,
    epochs: HashMap<ServerId, u64>,
    states: HashMap<(ServerId, PathBuf), LanguageServerStateDto>,
    versions: HashMap<PathBuf, VecDeque<(i32, u64)>>,
    last_error: HashMap<ServerId, String>,
    /// Running install tasks, so `lsp_cancel_install` can drop them.
    installs: HashMap<ServerId, tauri::async_runtime::JoinHandle<()>>,
    /// Latest overall progress of each running install.
    install_progress: HashMap<ServerId, InstallStatusDto>,
    work: WorkTracker,
}

/// Which folders may run project code. Shared with the options provider, which runs when
/// a server is started and decides per server root.
#[derive(Default, Clone)]
struct TrustState {
    everything: bool,
    /// Decisions of `trusted-workspaces.json`.
    entries: Entries,
    store: Option<Arc<TrustStore>>,
}

pub struct LanguageServers {
    manager: Manager,
    provisioner: Arc<dyn Provisioner>,
    sink: EventSink,
    state: Mutex<Shared>,
    trust: Arc<std::sync::RwLock<TrustState>>,
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

/// Download source used when the HTTP client could not be built (TLS or proxy setup):
/// every download fails with a typed install error, nothing else is affected.
struct UnavailableFetch(String);

impl span_lsp::servers::install::Fetch for UnavailableFetch {
    fn get<'a>(
        &'a self,
        _url: &'a str,
    ) -> span_lsp::servers::install::BoxFuture<
        'a,
        Result<span_lsp::servers::install::FetchResponse, span_lsp::servers::install::FetchError>,
    > {
        Box::pin(async move {
            Err(span_lsp::servers::install::FetchError(format!(
                "language server downloads are unavailable: {}",
                self.0
            )))
        })
    }
}

/// Production service: catalog resolver under `cache_root`, opt-in installs. Never fails:
/// if the HTTP client cannot be built the service starts in a degraded mode where
/// installs report a failure and every other feature works.
pub fn production(cache_root: PathBuf, sink: EventSink) -> LspService {
    production_using(cache_root, sink, || {
        span_lsp::servers::install::HttpFetch::new()
            .map(|fetch| Arc::new(fetch) as Arc<dyn span_lsp::servers::install::Fetch>)
            .map_err(|error| error.to_string())
    })
}

/// [`production`] with an injectable download source builder (tests inject a failing one).
pub fn production_using(
    cache_root: PathBuf,
    sink: EventSink,
    build_fetch: impl FnOnce() -> Result<Arc<dyn span_lsp::servers::install::Fetch>, String>,
) -> LspService {
    let fetch = build_fetch().unwrap_or_else(|reason| {
        eprintln!("Language server downloads are disabled: {reason}");
        Arc::new(UnavailableFetch(reason))
    });
    production_with_fetch(cache_root, fetch, sink, ServiceConfig::default())
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
        let trust: Arc<std::sync::RwLock<TrustState>> = Arc::default();
        let provider_trust = trust.clone();
        manager.set_options_provider(Arc::new(move |id, root, global| {
            let t = provider_trust.read().unwrap_or_else(|e| e.into_inner());
            catalog::initialization_options(
                id,
                is_trusted(global || t.everything, &t.entries, root),
            )
        }));
        let (tx, rx) = mpsc::unbounded_channel();
        let service = Arc::new(Self {
            manager,
            provisioner,
            sink,
            state: Mutex::new(Shared::default()),
            trust,
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

    fn set_trust(&self, settings: &LspSettings) {
        let mut t = self.trust.write().unwrap_or_else(|e| e.into_inner());
        t.everything = settings.run_project_code;
    }

    /// Whether project code may run for `root` (a server root or the workspace root).
    fn trusted(&self, root: &Path) -> bool {
        let t = self.trust.read().unwrap_or_else(|e| e.into_inner());
        is_trusted(t.everything, &t.entries, root)
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

    /// Queue only for starting or ready instances that existed when the native event arrived.
    /// Registration matching belongs to each client, not the Explorer visibility policy.
    pub(crate) fn watched_files_changed(&self, batch: crate::watched_paths::WatchedBatch) {
        if !batch.incomplete && batch.changes.is_empty() {
            return;
        }
        let mut st = lock(&self.state);
        if st.root.as_ref() != Some(&paths::normalize_path(&batch.root)) {
            return;
        }
        let mut targets = Vec::with_capacity(MAX_WATCH_TARGETS);
        let mut warning_targets = HashMap::new();
        let mut targets_overflowed = false;
        for ((server, root), state) in &st.states {
            if !matches!(
                state,
                LanguageServerStateDto::Starting | LanguageServerStateDto::Ready
            ) {
                continue;
            }
            let epoch = Self::epoch(&st, *server);
            warning_targets.insert(*server, epoch);
            if targets.len() < MAX_WATCH_TARGETS {
                targets.push((*server, root.clone(), epoch));
            } else {
                targets_overflowed = true;
            }
        }
        if targets.is_empty() {
            return;
        }
        let generation = st.generation;
        let needs_queue = st.watched_files.is_none();
        let pending = st.watched_files.get_or_insert_with(|| PendingWatchedFiles {
            generation,
            deliveries: Vec::new(),
            events: 0,
            incomplete: false,
            warning_targets: HashMap::new(),
        });
        pending.warning_targets.extend(warning_targets);
        pending.incomplete |= batch.incomplete || targets_overflowed;
        if pending.deliveries.len() >= MAX_WATCH_DELIVERIES {
            pending.incomplete = true;
        } else {
            let mut changes = batch.changes;
            let remaining = MAX_PENDING_WATCH_EVENTS.saturating_sub(pending.events);
            if changes.len() > remaining {
                pending.incomplete = true;
                changes.truncate(remaining);
            }
            pending.events += changes.len();
            pending
                .deliveries
                .push(WatchedDelivery { changes, targets });
        }
        if needs_queue {
            self.push(&mut st, Op::WatchedFiles { generation });
        }
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
        self.set_trust(&new);
        self.import_legacy_trust(&settings.language_servers.trusted_workspaces);
        let mut st = lock(&self.state);
        st.work.clear_all();
        let mut keys: HashSet<(ServerId, PathBuf)> = st.states.keys().cloned().collect();
        keys.extend(st.docs.values().map(|d| (d.r.server, d.r.root.clone())));
        for server in ALL_SERVERS {
            Self::bump_epoch(&mut st, server);
        }
        st.generation += 1;
        st.docs.clear();
        st.watched_files = None;
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
        self.set_trust(&new);
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
            let watched_generation = match &queued.op {
                Op::WatchedFiles { generation } => Some(*generation),
                _ => None,
            };
            let server = match &queued.op {
                Op::Open { d, .. } | Op::Change { d, .. } | Op::Close { d } | Op::Save { d } => {
                    Some(d.server)
                }
                Op::Stop { server } | Op::Resume { server } | Op::Restart { server } => {
                    Some(*server)
                }
                Op::Reset { .. } | Op::WatchedFiles { .. } => None,
            };
            if tokio::time::timeout(OP_TIMEOUT, self.handle(queued, &mut synced))
                .await
                .is_err()
            {
                if let Some(server) = server {
                    self.report(server, None, "a language server operation timed out".into());
                }
                if let Some(generation) = watched_generation {
                    let targets: Vec<_> = {
                        let st = lock(&self.state);
                        if st.generation == generation {
                            st.states
                                .iter()
                                .filter(|(_, state)| **state == LanguageServerStateDto::Ready)
                                .map(|((server, _), _)| *server)
                                .collect()
                        } else {
                            Vec::new()
                        }
                    };
                    for server in targets {
                        self.report(server, None, "Filesystem notification delivery timed out. Restart this language server to refresh its workspace state.".into());
                    }
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
            Op::WatchedFiles { generation } => {
                let pending = {
                    let mut st = lock(&self.state);
                    if st.generation != generation {
                        return;
                    }
                    st.watched_files
                        .take()
                        .filter(|pending| pending.generation == generation)
                };
                let Some(pending) = pending else {
                    return;
                };
                if pending.incomplete {
                    for (server, epoch) in pending.warning_targets {
                        let current = {
                            let st = lock(&self.state);
                            st.generation == generation && Self::epoch(&st, server) == epoch
                        };
                        if current {
                            self.report(server, None, "Some filesystem notifications were lost or exceeded delivery limits. Restart this language server to refresh its workspace state.".into());
                        }
                    }
                }
                for delivery in pending.deliveries {
                    for (server, root, epoch) in delivery.targets {
                        let current = {
                            let st = lock(&self.state);
                            st.generation == generation
                                && Self::epoch(&st, server) == epoch
                                && matches!(
                                    st.states.get(&(server, root.clone())),
                                    Some(
                                        LanguageServerStateDto::Starting
                                            | LanguageServerStateDto::Ready
                                    )
                                )
                        };
                        if !current {
                            continue;
                        }
                        if !delivery.changes.is_empty() {
                            if let Err(error) =
                                self.manager.wait_ready(server, &root, SYNC_WAIT).await
                            {
                                self.report(server, None, format!("Filesystem notifications could not be delivered to this starting language server: {error}. Restart the server to refresh its workspace state."));
                                continue;
                            }
                            {
                                let st = lock(&self.state);
                                if st.generation != generation || Self::epoch(&st, server) != epoch
                                {
                                    continue;
                                }
                            }
                            if let Err(error) = self
                                .manager
                                .notify_watched_files(server, &root, delivery.changes.clone())
                                .await
                            {
                                self.report(server, None, error.to_string());
                            }
                        }
                    }
                }
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
        let handle = tauri::async_runtime::spawn(async move { this.install_task(server).await });
        lock(&self.state).installs.insert(server, handle);
    }

    async fn install_task(self: Arc<Self>, server: ServerId) {
        if let Err(issue) = self.provisioner.check_runtime(server).await {
            self.set_gate(server, Gate::RuntimeMissing(issue));
            return;
        }
        let version = self.provisioner.version(server);
        let (tx, mut rx) = mpsc::channel(256);
        let hint = self.provisioner.size_hint(server);
        let forwarder = {
            let this = self.clone();
            let version = version.clone();
            tauri::async_runtime::spawn(async move {
                let mut tracker = OverallTracker::new(hint);
                let mut last = Instant::now() - Duration::from_secs(1);
                while let Some(progress) = rx.recv().await {
                    tracker.apply(&progress);
                    if let Some(mut event) = Self::progress_event(server, &version, progress) {
                        Self::stamp(&mut event, tracker.snapshot());
                        lock(&this.state).install_progress.insert(
                            server,
                            InstallStatusDto {
                                phase: event.phase,
                                overall_received: event.overall_received,
                                overall_total: event.overall_total,
                                artifact_index: event.artifact_index,
                                artifact_count: event.artifact_count,
                            },
                        );
                        let chunk = event.phase == InstallPhase::Downloading;
                        let done = event.received.is_some() && event.received == event.total;
                        if chunk && !done && last.elapsed() < Duration::from_millis(100) {
                            continue;
                        }
                        last = Instant::now();
                        this.emit(LspEvent::Install(event));
                    }
                }
                tracker
            })
        };
        let result = self.provisioner.install(server, tx).await;
        let mut tracker = forwarder.await.unwrap_or_default();
        {
            let mut st = lock(&self.state);
            st.installs.remove(&server);
            st.install_progress.remove(&server);
        }
        match result {
            Ok(()) => {
                {
                    let mut st = lock(&self.state);
                    st.gates.remove(&server);
                    st.installed.insert(server);
                    st.last_error.remove(&server);
                    self.push(&mut st, Op::Resume { server });
                }
                let mut event = Self::phase_event(server, &version, InstallPhase::Finished, None);
                Self::stamp(&mut event, tracker.complete());
                self.emit(LspEvent::Install(event));
            }
            Err(InstallFailure { reason, retryable }) => {
                let mut event =
                    Self::phase_event(server, &version, InstallPhase::Failed, Some(reason.clone()));
                Self::stamp(&mut event, tracker.snapshot());
                self.emit(LspEvent::Install(event));
                self.report(server, None, format!("install failed: {reason}"));
                self.set_gate(server, Gate::InstallFailed { reason, retryable });
            }
        }
    }

    fn stamp(event: &mut LanguageServerInstallProgress, overall: Overall) {
        event.overall_received = overall.received;
        event.overall_total = overall.total;
        event.artifact_index = overall.index;
        event.artifact_count = overall.count;
    }

    /// Cancel an install in flight: drop the install (which releases its lock), remove the
    /// staging tree with its partial downloads, and go back to `needs-install`. Quiet:
    /// emits a `cancelled` progress event, never an error. Safe when nothing installs.
    pub async fn cancel_install(self: &Arc<Self>, server: ServerId) {
        let handle = {
            let mut st = lock(&self.state);
            if st.gates.get(&server) != Some(&Gate::Installing) {
                return;
            }
            st.install_progress.remove(&server);
            st.installs.remove(&server)
        };
        if let Some(handle) = handle {
            handle.abort();
            let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
        }
        let provisioner = self.provisioner.clone();
        let _ = tokio::task::spawn_blocking(move || provisioner.discard_partial(server)).await;
        // A task that finished on its own just before the abort already set its result.
        if lock(&self.state).gates.get(&server) != Some(&Gate::Installing) {
            return;
        }
        self.set_gate(server, Gate::NeedsInstall);
        let version = self.provisioner.version(server);
        self.emit(LspEvent::Install(Self::phase_event(
            server,
            &version,
            InstallPhase::Cancelled,
            None,
        )));
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
            overall_received: 0,
            overall_total: None,
            artifact_index: 0,
            artifact_count: 0,
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
                    if dto != LanguageServerStateDto::Ready
                        && dto != LanguageServerStateDto::Starting
                    {
                        // Whatever it was busy with died with it.
                        st.work.clear(server, &root);
                    }
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
            ManagerEvent::Progress {
                server,
                root,
                token,
                kind,
                title,
                message,
                percentage,
            } => {
                let report = span_lsp::servers::manager::WorkProgress {
                    token,
                    kind,
                    title,
                    message,
                    percentage,
                };
                let event = lock(&self.state).work.apply(server, &root, report);
                if let Some(event) = event {
                    self.emit(LspEvent::WorkProgress(event));
                }
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
        tokio::pin!(call);
        let outcome = tokio::select! {
            _ = guard.token.cancelled() => {
                cancel_grace(call).await;
                return Err(LspErrorDto::Cancelled);
            }
            r = tokio::time::timeout(self.request_timeout, &mut call) => r,
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
        let (settings, gates, states, epochs, workspace) = {
            let st = lock(&self.state);
            (
                st.settings.clone(),
                st.gates.clone(),
                st.states.clone(),
                st.epochs.clone(),
                st.root.clone(),
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
                    (Some(root), LanguageServerStateDto::Ready) => {
                        match self.manager.capabilities(server, root).await {
                            Some(c) => {
                                let mut dto = CapabilitiesDto::from(&c);
                                dto.type_hierarchy =
                                    self.manager.supports_type_hierarchy(server, root).await;
                                Some(dto)
                            }
                            None => None,
                        }
                    }
                    _ => None,
                };
                let basis = root.clone().or_else(|| workspace.clone());
                let installed_size_bytes = if installed {
                    match self.provisioner.installed_dir(server) {
                        Some(dir) => tokio::task::spawn_blocking(move || dir_size(&dir))
                            .await
                            .ok(),
                        None => None,
                    }
                } else {
                    None
                };
                let runtime = Self::runtime_dto(server, gates.get(&server));
                let (failure_reason, failure_details) = match failure(&state) {
                    Some((reason, details)) => (Some(reason), Some(details)),
                    None => (None, None),
                };
                let workspace_trusted = basis.as_deref().is_some_and(|b| self.trusted(b));
                let reason = if workspace_trusted || !enabled {
                    None
                } else {
                    basis
                        .as_deref()
                        .filter(|_| PROJECT_CODE_SERVERS.contains(&server))
                        .and_then(|b| trust_reason(server, b))
                };
                let (activity, install) = {
                    let st = lock(&self.state);
                    (
                        root.as_deref()
                            .map(|r| st.work.activity(server, r))
                            .unwrap_or_default(),
                        st.install_progress.get(&server).cloned(),
                    )
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
                    display_name: display_name(server).to_owned(),
                    languages: languages(server),
                    installed_size_bytes,
                    runtime,
                    failure_reason,
                    failure_details,
                    trust: TrustDto {
                        workspace_trusted,
                        needs_trust: reason.is_some(),
                        reason,
                    },
                    activity,
                    install,
                });
            }
        }
        rows
    }

    /// The open workspace root, as the service tracks it.
    pub fn workspace_root(&self) -> Option<PathBuf> {
        lock(&self.state).root.clone()
    }

    fn runtime_dto(server: ServerId, gate: Option<&Gate>) -> Option<RuntimeDto> {
        let req = catalog::spec(server).runtime;
        let name = match req.runtime {
            span_lsp::servers::spec::Runtime::Node => "Node.js",
            span_lsp::servers::spec::Runtime::Java => "JDK",
            span_lsp::servers::spec::Runtime::None => return None,
        };
        let (found_version, found_path) = match gate {
            Some(Gate::RuntimeMissing(issue)) => (
                issue.found.first().cloned(),
                issue.found_paths.first().cloned(),
            ),
            _ => (None, None),
        };
        Some(RuntimeDto {
            name: name.to_owned(),
            required_version: req.min_major,
            found_version,
            found_path,
        })
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

/// After a cancel the request future gets this long to put `$/cancelRequest` on the wire
/// (it observes the same token) before it is dropped.
async fn cancel_grace<F: Future>(call: std::pin::Pin<&mut F>) {
    let _ = tokio::time::timeout(Duration::from_millis(250), call).await;
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

// ---------------------------------------------------------------------------
// Navigation commands
// ---------------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn lsp_references(
    lsp: State<'_, LspService>,
    path: String,
    position: PositionDto,
    include_declaration: bool,
    request_id: Option<String>,
) -> Result<LspResponse<Vec<LocationDto>>, LspErrorDto> {
    lsp.inner()
        .clone()
        .references(&path, position, include_declaration, request_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_implementation(
    lsp: State<'_, LspService>,
    path: String,
    position: PositionDto,
    request_id: Option<String>,
) -> Result<LspResponse<Vec<LocationDto>>, LspErrorDto> {
    lsp.inner()
        .clone()
        .implementation(&path, position, request_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_type_definition(
    lsp: State<'_, LspService>,
    path: String,
    position: PositionDto,
    request_id: Option<String>,
) -> Result<LspResponse<Vec<LocationDto>>, LspErrorDto> {
    lsp.inner()
        .clone()
        .type_definition(&path, position, request_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_declaration(
    lsp: State<'_, LspService>,
    path: String,
    position: PositionDto,
    request_id: Option<String>,
) -> Result<LspResponse<Vec<LocationDto>>, LspErrorDto> {
    lsp.inner()
        .clone()
        .declaration(&path, position, request_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_document_symbols(
    lsp: State<'_, LspService>,
    path: String,
    request_id: Option<String>,
) -> Result<LspResponse<Vec<SymbolDto>>, LspErrorDto> {
    lsp.inner()
        .clone()
        .document_symbols(&path, request_id)
        .await
}

/// Capped at 200 results. With `path_hint` the server of that file answers; without it
/// every ready server is asked.
#[tauri::command]
#[specta::specta]
pub async fn lsp_workspace_symbols(
    lsp: State<'_, LspService>,
    query: String,
    path_hint: Option<String>,
    request_id: Option<String>,
) -> Result<LspResponse<Vec<WorkspaceSymbolDto>>, LspErrorDto> {
    lsp.inner()
        .clone()
        .workspace_symbols(query, path_hint, request_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_call_hierarchy_prepare(
    lsp: State<'_, LspService>,
    path: String,
    position: PositionDto,
    request_id: Option<String>,
) -> Result<LspResponse<Vec<CallHierarchyItemDto>>, LspErrorDto> {
    lsp.inner()
        .clone()
        .call_hierarchy_prepare(&path, position, request_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_call_hierarchy_incoming(
    lsp: State<'_, LspService>,
    item: CallHierarchyItemDto,
    request_id: Option<String>,
) -> Result<LspResponse<Vec<IncomingCallDto>>, LspErrorDto> {
    lsp.inner()
        .clone()
        .call_hierarchy_incoming(&item, request_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_call_hierarchy_outgoing(
    lsp: State<'_, LspService>,
    item: CallHierarchyItemDto,
    request_id: Option<String>,
) -> Result<LspResponse<Vec<OutgoingCallDto>>, LspErrorDto> {
    lsp.inner()
        .clone()
        .call_hierarchy_outgoing(&item, request_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_type_hierarchy_prepare(
    lsp: State<'_, LspService>,
    path: String,
    position: PositionDto,
    request_id: Option<String>,
) -> Result<LspResponse<Vec<TypeHierarchyItemDto>>, LspErrorDto> {
    lsp.inner()
        .clone()
        .type_hierarchy_prepare(&path, position, request_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_type_hierarchy_supertypes(
    lsp: State<'_, LspService>,
    item: TypeHierarchyItemDto,
    request_id: Option<String>,
) -> Result<LspResponse<Vec<TypeHierarchyItemDto>>, LspErrorDto> {
    lsp.inner()
        .clone()
        .type_hierarchy_supertypes(&item, request_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_type_hierarchy_subtypes(
    lsp: State<'_, LspService>,
    item: TypeHierarchyItemDto,
    request_id: Option<String>,
) -> Result<LspResponse<Vec<TypeHierarchyItemDto>>, LspErrorDto> {
    lsp.inner()
        .clone()
        .type_hierarchy_subtypes(&item, request_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_document_highlights(
    lsp: State<'_, LspService>,
    path: String,
    position: PositionDto,
    request_id: Option<String>,
) -> Result<LspResponse<Vec<DocumentHighlightDto>>, LspErrorDto> {
    lsp.inner()
        .clone()
        .document_highlights(&path, position, request_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_signature_help(
    lsp: State<'_, LspService>,
    path: String,
    position: PositionDto,
    request_id: Option<String>,
) -> Result<LspResponse<Option<SignatureHelpDto>>, LspErrorDto> {
    lsp.inner()
        .clone()
        .signature_help(&path, position, request_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn lsp_prepare_rename(
    lsp: State<'_, LspService>,
    path: String,
    position: PositionDto,
    request_id: Option<String>,
) -> Result<LspResponse<Option<PrepareRenameDto>>, LspErrorDto> {
    lsp.inner()
        .clone()
        .prepare_rename(&path, position, request_id)
        .await
}

/// Returns the edit as data (UTF-16 per file). The buffers are not changed: the UI
/// applies it through the buffer edit path.
#[tauri::command]
#[specta::specta]
pub async fn lsp_rename(
    lsp: State<'_, LspService>,
    path: String,
    position: PositionDto,
    new_name: String,
    request_id: Option<String>,
) -> Result<LspResponse<WorkspaceEditDto>, LspErrorDto> {
    lsp.inner()
        .clone()
        .rename(&path, position, new_name, request_id)
        .await
}

/// A read-only excerpt for peeks, hover previews and library source. At most 1 MiB, and
/// at most 400 lines of context on each side.
#[tauri::command]
#[specta::specta]
pub async fn lsp_read_source(
    lsp: State<'_, LspService>,
    location: LocationDto,
    context_lines: u32,
) -> Result<SourceSnippetDto, LspErrorDto> {
    lsp.inner()
        .clone()
        .read_source(location, context_lines)
        .await
}

/// Cancel an install in flight. Quiet and safe when nothing is installing: the server goes
/// back to `needs-install` and a `cancelled` install progress event is emitted.
#[tauri::command]
#[specta::specta]
pub async fn lsp_cancel_install(
    lsp: State<'_, LspService>,
    server: LanguageServerId,
) -> Result<(), String> {
    lsp.inner().clone().cancel_install(server.into()).await;
    Ok(())
}

/// Compatibility wrapper over the trust store: trust (`true`) or restrict (`false`) the
/// CURRENT workspace folder. Same as `workspace_trust_decide` with the folder scope; returns
/// the updated status.
#[tauri::command]
#[specta::specta]
pub async fn lsp_trust_workspace(
    app: tauri::AppHandle,
    lsp: State<'_, LspService>,
    trusted: bool,
) -> Result<Vec<ServerStatusDto>, String> {
    let choice = if trusted {
        TrustChoice::Trusted
    } else {
        TrustChoice::Restricted
    };
    decide_and_emit(&app, lsp.inner(), choice, TrustScope::Folder).await?;
    Ok(lsp.inner().clone().status().await)
}

async fn decide_and_emit(
    app: &tauri::AppHandle,
    lsp: &LspService,
    choice: TrustChoice,
    scope: TrustScope,
) -> Result<WorkspaceTrustStateDto, String> {
    let service = lsp.clone();
    let (root, state) =
        tauri::async_runtime::spawn_blocking(move || service.decide_trust(choice, scope))
            .await
            .map_err(|e| format!("Trust task failed: {e}"))??;
    crate::events::emit(
        app,
        &WorkspaceTrustChanged {
            root,
            decision: state.decision,
        },
    );
    Ok(state)
}

/// The trust state of the open workspace folder (see [`WorkspaceTrustStateDto`]).
#[tauri::command]
#[specta::specta]
pub async fn workspace_trust_state(
    lsp: State<'_, LspService>,
) -> Result<WorkspaceTrustStateDto, String> {
    Ok(lsp.inner().trust_state())
}

/// Store the user's decision for the open folder (`folder`) or for its parent folder
/// (`parent`, which then covers the folder's siblings too). Idempotent.
#[tauri::command]
#[specta::specta]
pub async fn workspace_trust_decide(
    app: tauri::AppHandle,
    lsp: State<'_, LspService>,
    decision: TrustChoice,
    scope: TrustScope,
) -> Result<WorkspaceTrustStateDto, String> {
    decide_and_emit(&app, lsp.inner(), decision, scope).await
}

#[cfg(test)]
mod tests;
