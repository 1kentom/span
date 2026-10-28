//! Service tests against a python3 fake language server.

use super::provision::{InstallFailure, Provisioner, RuntimeIssue};
use super::*;
use span_core::{CoreWorkspace, Settings, TextEdit};
use span_lsp::servers::install::BoxFuture;
use span_lsp::servers::manager::{ServerError, ServerState};
use span_lsp::servers::spec::LaunchSpec;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

const ID: ServerId = ServerId::Json;
const WAIT: Duration = Duration::from_secs(15);

struct FakeProvisioner {
    installed: AtomicBool,
    install_calls: AtomicUsize,
    fail_install: AtomicBool,
    runtime: Mutex<Option<RuntimeIssue>>,
}

impl FakeProvisioner {
    fn new(installed: bool) -> Arc<Self> {
        Arc::new(Self {
            installed: AtomicBool::new(installed),
            install_calls: AtomicUsize::new(0),
            fail_install: AtomicBool::new(false),
            runtime: Mutex::new(None),
        })
    }
}

impl Provisioner for FakeProvisioner {
    fn is_installed(&self, _id: ServerId) -> BoxFuture<'_, bool> {
        Box::pin(async move { self.installed.load(Ordering::SeqCst) })
    }
    fn check_runtime(&self, _id: ServerId) -> BoxFuture<'_, Result<(), RuntimeIssue>> {
        Box::pin(async move {
            match self.runtime.lock().unwrap().clone() {
                Some(issue) => Err(issue),
                None => Ok(()),
            }
        })
    }
    fn install(
        &self,
        _id: ServerId,
        progress: mpsc::Sender<InstallProgress>,
    ) -> BoxFuture<'_, Result<(), InstallFailure>> {
        Box::pin(async move {
            self.install_calls.fetch_add(1, Ordering::SeqCst);
            let _ = progress.try_send(InstallProgress::Finalizing);
            if self.fail_install.load(Ordering::SeqCst) {
                return Err(InstallFailure {
                    reason: "network down".into(),
                    retryable: true,
                });
            }
            self.installed.store(true, Ordering::SeqCst);
            Ok(())
        })
    }
    fn version(&self, _id: ServerId) -> String {
        "1.2.3".into()
    }
    fn size_hint(&self, _id: ServerId) -> Option<u64> {
        Some(42)
    }
    fn configure(&self, _settings: &LspSettings) {}
}

struct FakeResolver {
    mode: Mutex<&'static str>,
    log: PathBuf,
    resolves: AtomicUsize,
    /// Launch failure message, when set.
    fail: Mutex<Option<String>>,
}

impl LaunchResolver for FakeResolver {
    async fn resolve(&self, _id: ServerId) -> Result<LaunchSpec, ServerError> {
        self.resolves.fetch_add(1, Ordering::SeqCst);
        if let Some(message) = self.fail.lock().unwrap().clone() {
            return Err(ServerError::Launch(message));
        }
        let script =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-lsp-server.py");
        Ok(LaunchSpec {
            program: PathBuf::from("python3"),
            args: vec![
                script.to_string_lossy().into_owned(),
                (*self.mode.lock().unwrap()).to_string(),
            ],
            env: vec![(
                "FAKE_LSP_LOG".into(),
                self.log.to_string_lossy().into_owned(),
            )],
        })
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    log: PathBuf,
    ws: CoreWorkspace,
    svc: LspService,
    resolver: Arc<FakeResolver>,
    provisioner: Arc<FakeProvisioner>,
    events: Arc<Mutex<Vec<LspEvent>>>,
}

const DOC: &str = "{\"k\":\"😀\"}\n";

fn fixture(installed: bool, mode: &'static str, request_timeout: Duration) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    std::fs::create_dir(&project).unwrap();
    std::fs::write(project.join("a.json"), DOC).unwrap();
    std::fs::write(project.join("notes.txt"), "plain").unwrap();
    let log = dir.path().join("server.log");
    let ws = CoreWorkspace::open(&project)
        .unwrap()
        .with_user_settings(None);
    let root = PathBuf::from(ws.workspace().root);
    let resolver = Arc::new(FakeResolver {
        mode: Mutex::new(mode),
        log: log.clone(),
        resolves: AtomicUsize::new(0),
        fail: Mutex::new(None),
    });
    let provisioner = FakeProvisioner::new(installed);
    let events: Arc<Mutex<Vec<LspEvent>>> = Arc::default();
    let sink_events = events.clone();
    let svc = LanguageServers::new(
        resolver.clone(),
        provisioner.clone(),
        Arc::new(move |e| sink_events.lock().unwrap().push(e)),
        ServiceConfig {
            request_timeout,
            manager: ManagerConfig {
                init_timeout: Duration::from_secs(10),
                shutdown_grace: Duration::from_secs(2),
            },
        },
    );
    svc.workspace_changed(root.clone(), &Settings::default());
    Fixture {
        _dir: dir,
        root: root.clone(),
        log,
        ws,
        svc,
        resolver,
        provisioner,
        events,
    }
}

fn pos(line: u32, character: u32) -> PositionDto {
    PositionDto { line, character }
}

fn log_entries(log: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn methods(log: &Path) -> Vec<String> {
    log_entries(log)
        .iter()
        .map(|e| e["method"].as_str().unwrap().to_owned())
        .collect()
}

async fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    let start = Instant::now();
    while !check() {
        assert!(start.elapsed() < WAIT, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

impl Fixture {
    /// Open the buffer through the same hook the command uses and wait for the server.
    async fn open_ready(&mut self) -> BufferSnapshot {
        let snapshot = self.ws.open_buffer("a.json").unwrap();
        self.svc.on_snapshot(&snapshot);
        self.svc.flush().await;
        self.svc
            .manager
            .wait_ready(ID, &self.root, WAIT)
            .await
            .unwrap();
        snapshot
    }

    fn state_events(&self) -> Vec<LanguageServerStateDto> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                LspEvent::State(s) => Some(s.state.clone()),
                _ => None,
            })
            .collect()
    }

    fn has_state(&self, wanted: &LanguageServerStateDto) -> bool {
        self.state_events().iter().any(|s| s == wanted)
    }

    fn edit(&mut self, revision: u64, from: u32, to: u32, insert: &str) -> BufferRevision {
        self.svc
            .edit_buffer_delta(
                &mut self.ws,
                "a.json",
                revision,
                vec![TextEdit {
                    from,
                    to,
                    insert: insert.into(),
                }],
            )
            .unwrap()
    }
}

fn alive(pid: i64) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[tokio::test]
async fn open_edit_completion_discard_close_flow() {
    let mut f = fixture(true, "normal", Duration::from_secs(5));
    let snapshot = f.open_ready().await;
    assert_eq!(snapshot.revision, 0);

    // Insert after the emoji: UTF-16 offset 8, one past the surrogate pair.
    let rev = f.edit(0, 8, 8, "x");
    assert_eq!(rev.revision, 1);
    f.svc.flush().await;
    eventually("didChange in the server log", || {
        methods(&f.log)
            .iter()
            .any(|m| m == "textDocument/didChange")
    })
    .await;
    let change = log_entries(&f.log)
        .into_iter()
        .find(|e| e["method"] == "textDocument/didChange")
        .unwrap_or_else(|| panic!("didChange reached the server: {:?}", methods(&f.log)));
    let range = &change["params"]["contentChanges"][0]["range"];
    assert_eq!(
        range["start"],
        serde_json::json!({"line": 0, "character": 8})
    );
    assert_eq!(change["params"]["textDocument"]["version"], 2);
    let tracked = f
        .svc
        .manager
        .document_text(ID, &f.root, &f.root.join("a.json"))
        .await
        .unwrap();
    assert_eq!(tracked, f.ws.buffer_snapshot("a.json").unwrap().text);

    let completion = f
        .svc
        .completion("a.json", pos(0, 8), None, None)
        .await
        .unwrap();
    assert_eq!(completion.revision, 1);
    assert_eq!(completion.data.items.len(), 2);
    assert_eq!(
        completion.data.items[1].insert_text_format,
        InsertTextFormatDto::Snippet
    );
    assert!(f
        .svc
        .hover("a.json", pos(0, 1), None)
        .await
        .unwrap()
        .data
        .is_some());
    assert!(f
        .svc
        .definition("a.json", pos(0, 1), None)
        .await
        .unwrap()
        .data
        .is_empty());

    // Diagnostics are forwarded with the buffer revision of the opened version.
    eventually("diagnostics event", || {
        f.events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, LspEvent::Diagnostics(d) if d.path == "a.json" && d.diagnostics.len() == 1))
    })
    .await;

    // Unsupported file types are not tracked and report so.
    let txt = f.ws.open_buffer("notes.txt").unwrap();
    f.svc.on_snapshot(&txt);
    assert!(matches!(
        f.svc.completion("notes.txt", pos(0, 0), None, None).await,
        Err(LspErrorDto::Unsupported { .. })
    ));

    // Discard closes the document and opens it again from disk, versions continuing from the closed life.
    let discarded = f.ws.discard_buffer("a.json").unwrap();
    f.svc.on_discard(&discarded);
    f.svc.flush().await;
    eventually("reopen in the server log", || {
        let all = methods(&f.log);
        all.iter()
            .position(|m| m == "textDocument/didClose")
            .is_some_and(|c| all[c..].iter().any(|m| m == "textDocument/didOpen"))
    })
    .await;
    let all = methods(&f.log);
    let close = all
        .iter()
        .position(|m| m == "textDocument/didClose")
        .unwrap();
    assert!(all[close..].iter().any(|m| m == "textDocument/didOpen"));
    let tracked = f
        .svc
        .manager
        .document_text(ID, &f.root, &f.root.join("a.json"))
        .await
        .unwrap();
    assert_eq!(tracked, DOC);
}

#[tokio::test]
async fn needs_install_downloads_nothing_until_asked() {
    let mut f = fixture(false, "normal", Duration::from_secs(5));
    let snapshot = f.ws.open_buffer("a.json").unwrap();
    f.svc.on_snapshot(&snapshot);
    f.edit(0, 8, 8, "x");
    f.svc.flush().await;

    assert_eq!(f.provisioner.install_calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        f.resolver.resolves.load(Ordering::SeqCst),
        0,
        "no launch attempted"
    );
    assert!(f.has_state(&LanguageServerStateDto::NeedsInstall {
        version: "1.2.3".into(),
        size_hint: Some(42)
    }));
    assert_eq!(
        f.svc
            .completion("a.json", pos(0, 0), None, None)
            .await
            .unwrap_err(),
        LspErrorDto::NeedsInstall {
            server: LanguageServerId::Json,
            version: "1.2.3".into(),
            size_hint: Some(42)
        }
    );
    assert!(f
        .svc
        .status()
        .await
        .iter()
        .any(|s| s.server == LanguageServerId::Json
            && matches!(s.state, LanguageServerStateDto::NeedsInstall { .. })
            && !s.installed));
    // Editing was never affected.
    assert_eq!(f.edit(1, 0, 0, " ").revision, 2);

    f.svc.install(ID).await.unwrap();
    eventually("server ready after install", || {
        f.has_state(&LanguageServerStateDto::Ready)
    })
    .await;
    assert_eq!(f.provisioner.install_calls.load(Ordering::SeqCst), 1);
    // The text edited while gated is what the server got.
    let tracked = f
        .svc
        .manager
        .document_text(ID, &f.root, &f.root.join("a.json"))
        .await
        .unwrap();
    assert_eq!(tracked, f.ws.buffer_snapshot("a.json").unwrap().text);
    assert!(f
        .svc
        .completion("a.json", pos(0, 0), None, None)
        .await
        .is_ok());
    assert!(f
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, LspEvent::Install(i) if i.phase == InstallPhase::Finished)));
}

#[tokio::test]
async fn auto_install_setting_installs_on_first_use() {
    let mut f = fixture(false, "normal", Duration::from_secs(5));
    let mut settings = Settings::default();
    settings.language_servers.auto_install = true;
    f.svc.apply_settings(&settings);
    let snapshot = f.ws.open_buffer("a.json").unwrap();
    f.svc.on_snapshot(&snapshot);
    eventually("auto install then ready", || {
        f.has_state(&LanguageServerStateDto::Ready)
    })
    .await;
    assert_eq!(f.provisioner.install_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn failing_server_never_fails_or_slows_edits() {
    let mut f = fixture(true, "normal", Duration::from_secs(5));
    *f.resolver.fail.lock().unwrap() = Some("boom".into());
    let snapshot = f.ws.open_buffer("a.json").unwrap();
    f.svc.on_snapshot(&snapshot);
    let started = Instant::now();
    let mut revision = 0;
    for _ in 0..50 {
        revision = f.edit(revision, 8, 8, "y").revision;
    }
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "edits do not wait for the server"
    );
    assert_eq!(revision, 50);
    f.svc.flush().await;
    eventually("start failure event", || {
        f.has_state(&LanguageServerStateDto::StartFailed {
            reason: "cannot launch language server: boom".into(),
        })
    })
    .await;
    assert!(matches!(
        f.svc.hover("a.json", pos(0, 0), None).await,
        Err(LspErrorDto::NotReady { .. })
    ));
    // Retry path: fix the launch problem and restart; the buffered text arrives.
    *f.resolver.fail.lock().unwrap() = None;
    f.svc.restart(ID).await.unwrap();
    f.svc.manager.wait_ready(ID, &f.root, WAIT).await.unwrap();
    let tracked = f
        .svc
        .manager
        .document_text(ID, &f.root, &f.root.join("a.json"))
        .await
        .unwrap();
    assert_eq!(tracked, f.ws.buffer_snapshot("a.json").unwrap().text);
}

#[tokio::test]
async fn reply_after_an_edit_is_stale() {
    let mut f = fixture(true, "slow-hover", Duration::from_secs(10));
    f.open_ready().await;
    let ok = f.svc.hover("a.json", pos(0, 1), None).await.unwrap();
    assert_eq!(ok.revision, 0);

    let svc = f.svc.clone();
    let pending = tokio::spawn(async move { svc.hover("a.json", pos(0, 1), None).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    f.edit(0, 8, 8, "x");
    assert_eq!(pending.await.unwrap().unwrap_err(), LspErrorDto::Stale);
}

#[tokio::test]
async fn reply_after_a_restart_is_stale() {
    let mut f = fixture(true, "normal", Duration::from_secs(5));
    f.open_ready().await;
    let epoch_before = f
        .svc
        .status()
        .await
        .iter()
        .find(|s| s.server == LanguageServerId::Json)
        .unwrap()
        .epoch;
    let svc = f.svc.clone();
    let result = f
        .svc
        .request("a.json", None, move |_call| async move {
            // The server restarts while the request is in flight.
            svc.restart(ID).await.unwrap();
            Ok::<_, ManagerError>(1)
        })
        .await;
    assert_eq!(result.unwrap_err(), LspErrorDto::Stale);
    let status = f.svc.status().await;
    let json = status
        .iter()
        .find(|s| s.server == LanguageServerId::Json)
        .unwrap();
    assert_eq!(json.epoch, epoch_before + 1);
}

#[tokio::test]
async fn cancelled_request_returns_cancelled() {
    let mut f = fixture(true, "slow-hover", Duration::from_secs(10));
    f.open_ready().await;
    let svc = f.svc.clone();
    let pending =
        tokio::spawn(async move { svc.hover("a.json", pos(0, 1), Some("req-1".into())).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    f.svc.cancel("req-1");
    assert_eq!(pending.await.unwrap().unwrap_err(), LspErrorDto::Cancelled);
}

#[tokio::test]
async fn workspace_change_and_exit_leave_no_child_process() {
    let mut f = fixture(true, "normal", Duration::from_secs(5));
    f.open_ready().await;
    let pid = log_entries(&f.log)[0]["pid"].as_i64().unwrap();
    assert!(alive(pid));

    // A different workspace root closes the old one's documents and servers.
    let other = tempfile::tempdir().unwrap();
    f.svc
        .workspace_changed(other.path().canonicalize().unwrap(), &Settings::default());
    f.svc.flush().await;
    eventually("old server process to exit", || !alive(pid)).await;
    assert!(f
        .svc
        .completion("a.json", pos(0, 0), None, None)
        .await
        .is_err());

    // App exit stops whatever is left, within the bound.
    let mut g = fixture(true, "normal", Duration::from_secs(5));
    g.open_ready().await;
    let pid = log_entries(&g.log)[0]["pid"].as_i64().unwrap();
    let svc = g.svc.clone();
    tokio::task::spawn_blocking(move || svc.shutdown_blocking(Duration::from_secs(8)))
        .await
        .unwrap();
    eventually("server process to exit on app exit", || !alive(pid)).await;
}

#[tokio::test]
async fn formatting_failures_never_touch_the_draft_or_saving() {
    for mode in ["fail-format", "hang-format"] {
        let mut f = fixture(true, mode, Duration::from_millis(700));
        f.open_ready().await;
        let revision = f.edit(0, 8, 8, "draft").revision;
        let before = f.ws.buffer_snapshot("a.json").unwrap();

        let started = Instant::now();
        let error = f.svc.format("a.json", None, None).await.unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(
            matches!(
                error,
                LspErrorDto::Other { .. } | LspErrorDto::NotReady { .. }
            ),
            "{mode}: {error:?}"
        );

        // Draft intact, revision unchanged, and saving works without the server.
        let after = f.ws.buffer_snapshot("a.json").unwrap();
        assert_eq!(
            (after.text.as_str(), after.revision),
            (before.text.as_str(), revision)
        );
        let saved = f.ws.save_buffer("a.json", revision).unwrap();
        f.svc.on_snapshot(&saved);
        assert_eq!(
            std::fs::read_to_string(f.root.join("a.json")).unwrap(),
            before.text
        );
    }

    // A healthy formatter returns edits and still leaves the buffer to the editor.
    let mut f = fixture(true, "normal", Duration::from_secs(5));
    f.open_ready().await;
    let response = f.svc.format("a.json", None, None).await.unwrap();
    assert_eq!(response.data[0].new_text, "// ");
    assert_eq!(f.ws.buffer_snapshot("a.json").unwrap().text, DOC);
}

#[tokio::test]
async fn runtime_and_install_failures_are_typed_and_retryable() {
    let mut f = fixture(false, "normal", Duration::from_secs(5));
    *f.provisioner.runtime.lock().unwrap() = Some(RuntimeIssue {
        runtime: "node".into(),
        required: 20,
        found: vec!["18.1.0".into()],
    });
    let snapshot = f.ws.open_buffer("a.json").unwrap();
    f.svc.on_snapshot(&snapshot);
    f.svc.flush().await;
    let expected = LspErrorDto::RuntimeMissing {
        server: LanguageServerId::Json,
        runtime: "node".into(),
        required_version: 20,
        found: vec!["18.1.0".into()],
    };
    assert_eq!(
        f.svc.hover("a.json", pos(0, 0), None).await.unwrap_err(),
        expected
    );
    // Not offered for download while it could not run anyway.
    assert_eq!(f.provisioner.install_calls.load(Ordering::SeqCst), 0);
    assert_eq!(f.svc.restart(ID).await.unwrap_err(), expected);

    // Runtime fixed; install fails with a retryable error, then succeeds on retry.
    *f.provisioner.runtime.lock().unwrap() = None;
    f.provisioner.fail_install.store(true, Ordering::SeqCst);
    f.svc.install(ID).await.unwrap();
    eventually("install failure state", || {
        f.has_state(&LanguageServerStateDto::InstallFailed {
            reason: "network down".into(),
            retryable: true,
        })
    })
    .await;
    assert!(matches!(
        f.svc.hover("a.json", pos(0, 0), None).await,
        Err(LspErrorDto::InstallFailed {
            retryable: true,
            ..
        })
    ));
    f.provisioner.fail_install.store(false, Ordering::SeqCst);
    f.svc.install(ID).await.unwrap();
    f.svc
        .manager
        .wait_ready(ID, &f.root, WAIT)
        .await
        .map_err(|e| e.to_string())
        .ok();
    eventually("ready after retry", || {
        f.has_state(&LanguageServerStateDto::Ready)
    })
    .await;
}

#[tokio::test]
async fn status_reports_capabilities_only_for_ready_servers() {
    let mut f = fixture(true, "normal", Duration::from_secs(5));
    let before = f.svc.status().await;
    let json = before
        .iter()
        .find(|s| s.server == LanguageServerId::Json)
        .unwrap();
    assert_eq!(json.state, LanguageServerStateDto::NotStarted);
    assert!(json.capabilities.is_none());
    assert_eq!(before.len(), 7);

    f.open_ready().await;
    eventually("ready state event", || {
        f.has_state(&LanguageServerStateDto::Ready)
    })
    .await;
    let after = f.svc.status().await;
    let json = after
        .iter()
        .find(|s| s.server == LanguageServerId::Json)
        .unwrap();
    assert_eq!(json.state, LanguageServerStateDto::Ready);
    let caps = json.capabilities.unwrap();
    assert!(caps.completion && caps.hover && caps.definition && caps.formatting);
    assert!(!caps.range_formatting && !caps.rename && !caps.references);
    let _ = ServerState::Ready;
}

/// `shutdown_blocking` is called from the app exit hook, a plain thread with no Tokio
/// context. It must neither panic nor hang when the children are slow.
#[tokio::test]
async fn shutdown_blocking_from_a_plain_thread_is_bounded() {
    for (mode, limit) in [("normal", 8), ("slow-shutdown", 1)] {
        let mut f = fixture(true, mode, Duration::from_secs(5));
        f.open_ready().await;
        let pid = log_entries(&f.log)[0]["pid"].as_i64().unwrap();
        let svc = f.svc.clone();
        let started = Instant::now();
        let thread = std::thread::spawn(move || svc.shutdown_blocking(Duration::from_secs(limit)));
        tokio::task::spawn_blocking(move || thread.join())
            .await
            .unwrap()
            .expect("shutdown_blocking must not panic");
        assert!(
            started.elapsed() < Duration::from_secs(6),
            "{mode} took {:?}",
            started.elapsed()
        );
        eventually(
            &format!("{mode} server process to exit on app exit"),
            || !alive(pid),
        )
        .await;
    }
}

#[tokio::test]
async fn created_saved_renamed_and_trashed_files_reach_the_servers() {
    let mut f = fixture(true, "normal", Duration::from_secs(5));
    f.open_ready().await;

    // A created file is opened in the server.
    let created = f.ws.new_file("b.json").unwrap();
    f.svc.on_snapshot(&created);
    f.svc.flush().await;
    eventually("didOpen for b.json", || {
        log_entries(&f.log).iter().any(|e| {
            e["method"] == "textDocument/didOpen"
                && e["params"]["textDocument"]["uri"]
                    .as_str()
                    .is_some_and(|u| u.ends_with("/b.json"))
        })
    })
    .await;

    // A save sends didSave for a tracked document and for nothing else.
    f.svc.on_saved(&created);
    f.svc.on_saved(&f.ws.open_buffer("notes.txt").unwrap());
    f.svc.flush().await;
    eventually("didSave", || {
        methods(&f.log).iter().any(|m| m == "textDocument/didSave")
    })
    .await;
    assert_eq!(
        methods(&f.log)
            .iter()
            .filter(|m| *m == "textDocument/didSave")
            .count(),
        1
    );

    // Rename: the old path is closed, the moved buffer is opened under the new path.
    let entry = f.ws.rename_path("b.json", "c.json").unwrap();
    assert_eq!(f.svc.on_closed("b.json"), vec!["b.json".to_string()]);
    let moved = f.ws.buffer_snapshot(&entry.path).unwrap();
    f.svc.on_snapshot(&moved);
    f.svc.flush().await;
    let uris = |method: &str| -> Vec<String> {
        log_entries(&f.log)
            .iter()
            .filter(|e| e["method"] == method)
            .filter_map(|e| {
                e["params"]["textDocument"]["uri"]
                    .as_str()
                    .map(String::from)
            })
            .collect()
    };
    eventually("close of b.json and open of c.json", || {
        uris("textDocument/didClose")
            .iter()
            .any(|u| u.ends_with("/b.json"))
            && uris("textDocument/didOpen")
                .iter()
                .any(|u| u.ends_with("/c.json"))
    })
    .await;

    // Trash closes the document and a second close is a no-op.
    assert_eq!(f.svc.on_closed("c.json"), vec!["c.json".to_string()]);
    assert!(f.svc.on_closed("c.json").is_empty());
    f.svc.flush().await;
    eventually("close of c.json", || {
        uris("textDocument/didClose")
            .iter()
            .any(|u| u.ends_with("/c.json"))
    })
    .await;
    assert!(f
        .svc
        .completion("c.json", pos(0, 0), None, None)
        .await
        .is_err());
}

fn initialize_options(log: &Path) -> Vec<serde_json::Value> {
    log_entries(log)
        .iter()
        .filter(|e| e["method"] == "initialize")
        .map(|e| e["params"]["initializationOptions"].clone())
        .collect()
}

async fn open_in(f: &mut Fixture, path: &str, server: ServerId) {
    std::fs::write(f.root.join(path), "").unwrap();
    let snapshot = f.ws.open_buffer(path).unwrap();
    f.svc.on_snapshot(&snapshot);
    f.svc.flush().await;
    f.svc
        .manager
        .wait_ready(server, &f.root, WAIT)
        .await
        .unwrap();
}

#[tokio::test]
async fn project_code_servers_start_restricted_by_default() {
    let mut f = fixture(true, "normal", Duration::from_secs(5));
    open_in(&mut f, "lib.rs", ServerId::RustAnalyzer).await;
    open_in(&mut f, "Main.java", ServerId::Jdtls).await;
    let options = initialize_options(&f.log);
    assert_eq!(options.len(), 2, "{options:?}");
    let ra = &options[0];
    assert_eq!(ra["cargo"]["buildScripts"]["enable"], false);
    assert_eq!(ra["procMacro"]["enable"], false);
    assert_eq!(ra["checkOnSave"], false);
    let java = &options[1]["settings"]["java"];
    assert_eq!(java["import"]["gradle"]["enabled"], false);
    assert_eq!(java["import"]["gradle"]["wrapper"]["enabled"], false);
    assert_eq!(java["import"]["maven"]["enabled"], false);
    assert_eq!(java["autobuild"]["enabled"], false);
}

#[tokio::test]
async fn project_code_servers_get_permissive_options_only_when_enabled() {
    let mut f = fixture(true, "normal", Duration::from_secs(5));
    let mut settings = Settings::default();
    settings.language_servers.run_project_code = true;
    f.svc.apply_settings(&settings);
    open_in(&mut f, "lib.rs", ServerId::RustAnalyzer).await;
    open_in(&mut f, "Main.java", ServerId::Jdtls).await;
    let options = initialize_options(&f.log);
    assert_eq!(options.len(), 2, "{options:?}");
    assert_eq!(options[0], serde_json::json!({}));
    assert_eq!(options[1]["settings"]["java"], serde_json::json!({}));
}

#[tokio::test]
async fn changing_run_project_code_restarts_the_running_servers() {
    let mut f = fixture(true, "normal", Duration::from_secs(5));
    open_in(&mut f, "lib.rs", ServerId::RustAnalyzer).await;
    assert_eq!(initialize_options(&f.log).len(), 1);
    let mut settings = Settings::default();
    settings.language_servers.run_project_code = true;
    f.svc.apply_settings(&settings);
    f.svc.flush().await;
    eventually("rust-analyzer restarted with permissive options", || {
        initialize_options(&f.log).len() == 2
    })
    .await;
    assert_eq!(initialize_options(&f.log)[1], serde_json::json!({}));
    // An unrelated settings change does not restart anything.
    settings.tab_size = 3;
    f.svc.apply_settings(&settings);
    f.svc.flush().await;
    assert_eq!(initialize_options(&f.log).len(), 2);
}

#[tokio::test]
async fn releasing_a_buffer_closes_it_and_a_reopen_keeps_versions_rising() {
    let mut f = fixture(true, "normal", Duration::from_secs(5));
    f.open_ready().await;
    let versions = |method: &str| -> Vec<i64> {
        log_entries(&f.log)
            .iter()
            .filter(|e| e["method"] == method)
            .filter_map(|e| e["params"]["textDocument"]["version"].as_i64())
            .collect()
    };
    eventually("first didOpen", || {
        !versions("textDocument/didOpen").is_empty()
    })
    .await;

    // What the `buffer_released` command does.
    assert_eq!(f.svc.on_closed("a.json"), vec!["a.json".to_string()]);
    f.svc.flush().await;
    eventually("didClose", || {
        methods(&f.log).iter().any(|m| m == "textDocument/didClose")
    })
    .await;

    // Opening it again re-syncs the file with a newer version than before.
    let snapshot = f.ws.open_buffer("a.json").unwrap();
    f.svc.on_snapshot(&snapshot);
    f.svc.flush().await;
    eventually("second didOpen", || {
        versions("textDocument/didOpen").len() == 2
    })
    .await;
    let opens = versions("textDocument/didOpen");
    assert!(opens[1] > opens[0], "versions must keep rising: {opens:?}");

    // Releasing a path nothing tracks is a no-op.
    assert!(f.svc.on_closed("never-opened.json").is_empty());
}

#[tokio::test]
async fn a_save_finishing_after_a_workspace_switch_is_not_sent_to_the_new_workspace() {
    let mut f = fixture(true, "normal", Duration::from_secs(5));
    let snapshot = f.ws.open_buffer("a.json").unwrap();

    // Same workspace: the snapshot is opened.
    let generation = f.svc.generation();
    assert!(f.svc.after_save(generation, &snapshot));
    f.svc.flush().await;
    f.svc.manager.wait_ready(ID, &f.root, WAIT).await.unwrap();
    eventually("didOpen", || {
        methods(&f.log).iter().any(|m| m == "textDocument/didOpen")
    })
    .await;

    // A save that started before the switch finishes after it: dropped.
    let started = f.svc.generation();
    let other = tempfile::tempdir().unwrap();
    f.svc
        .workspace_changed(other.path().canonicalize().unwrap(), &Settings::default());
    f.svc.flush().await;
    let before = log_entries(&f.log).len();
    assert!(!f.svc.after_save(started, &snapshot));
    f.svc.flush().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        log_entries(&f.log).len(),
        before,
        "nothing reaches a server"
    );
    assert!(
        f.svc.on_closed("a.json").is_empty(),
        "no document is tracked"
    );
}
