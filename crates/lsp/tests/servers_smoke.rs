//! Smoke tests against the REAL pinned language servers, driven through `Manager`.
//!
//! Nothing is mocked: `CatalogResolver` detects the runtime, downloads the pinned
//! artifacts with the real `HttpFetch` (SHA-256 verified by the installer) into a
//! cache that survives between runs, and the manager spawns, initializes and talks
//! to the actual server processes.
//!
//! Environment:
//! - `SPAN_LSP_TEST_CACHE`: cache root (default `<target dir>/span-lsp-test-cache`).
//! - Node.js 18+ on `PATH`, a JDK 25+ discoverable by the resolver, and network access
//!   on the first run. When one is missing the test FAILS with the resolver's message;
//!   nothing is skipped.
//!
//! Every test ends with `finish()`, which shuts the manager down and asserts that the
//! server process (and everything it spawned) is gone and that the server exited with
//! status 0 after receiving `shutdown` and `exit`.

mod common;

use common::{is_alive, kill_force, process_table};
use lsp_types::*;
use span_lsp::path_to_uri;
use span_lsp::servers::catalog;
use span_lsp::servers::manager::{
    LaunchResolver, Manager, ManagerConfig, ManagerError, ManagerEvent, ServerError,
};
use span_lsp::servers::resolver::CatalogResolver;
use span_lsp::servers::spec::{LaunchSpec, ServerId};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, Mutex};

/// First run downloads and (for JDT LS) builds a workspace; later runs are fast.
const READY_LIMIT: Duration = Duration::from_secs(900);
fn diag_limit(id: ServerId) -> Duration {
    match id {
        ServerId::RustAnalyzer => Duration::from_secs(300),
        _ => Duration::from_secs(240),
    }
}

/// Bound for one retried request. rust-analyzer and JDT LS load a whole workspace first.
fn request_limit(id: ServerId) -> Duration {
    match id {
        ServerId::RustAnalyzer | ServerId::Jdtls => Duration::from_secs(300),
        _ => Duration::from_secs(90),
    }
}

fn cache_root() -> PathBuf {
    if let Some(v) = std::env::var_os("SPAN_LSP_TEST_CACHE") {
        return PathBuf::from(v);
    }
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target"));
    target.join("span-lsp-test-cache")
}

// ---------------------------------------------------------------------------
// Launch wrapper: records the server pid and its exit status
// ---------------------------------------------------------------------------

/// Runs the real launch command under `sh -c` (unix) or PowerShell (windows) with explicit arguments so the test
/// can learn the pid and the exit status of the server. `$@` is the untouched
/// program and argument array. The wrapper is test-only; the resolver itself never
/// uses a shell.
struct RecordingResolver {
    inner: CatalogResolver,
    pidfile: PathBuf,
    statusfile: PathBuf,
}

impl RecordingResolver {
    /// Unix: `sh -c` records `$$` (the wrapper pid) and the exit status of the server.
    #[cfg(unix)]
    fn wrap(&self, spec: LaunchSpec) -> LaunchSpec {
        let mut args = vec![
            "-c".to_string(),
            r#"pidfile=$1; statusfile=$2; shift 2; echo $$ > "$pidfile"; "$@"; echo $? > "$statusfile""#
                .to_string(),
            "sh".to_string(),
            self.pidfile.to_string_lossy().into_owned(),
            self.statusfile.to_string_lossy().into_owned(),
            spec.program.to_string_lossy().into_owned(),
        ];
        args.extend(spec.args);
        LaunchSpec {
            program: PathBuf::from("/bin/sh"),
            args,
            env: spec.env,
        }
    }

    /// Windows: the same contract through a small PowerShell script run with `-File`,
    /// so every argument stays an explicit array element. `$PID` is the wrapper pid
    /// and `$LASTEXITCODE` the server's exit status. Unverified on a real Windows host.
    #[cfg(windows)]
    fn wrap(&self, spec: LaunchSpec) -> LaunchSpec {
        let script = self.pidfile.with_file_name("launch-wrapper.ps1");
        std::fs::write(
            &script,
            "param($pidfile, $statusfile, $prog)\r\n\
             Set-Content -Path $pidfile -Value $PID -Encoding ascii\r\n\
             & $prog @args\r\n\
             Set-Content -Path $statusfile -Value $LASTEXITCODE -Encoding ascii\r\n",
        )
        .expect("write launch wrapper");
        let mut args = vec![
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-File".to_string(),
            script.to_string_lossy().into_owned(),
            self.pidfile.to_string_lossy().into_owned(),
            self.statusfile.to_string_lossy().into_owned(),
            spec.program.to_string_lossy().into_owned(),
        ];
        args.extend(spec.args);
        LaunchSpec {
            program: PathBuf::from("powershell.exe"),
            args,
            env: spec.env,
        }
    }
}

/// Canonical path; on Windows the `\\?\` verbatim prefix is stripped because
/// language servers and `file:` URIs do not handle it well.
fn canonical(p: &Path) -> PathBuf {
    let c = std::fs::canonicalize(p).unwrap();
    #[cfg(windows)]
    {
        if let Some(rest) = c.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
            if !rest.starts_with("UNC") {
                return PathBuf::from(rest);
            }
        }
    }
    c
}

impl LaunchResolver for RecordingResolver {
    async fn resolve(&self, id: ServerId) -> Result<LaunchSpec, ServerError> {
        Ok(self.wrap(self.inner.resolve(id).await?))
    }

    async fn resolve_for(&self, id: ServerId, root: &Path) -> Result<LaunchSpec, ServerError> {
        Ok(self.wrap(self.inner.resolve_for(id, root).await?))
    }
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

fn descendants(root: u32) -> Vec<u32> {
    let table = process_table();
    let mut found = vec![root];
    let mut i = 0;
    while i < found.len() {
        let parent = found[i];
        for (pid, ppid, _) in &table {
            if *ppid == parent && !found.contains(pid) {
                found.push(*pid);
            }
        }
        i += 1;
    }
    found
}

// ---------------------------------------------------------------------------
// Text helpers (positions are UTF-16, as in LSP)
// ---------------------------------------------------------------------------

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// Position just after the first occurrence of `needle`.
fn after(text: &str, needle: &str) -> Position {
    let at = text
        .find(needle)
        .unwrap_or_else(|| panic!("{needle:?} not in text"))
        + needle.len();
    pos_at_byte(text, at)
}

/// Position of the start of the first occurrence of `needle`.
fn before(text: &str, needle: &str) -> Position {
    let at = text
        .find(needle)
        .unwrap_or_else(|| panic!("{needle:?} not in text"));
    pos_at_byte(text, at)
}

fn pos_at_byte(text: &str, at: usize) -> Position {
    let head = &text[..at];
    let line = head.matches('\n').count() as u32;
    let line_start = head.rfind('\n').map(|i| i + 1).unwrap_or(0);
    Position {
        line,
        character: utf16_len(&head[line_start..]),
    }
}

fn full_change(text: &str) -> TextDocumentContentChangeEvent {
    TextDocumentContentChangeEvent {
        range: None,
        range_length: None,
        text: text.to_string(),
    }
}

fn insert_change(at: Position, text: &str) -> TextDocumentContentChangeEvent {
    TextDocumentContentChangeEvent {
        range: Some(Range { start: at, end: at }),
        range_length: None,
        text: text.to_string(),
    }
}

fn items_of(r: Option<CompletionResponse>) -> Vec<CompletionItem> {
    match r {
        Some(CompletionResponse::Array(v)) => v,
        Some(CompletionResponse::List(l)) => l.items,
        None => Vec::new(),
    }
}

fn labels(items: &[CompletionItem]) -> Vec<&str> {
    items.iter().map(|i| i.label.as_str()).collect()
}

fn hover_text(h: &Hover) -> String {
    match &h.contents {
        HoverContents::Scalar(s) => marked(s),
        HoverContents::Array(v) => v.iter().map(marked).collect::<Vec<_>>().join("\n"),
        HoverContents::Markup(m) => m.value.clone(),
    }
}

fn marked(s: &MarkedString) -> String {
    match s {
        MarkedString::String(s) => s.clone(),
        MarkedString::LanguageString(l) => l.value.clone(),
    }
}

fn location_lines(r: &GotoDefinitionResponse) -> Vec<u32> {
    match r {
        GotoDefinitionResponse::Scalar(l) => vec![l.range.start.line],
        GotoDefinitionResponse::Array(v) => v.iter().map(|l| l.range.start.line).collect(),
        GotoDefinitionResponse::Link(v) => v
            .iter()
            .map(|l| l.target_selection_range.start.line)
            .collect(),
    }
}

fn location_uris(r: &GotoDefinitionResponse) -> Vec<String> {
    match r {
        GotoDefinitionResponse::Scalar(l) => vec![l.uri.to_string()],
        GotoDefinitionResponse::Array(v) => v.iter().map(|l| l.uri.to_string()).collect(),
        GotoDefinitionResponse::Link(v) => v.iter().map(|l| l.target_uri.to_string()).collect(),
    }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct Events {
    rx: broadcast::Receiver<ManagerEvent>,
    latest: HashMap<String, Vec<Diagnostic>>,
}

struct H {
    manager: Manager,
    id: ServerId,
    root: PathBuf,
    events: Mutex<Events>,
    pidfile: PathBuf,
    statusfile: PathBuf,
    _tmp: tempfile::TempDir,
}

impl H {
    /// Creates a project directory holding `files` on disk, starts the real server
    /// for it and waits until it is `Ready`.
    async fn start(id: ServerId, files: &[(&str, &str)]) -> H {
        let tmp = tempfile::tempdir().unwrap();
        let root = canonical(tmp.path()).join("project");
        std::fs::create_dir_all(&root).unwrap();
        for (rel, text) in files {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        let pidfile = tmp.path().join("server.pid");
        let statusfile = tmp.path().join("server.status");

        let cache = cache_root();
        std::fs::create_dir_all(&cache).unwrap();
        let resolver = RecordingResolver {
            inner: CatalogResolver::new(&cache).expect("build HTTP client"),
            pidfile: pidfile.clone(),
            statusfile: statusfile.clone(),
        };
        let manager = Manager::new(
            catalog::all_specs(),
            Arc::new(resolver),
            ManagerConfig {
                init_timeout: Duration::from_secs(240),
                shutdown_grace: Duration::from_secs(20),
            },
        );
        let rx = manager.subscribe();
        manager.start(id, &root).await.expect("start");
        if let Err(e) = manager.wait_ready(id, &root, READY_LIMIT).await {
            let state = manager.state(id, &root).await;
            panic!(
                "{id:?} could not become ready (missing runtime, no network or server failure): {e}; state {state:?}"
            );
        }
        eprintln!("[evidence] {id:?} initialize succeeded, state Ready");
        H {
            manager,
            id,
            root,
            events: Mutex::new(Events {
                rx,
                latest: HashMap::new(),
            }),
            pidfile,
            statusfile,
            _tmp: tmp,
        }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    fn uri(&self, rel: &str) -> Uri {
        path_to_uri(&self.path(rel)).unwrap()
    }

    /// Opens a document whose text lives only in the manager's buffer.
    async fn open(&self, rel: &str, lang: &str, text: &str) -> i32 {
        self.manager
            .open_document(self.id, &self.root, &self.path(rel), lang, text.to_string())
            .await
            .unwrap()
    }

    async fn change(&self, rel: &str, changes: Vec<TextDocumentContentChangeEvent>) -> i32 {
        self.manager
            .change_document(self.id, &self.root, &self.path(rel), changes)
            .await
            .unwrap()
    }

    async fn text(&self, rel: &str) -> String {
        self.manager
            .document_text(self.id, &self.root, &self.path(rel))
            .await
            .expect("document tracked")
    }

    fn tdpp(&self, rel: &str, pos: Position) -> TextDocumentPositionParams {
        TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri: self.uri(rel) },
            position: pos,
        }
    }

    /// Waits for a `publishDiagnostics` for `rel` whose latest set satisfies `pred`.
    async fn diagnostics(
        &self,
        rel: &str,
        what: &str,
        pred: impl Fn(&[Diagnostic]) -> bool,
    ) -> Vec<Diagnostic> {
        match self
            .diagnostics_within(rel, what, diag_limit(self.id), pred)
            .await
        {
            Some(d) => d,
            None => {
                let ev = self.events.lock().await;
                panic!(
                    "{:?}: no matching publishDiagnostics for {rel} ({what}) within {:?}; latest = {:?}",
                    self.id,
                    diag_limit(self.id),
                    ev.latest.get(&self.uri(rel).to_string())
                );
            }
        }
    }

    /// Like `diagnostics`, but gives up after `limit` and returns `None`.
    async fn diagnostics_within(
        &self,
        rel: &str,
        what: &str,
        limit: Duration,
        pred: impl Fn(&[Diagnostic]) -> bool,
    ) -> Option<Vec<Diagnostic>> {
        let key = self.uri(rel).to_string();
        let deadline = Instant::now() + limit;
        let mut ev = self.events.lock().await;
        loop {
            while let Ok(e) = ev.rx.try_recv() {
                if let ManagerEvent::Diagnostics { params, .. } = e {
                    ev.latest.insert(params.uri.to_string(), params.diagnostics);
                }
            }
            if let Some(d) = ev.latest.get(&key) {
                if pred(d) {
                    let msgs: Vec<String> = d
                        .iter()
                        .map(|d| {
                            format!(
                                "[{}:{}-{}:{} {:?} {:?}] {}",
                                d.range.start.line,
                                d.range.start.character,
                                d.range.end.line,
                                d.range.end.character,
                                d.severity,
                                d.code,
                                d.message
                            )
                        })
                        .collect();
                    eprintln!(
                        "[evidence] {:?} {rel} diagnostics ({what}): {msgs:?}",
                        self.id
                    );
                    return Some(d.clone());
                }
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            match tokio::time::timeout(left, ev.rx.recv()).await {
                Ok(Ok(ManagerEvent::Diagnostics { params, .. })) => {
                    ev.latest.insert(params.uri.to_string(), params.diagnostics);
                }
                Ok(Ok(_)) | Ok(Err(broadcast::error::RecvError::Lagged(_))) => {}
                Ok(Err(broadcast::error::RecvError::Closed)) => panic!("event channel closed"),
                Err(_) => {}
            }
        }
    }

    /// Asserts that NO diagnostics arrive for `rel` within `window`.
    async fn no_diagnostics(&self, rel: &str, window: Duration) {
        let key = self.uri(rel).to_string();
        let deadline = Instant::now() + window;
        let mut ev = self.events.lock().await;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            if let Ok(Ok(ManagerEvent::Diagnostics { params, .. })) =
                tokio::time::timeout(left, ev.rx.recv()).await
            {
                if params.uri.to_string() == key {
                    assert!(
                        params.diagnostics.is_empty(),
                        "unexpected diagnostics: {:?}",
                        params.diagnostics
                    );
                }
            }
        }
    }

    /// Completion, retried until `pred` accepts the items (servers such as
    /// rust-analyzer answer empty while the workspace is still loading).
    async fn completion_until(
        &self,
        rel: &str,
        pos: Position,
        pred: impl Fn(&[CompletionItem]) -> bool,
    ) -> Vec<CompletionItem> {
        let deadline = Instant::now() + request_limit(self.id);
        let mut last: String;
        loop {
            let params = CompletionParams {
                text_document_position: self.tdpp(rel, pos),
                context: None,
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
            };
            match self
                .manager
                .completion(self.id, &self.root, params, None)
                .await
            {
                Ok(r) => {
                    let items = items_of(r);
                    if pred(&items) {
                        let l = labels(&items);
                        eprintln!(
                            "[evidence] {:?} {rel} completion at {}:{}: {} items, first {:?}",
                            self.id,
                            pos.line,
                            pos.character,
                            items.len(),
                            &l[..l.len().min(8)]
                        );
                        return items;
                    }
                    last = format!("{} items: {:?}", items.len(), labels(&items));
                }
                Err(ManagerError::Unsupported(m)) => panic!("completion unsupported: {m}"),
                Err(ManagerError::ServerCrashed(m)) => panic!("server crashed: {m}"),
                Err(e) => last = format!("error {e}"),
            }
            assert!(
                Instant::now() < deadline,
                "{:?}: completion for {rel} never satisfied the check; last = {last}",
                self.id
            );
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn hover(&self, rel: &str, pos: Position) -> Result<Option<Hover>, ManagerError> {
        let params = HoverParams {
            text_document_position_params: self.tdpp(rel, pos),
            work_done_progress_params: Default::default(),
        };
        self.manager.hover(self.id, &self.root, params, None).await
    }

    /// Hover retried until it returns text that satisfies `pred`.
    async fn hover_until(&self, rel: &str, pos: Position, pred: impl Fn(&str) -> bool) -> String {
        let deadline = Instant::now() + request_limit(self.id);
        loop {
            let got = self.hover(rel, pos).await;
            let text = match &got {
                Ok(Some(h)) => hover_text(h),
                Ok(None) => String::new(),
                Err(ManagerError::Unsupported(m)) => panic!("hover unsupported: {m}"),
                Err(e) => format!("<error {e}>"),
            };
            if pred(&text) {
                eprintln!(
                    "[evidence] {:?} {rel} hover: {:?}",
                    self.id,
                    text.chars().take(100).collect::<String>()
                );
                return text;
            }
            assert!(
                Instant::now() < deadline,
                "{:?}: hover never matched; last = {text:?}",
                self.id
            );
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn definition(
        &self,
        rel: &str,
        pos: Position,
    ) -> Result<Option<GotoDefinitionResponse>, ManagerError> {
        let params = GotoDefinitionParams {
            text_document_position_params: self.tdpp(rel, pos),
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        };
        self.manager
            .definition(self.id, &self.root, params, None)
            .await
    }

    async fn definition_until(
        &self,
        rel: &str,
        pos: Position,
        pred: impl Fn(&GotoDefinitionResponse) -> bool,
    ) -> GotoDefinitionResponse {
        let deadline = Instant::now() + request_limit(self.id);
        loop {
            let got = self.definition(rel, pos).await;
            match &got {
                Ok(Some(r)) if pred(r) => {
                    eprintln!(
                        "[evidence] {:?} {rel} definition: lines {:?} uris {:?}",
                        self.id,
                        location_lines(r),
                        location_uris(r)
                    );
                    return r.clone();
                }
                Err(ManagerError::Unsupported(m)) => panic!("definition unsupported: {m}"),
                _ => {}
            }
            assert!(
                Instant::now() < deadline,
                "{:?}: definition never matched; last = {got:?}",
                self.id
            );
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn formatting(&self, rel: &str) -> Result<Option<Vec<TextEdit>>, ManagerError> {
        let params = DocumentFormattingParams {
            text_document: TextDocumentIdentifier { uri: self.uri(rel) },
            options: FormattingOptions {
                tab_size: 2,
                insert_spaces: true,
                ..Default::default()
            },
            work_done_progress_params: Default::default(),
        };
        self.manager
            .formatting(self.id, &self.root, params, None)
            .await
    }

    /// Requires formatting to work and to return at least one edit.
    async fn formatting_edits(&self, rel: &str) -> Vec<TextEdit> {
        let edits = self
            .formatting(rel)
            .await
            .unwrap_or_else(|e| panic!("{:?} formatting failed: {e}", self.id))
            .unwrap_or_default();
        eprintln!(
            "[evidence] {:?} {rel} formatting: {} edit(s), first {:?}",
            self.id,
            edits.len(),
            edits.first().map(|e| &e.new_text)
        );
        assert!(
            !edits.is_empty(),
            "{:?}: formatting returned no edits",
            self.id
        );
        edits
    }

    /// Requires that the server does not advertise the capability.
    async fn assert_unsupported<T: std::fmt::Debug>(
        &self,
        what: &str,
        got: Result<T, ManagerError>,
    ) {
        match got {
            Err(ManagerError::Unsupported(m)) => {
                eprintln!("[evidence] {:?} {what}: Unsupported ({m})", self.id)
            }
            other => panic!("{:?}: {what} should be Unsupported, got {other:?}", self.id),
        }
    }

    /// Shuts everything down and proves the server process tree is gone and that
    /// the server itself exited with status 0 after `shutdown` and `exit`.
    async fn finish(self) {
        let pid: u32 = std::fs::read_to_string(&self.pidfile)
            .expect("launch wrapper recorded the pid")
            .trim()
            .parse()
            .unwrap();
        let tree = descendants(pid);
        assert!(
            is_alive(pid),
            "server wrapper should be running before shutdown"
        );
        tokio::time::timeout(Duration::from_secs(120), self.manager.shutdown_all())
            .await
            .expect("shutdown_all hung");

        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let alive: Vec<u32> = tree.iter().copied().filter(|p| is_alive(*p)).collect();
            if alive.is_empty() {
                break;
            }
            if Instant::now() > deadline {
                for p in &alive {
                    kill_force(*p);
                }
                panic!(
                    "{:?}: processes still alive after shutdown_all: {alive:?}",
                    self.id
                );
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let status = std::fs::read_to_string(&self.statusfile)
            .unwrap_or_else(|_| panic!("{:?}: server exit status was never recorded", self.id));
        assert_eq!(
            status.trim(),
            "0",
            "{:?}: server did not exit cleanly after shutdown/exit",
            self.id
        );
        assert_eq!(self.manager.state(self.id, &self.root).await, None);
        eprintln!(
            "[evidence] {:?} shutdown_all: pids {tree:?} gone, server exit status 0",
            self.id
        );
    }
}

fn has_message(d: &[Diagnostic], needle: &str) -> bool {
    d.iter().any(|d| d.message.contains(needle))
}

fn code_is(d: &Diagnostic, code: i32) -> bool {
    matches!(&d.code, Some(NumberOrString::Number(n)) if *n == code)
}

// ---------------------------------------------------------------------------
// vtsls: .ts .tsx .js .jsx
// ---------------------------------------------------------------------------

#[tokio::test]
async fn vtsls_typescript_and_javascript_family() {
    let h = H::start(
        ServerId::Vtsls,
        &[(
            "tsconfig.json",
            r#"{"compilerOptions":{"strict":true,"jsx":"preserve","target":"es2020","allowJs":true}}"#,
        )],
    )
    .await;

    // .ts: unsaved buffer, completion, hover, definition, then a wrong version.
    let ts = "const count = 41;\nconst total = count + 1;\ncount.toF";
    h.open("a.ts", "typescript", ts).await;
    assert!(!h.path("a.ts").exists(), "buffer must not exist on disk");
    let items = h
        .completion_until("a.ts", after(ts, "count.toF"), |i| {
            labels(i).contains(&"toFixed")
        })
        .await;
    assert!(items.len() > 3);
    h.hover_until("a.ts", before(ts, "total"), |t| t.contains("number"))
        .await;
    let def = h
        .definition_until("a.ts", before(ts, "count + 1"), |r| {
            location_lines(r).contains(&0)
        })
        .await;
    assert!(location_uris(&def)[0].ends_with("a.ts"));

    let wrong = "const count: number = \"text\";\nconst total: string = count;\n";
    h.change("a.ts", vec![full_change(wrong)]).await;
    let d = h
        .diagnostics("a.ts", "ts type errors", |d| {
            d.iter().any(|d| code_is(d, 2322))
        })
        .await;
    assert!(has_message(&d, "is not assignable to type"));
    assert!(d.iter().any(|d| d.range.start.line == 0));

    // Formatting is advertised by vtsls.
    h.open(
        "fmt.ts",
        "typescript",
        "const   spaced   =  1 ;\nfunction f( a:number ){return a}\n",
    )
    .await;
    h.formatting_edits("fmt.ts").await;

    // .tsx
    let tsx = "const label = 42;\nconst view = <div className=\"x\">{label}</div>;\nlabel.toF";
    h.open("b.tsx", "typescriptreact", tsx).await;
    h.completion_until("b.tsx", after(tsx, "label.toF"), |i| {
        labels(i).contains(&"toFixed")
    })
    .await;
    h.change(
        "b.tsx",
        vec![full_change(
            "const label: number = \"oops\";\nconst view = <div className=\"x\">{label}</div>;\n",
        )],
    )
    .await;
    h.diagnostics("b.tsx", "tsx type error", |d| {
        d.iter().any(|d| code_is(d, 2322))
    })
    .await;

    // .js
    let js = "const items = [1, 2, 3];\nitems.ma";
    h.open("c.js", "javascript", js).await;
    h.completion_until("c.js", after(js, "items.ma"), |i| {
        labels(i).contains(&"map")
    })
    .await;
    h.change("c.js", vec![full_change("function broken( {\n")])
        .await;
    h.diagnostics("c.js", "js syntax error", |d| !d.is_empty())
        .await;

    // .jsx
    let jsx =
        "const items = [1, 2, 3];\nconst el = <ul>{items.map((n) => <li>{n}</li>)}</ul>;\nitems.fi";
    h.open("d.jsx", "javascriptreact", jsx).await;
    h.completion_until("d.jsx", after(jsx, "items.fi"), |i| {
        labels(i).contains(&"filter")
    })
    .await;
    h.change("d.jsx", vec![full_change("const el = <div>;\n")])
        .await;
    h.diagnostics("d.jsx", "jsx syntax error", |d| !d.is_empty())
        .await;

    h.finish().await;
}

// ---------------------------------------------------------------------------
// vtsls + incremental UTF-16 edit
// ---------------------------------------------------------------------------

#[tokio::test]
async fn vtsls_unicode_edit_reports_diagnostic_at_utf16_range() {
    let h = H::start(
        ServerId::Vtsls,
        &[("tsconfig.json", r#"{"compilerOptions":{"strict":true}}"#)],
    )
    .await;
    let start = "const s = \"\", n: number = \"x\";\n";
    h.open("u.ts", "typescript", start).await;
    // Insert emoji (2 UTF-16 units) and two CJK characters (1 unit each) in the string.
    h.change(
        "u.ts",
        vec![insert_change(
            Position {
                line: 0,
                character: 11,
            },
            "😀日本",
        )],
    )
    .await;
    let text = h.text("u.ts").await;
    assert_eq!(text, "const s = \"😀日本\", n: number = \"x\";\n");
    let d = h
        .diagnostics("u.ts", "after unicode edit", |d| {
            d.iter().any(|d| code_is(d, 2322))
        })
        .await;
    let expected = before(&text, "n: number");
    let got = d.iter().find(|d| code_is(d, 2322)).unwrap().range.start;
    assert_eq!(
        got, expected,
        "diagnostic must start at the UTF-16 column of `n`"
    );
    // The byte column would be different, proving the offsets are not bytes.
    assert_ne!(
        text[..text.find("n: number").unwrap()].len() as u32,
        got.character
    );

    // A second incremental edit placed after the emoji, then completion there.
    let at = after(&text, "\"x\"");
    h.change(
        "u.ts",
        vec![insert_change(
            Position {
                line: 1,
                character: 0,
            },
            "s.",
        )],
    )
    .await;
    let text2 = h.text("u.ts").await;
    assert!(text2.ends_with("s."));
    assert_eq!(at.line, 0);
    let items = h
        .completion_until(
            "u.ts",
            Position {
                line: 1,
                character: 2,
            },
            |i| labels(i).contains(&"length"),
        )
        .await;
    assert!(!items.is_empty());
    h.finish().await;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

#[tokio::test]
async fn html_server() {
    let h = H::start(ServerId::Html, &[("package.json", "{}")]).await;
    let text = "<!DOCTYPE html>\n<html>\n<body>\n<di\n</body>\n</html>\n";
    h.open("index.html", "html", text).await;
    assert!(!h.path("index.html").exists());
    let items = h
        .completion_until("index.html", after(text, "<di"), |i| {
            labels(i).contains(&"div")
        })
        .await;
    assert!(items.len() > 5);

    let html2 = "<!DOCTYPE html>\n<html>\n<body>\n<div></div>\n</body>\n</html>\n";
    h.change("index.html", vec![full_change(html2)]).await;
    h.hover_until("index.html", after(html2, "<div"), |t| !t.is_empty())
        .await;

    // The VS Code HTML server advertises definition but has nothing to resolve in
    // plain markup (it answers with an empty list), and it publishes no diagnostics
    // at all, so a malformed document must produce none.
    let def = h
        .definition("index.html", after(html2, "<div"))
        .await
        .expect("definition is advertised and must not fail");
    eprintln!("[evidence] Html definition on <div>: {def:?}");
    assert!(def.map(|d| location_lines(&d).is_empty()).unwrap_or(true));

    h.change(
        "index.html",
        vec![full_change(
            "<html><body><div><span></div></span><p class=></body>\n",
        )],
    )
    .await;
    h.no_diagnostics("index.html", Duration::from_secs(6)).await;
    eprintln!(
        "[evidence] Html: no publishDiagnostics for a malformed document (server publishes none)"
    );

    h.change(
        "index.html",
        vec![full_change(
            "<html><body><div><p>hi</p></div></body></html>",
        )],
    )
    .await;
    h.formatting_edits("index.html").await;
    h.finish().await;
}

// ---------------------------------------------------------------------------
// CSS, SCSS, Less
// ---------------------------------------------------------------------------

#[tokio::test]
async fn css_scss_less_server() {
    let h = H::start(ServerId::Css, &[("package.json", "{}")]).await;

    let css = "a {\n  col\n}\n";
    h.open("a.css", "css", css).await;
    let items = h
        .completion_until("a.css", after(css, "  col"), |i| {
            labels(i).contains(&"color")
        })
        .await;
    assert!(items.len() > 10);
    let css_ok = "a {\n  color: red;\n}\n";
    h.change("a.css", vec![full_change(css_ok)]).await;
    h.hover_until("a.css", after(css_ok, "  col"), |t| !t.is_empty())
        .await;
    h.change("a.css", vec![full_change("a {\n  colr: red;\n}\n")])
        .await;
    let d = h
        .diagnostics("a.css", "css unknown property", |d| {
            has_message(d, "Unknown property: 'colr'")
        })
        .await;
    assert_eq!(d[0].range.start.line, 1);
    h.change("a.css", vec![full_change("a{color:red;margin:0}\n")])
        .await;
    h.formatting_edits("a.css").await;
    let def = h
        .definition(
            "a.css",
            Position {
                line: 0,
                character: 0,
            },
        )
        .await;
    eprintln!("[evidence] Css css definition on selector: {def:?}");
    assert!(def.is_ok(), "{def:?}");

    let scss = "$brand: red;\n.b {\n  color: $brand;\n  col\n}\n";
    h.open("b.scss", "scss", scss).await;
    h.completion_until("b.scss", after(scss, "  col\n"), |i| {
        labels(i).contains(&"color")
    })
    .await;
    h.definition_until("b.scss", after(scss, "color: $br"), |r| {
        location_lines(r).contains(&0)
    })
    .await;
    h.change(
        "b.scss",
        vec![full_change("$brand: red;\n.b {\n  colr: $brand;\n}\n")],
    )
    .await;
    h.diagnostics("b.scss", "scss unknown property", |d| {
        has_message(d, "Unknown property: 'colr'")
    })
    .await;

    let less = "@brand: red;\n.c {\n  color: @brand;\n  col\n}\n";
    h.open("c.less", "less", less).await;
    h.completion_until("c.less", after(less, "  col\n"), |i| {
        labels(i).contains(&"color")
    })
    .await;
    h.definition_until("c.less", after(less, "color: @br"), |r| {
        location_lines(r).contains(&0)
    })
    .await;
    h.change(
        "c.less",
        vec![full_change("@brand: red;\n.c {\n  colr: @brand;\n}\n")],
    )
    .await;
    h.diagnostics("c.less", "less unknown property", |d| {
        has_message(d, "Unknown property: 'colr'")
    })
    .await;
    h.finish().await;
}

// ---------------------------------------------------------------------------
// JSON, JSONC (+ Unicode)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn json_and_jsonc_server_with_unicode_edit() {
    let schema = r#"{"type":"object","properties":{"mode":{"enum":["fast","slow"],"description":"Run mode"},"flag":{"type":"boolean"}}}"#;
    let h = H::start(
        ServerId::Json,
        &[("package.json", "{}"), ("schema.json", schema)],
    )
    .await;
    let schema_uri = h.uri("schema.json").to_string();

    // Without a schema the server only completes property names; a file schema
    // referenced by `$schema` gives value completion, hover and validation.
    let json = format!("{{\n  \"$schema\": \"{schema_uri}\",\n  \"mode\": \n}}\n");
    h.open("a.json", "json", &json).await;
    assert!(!h.path("a.json").exists());
    let items = h
        .completion_until("a.json", after(&json, "\"mode\": "), |i| {
            labels(i).contains(&"\"fast\"")
        })
        .await;
    assert_eq!(items.len(), 2, "{:?}", labels(&items));
    let bad = json.replace("\"mode\": \n", "\"mode\": \"other\"\n");
    h.change("a.json", vec![full_change(&bad)]).await;
    let d = h
        .diagnostics("a.json", "enum violation", |d| {
            has_message(d, "Value is not accepted")
        })
        .await;
    assert_eq!(d[0].range.start.line, 2);
    let good = json.replace("\"mode\": \n", "\"mode\": \"fast\"\n");
    h.change("a.json", vec![full_change(&good)]).await;
    h.diagnostics("a.json", "enum ok", |d| d.is_empty()).await;
    h.hover_until("a.json", before(&good, "\"mode\""), |t| {
        t.contains("Run mode")
    })
    .await;

    // Trailing comma and a comment are errors in plain JSON.
    h.change("a.json", vec![full_change("{\n  // c\n  \"a\": 1,\n}\n")])
        .await;
    let d = h
        .diagnostics("a.json", "json errors", |d| {
            has_message(d, "Comments are not permitted")
        })
        .await;
    assert!(d.iter().any(|d| d.range.start.line == 1));

    h.change("a.json", vec![full_change("{\"a\":1,\"b\":[1,2]}")])
        .await;
    h.diagnostics("a.json", "json now valid", |d| d.is_empty())
        .await;
    h.hover_until_or_none(
        "a.json",
        Position {
            line: 0,
            character: 2,
        },
    )
    .await;
    h.formatting_edits("a.json").await;
    let def = h
        .definition(
            "a.json",
            Position {
                line: 0,
                character: 2,
            },
        )
        .await;
    h.assert_unsupported("definition", def).await;

    // JSONC accepts the same comment, but still flags a missing comma.
    let jsonc = "{\n  // c\n  \"a\": 1\n  \"b\": 2\n}\n";
    h.open("b.jsonc", "jsonc", jsonc).await;
    let d = h
        .diagnostics("b.jsonc", "jsonc missing comma", |d| !d.is_empty())
        .await;
    assert!(
        !has_message(&d, "Comments are not permitted"),
        "jsonc must allow comments: {d:?}"
    );
    assert!(d.iter().any(|d| d.range.start.line >= 2));

    // Unicode: insert emoji + CJK key before the offending token using UTF-16 columns.
    h.open("u.json", "json", "{\"a\": 1 \"b\": 2}\n").await;
    h.change(
        "u.json",
        vec![insert_change(
            Position {
                line: 0,
                character: 1,
            },
            "\"😀日本\": 0, ",
        )],
    )
    .await;
    let text = h.text("u.json").await;
    assert_eq!(text, "{\"😀日本\": 0, \"a\": 1 \"b\": 2}\n");
    let d = h
        .diagnostics("u.json", "unicode missing comma", |d| {
            d.iter()
                .any(|d| d.range.start.line == 0 && d.range.start.character > 5)
        })
        .await;
    // The missing comma error is reported at the second string `"b"`.
    let expected = before(&text, "\"b\"");
    assert!(
        d.iter().any(|d| d.range.start == expected),
        "expected a diagnostic at {expected:?} (UTF-16), got {d:?}"
    );
    assert_ne!(expected.character, text.find("\"b\"").unwrap() as u32);

    // Completion right after the emoji key, positions counted in UTF-16.
    let with_schema = format!("{{\n\"$schema\": \"{schema_uri}\", \"😀日本\": 0, \"mode\": \n}}\n");
    h.change("u.json", vec![full_change(&with_schema)]).await;
    let t = h.text("u.json").await;
    let at = after(&t, "\"mode\": ");
    assert_eq!(at.line, 1);
    let items = h
        .completion_until("u.json", at, |i| labels(i).contains(&"\"slow\""))
        .await;
    assert_eq!(items.len(), 2);
    h.finish().await;
}

impl H {
    /// JSON without a schema has nothing to hover; the request must succeed.
    async fn hover_until_or_none(&self, rel: &str, pos: Position) {
        let got = self.hover(rel, pos).await;
        eprintln!(
            "[evidence] {:?} {rel} hover without schema: {got:?}",
            self.id
        );
        assert!(got.is_ok(), "hover failed: {got:?}");
    }
}

// ---------------------------------------------------------------------------
// rust-analyzer
// ---------------------------------------------------------------------------

#[tokio::test]
async fn rust_analyzer_server() {
    let h = H::start(
        ServerId::RustAnalyzer,
        &[
            (
                "Cargo.toml",
                "[package]\nname = \"smoke\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
            ),
            ("src/main.rs", "fn main() {}\n"),
        ],
    )
    .await;
    let text = "struct Point {\n    field_x: i32,\n}\n\nfn main() {\n    let p = Point { field_x: 1 };\n    p.field_\n}\n";
    h.open("src/main.rs", "rust", text).await;
    assert_eq!(
        std::fs::read_to_string(h.path("src/main.rs")).unwrap(),
        "fn main() {}\n",
        "the buffer must stay unsaved"
    );
    let items = h
        .completion_until("src/main.rs", after(text, "p.field_"), |i| {
            labels(i).contains(&"field_x")
        })
        .await;
    assert!(!items.is_empty());
    h.hover_until("src/main.rs", before(text, "Point {\n"), |t| {
        t.contains("Point")
    })
    .await;
    let def = h
        .definition_until("src/main.rs", before(text, "Point { field_x: 1"), |r| {
            location_lines(r).contains(&0)
        })
        .await;
    assert!(location_uris(&def)[0].ends_with("main.rs"));

    // Syntax diagnostics are what rust-analyzer reliably pushes for an unsaved
    // buffer (semantic ones such as E0583 were not published after didChange in
    // manual probes, and cargo check only sees saved files).
    let wrong = "struct Point {\n    x: i32,\n}\nfn main( {\n    let p = Point { x: 1 };\n}\n";
    h.change("src/main.rs", vec![full_change(wrong)]).await;
    // rust-analyzer can lose the diagnostics of an edit that lands while it primes
    // its caches (publishes [] for the new version, then stays silent until the next
    // change; issue #72). Like an editor, type again: a trailing space leaves line 3
    // and its diagnostic untouched.
    let mut current = wrong.to_string();
    let mut nudges = 0;
    let d = loop {
        if let Some(d) = h
            .diagnostics_within(
                "src/main.rs",
                "syntax error",
                Duration::from_secs(30),
                |d| has_message(d, "Syntax Error"),
            )
            .await
        {
            break d;
        }
        nudges += 1;
        assert!(
            nudges <= 6,
            "no syntax error published after {nudges} nudges"
        );
        eprintln!(
            "[evidence] RustAnalyzer: no syntax error within 30s, nudging with a trailing space"
        );
        current.push(' ');
        h.change("src/main.rs", vec![full_change(&current)]).await;
    };
    assert!(d.iter().any(|d| d.range.start.line == 3));

    h.change(
        "src/main.rs",
        vec![full_change("fn   main( ){let   x=1;\n}\n")],
    )
    .await;
    h.formatting_edits("src/main.rs").await;
    h.finish().await;
}

// ---------------------------------------------------------------------------
// basedpyright
// ---------------------------------------------------------------------------

#[tokio::test]
async fn basedpyright_server() {
    let h = H::start(
        ServerId::Basedpyright,
        &[("pyproject.toml", "[project]\nname = \"smoke\"\n")],
    )
    .await;
    let text = "import os\n\n\ndef greet(name: str) -> str:\n    return name\n\n\nvalue = greet(\"a\")\nos.pa";
    h.open("main.py", "python", text).await;
    assert!(!h.path("main.py").exists());
    let items = h
        .completion_until("main.py", after(text, "os.pa"), |i| {
            labels(i).contains(&"path")
        })
        .await;
    assert!(items.len() > 3);
    h.hover_until("main.py", before(text, "greet(\"a\")"), |t| {
        t.contains("greet")
    })
    .await;
    h.definition_until("main.py", before(text, "greet(\"a\")"), |r| {
        location_lines(r).contains(&3)
    })
    .await;

    let wrong = "count: int = \"text\"\n";
    h.change("main.py", vec![full_change(wrong)]).await;
    let d = h
        .diagnostics("main.py", "pyright type error", |d| {
            d.iter().any(|d| d.message.contains("not assignable"))
        })
        .await;
    assert_eq!(d[0].range.start.line, 0);

    // basedpyright ships no formatter.
    let f = h.formatting("main.py").await;
    h.assert_unsupported("formatting", f).await;
    h.finish().await;
}

// ---------------------------------------------------------------------------
// JDT LS
// ---------------------------------------------------------------------------

const JAVA_OK: &str = "public class Hello {\n    public static void main(String[] args) {\n        String s = \"abc\";\n        s.len\n    }\n}\n";

#[tokio::test]
async fn jdtls_plain_source_file_without_build_files() {
    let h = H::start(
        ServerId::Jdtls,
        &[(
            "Hello.java",
            "public class Hello {\n    public static void main(String[] args) {}\n}\n",
        )],
    )
    .await;
    h.open("Hello.java", "java", JAVA_OK).await;
    let on_disk = std::fs::read_to_string(h.path("Hello.java")).unwrap();
    assert!(!on_disk.contains("s.len"), "the buffer must stay unsaved");
    let items = h
        .completion_until("Hello.java", after(JAVA_OK, "s.len"), |i| {
            i.iter().any(|i| i.label.starts_with("length"))
        })
        .await;
    assert!(!items.is_empty());
    h.hover_until("Hello.java", before(JAVA_OK, "String s"), |t| {
        t.contains("String")
    })
    .await;

    let wrong = "public class Hello {\n    public static void main(String[] args) {\n        int x = \"text\";\n    }\n}\n";
    h.change("Hello.java", vec![full_change(wrong)]).await;
    let d = h
        .diagnostics("Hello.java", "java type mismatch", |d| {
            has_message(d, "Type mismatch")
        })
        .await;
    assert!(d.iter().any(|d| d.range.start.line == 2));

    h.change(
        "Hello.java",
        vec![full_change("public class Hello {\nint   x=1 ;\n}\n")],
    )
    .await;
    h.formatting_edits("Hello.java").await;
    h.finish().await;
}

#[tokio::test]
async fn jdtls_pom_less_project_with_two_files_and_unicode() {
    let helper = "package demo;\n\npublic class Helper {\n    public static int twice(int n) {\n        return n * 2;\n    }\n}\n";
    let h = H::start(
        ServerId::Jdtls,
        &[
            ("src/demo/Helper.java", helper),
            (
                "src/demo/App.java",
                "package demo;\n\npublic class App {\n}\n",
            ),
        ],
    )
    .await;
    h.open("src/demo/Helper.java", "java", helper).await;
    let app = "package demo;\n\npublic class App {\n    int run() {\n        return Helper.twice(2);\n    }\n}\n";
    h.open("src/demo/App.java", "java", app).await;
    let def = h
        .definition_until("src/demo/App.java", before(app, "twice(2)"), |r| {
            location_uris(r).iter().any(|u| u.ends_with("Helper.java"))
        })
        .await;
    assert!(location_lines(&def).contains(&3), "{def:?}");

    // Unicode before the cursor on the same line, applied as an incremental edit.
    h.change(
        "src/demo/App.java",
        vec![insert_change(
            before(app, "return Helper"),
            "String s = \"😀日本\"; int k = 0; k = s",
        )],
    )
    .await;
    let t = h.text("src/demo/App.java").await;
    assert!(t.contains("\"😀日本\"; int k = 0; k = sreturn Helper"));
    let expected = before(&t, "sreturn");
    // Wait for the diagnostic this edit causes: an earlier, unrelated one (the package
    // mismatch) may arrive first and must not satisfy the wait.
    let d = h
        .diagnostics("src/demo/App.java", "unicode java errors", |d| {
            d.iter().any(|d| d.range.start == expected)
        })
        .await;
    let line = 4;
    assert!(
        d.iter().any(|d| d.range.start == expected),
        "expected a diagnostic starting at the UTF-16 position {expected:?}, got {d:?}"
    );
    assert_ne!(
        expected.character as usize,
        t.lines().nth(4).unwrap().find("sreturn").unwrap(),
        "byte and UTF-16 columns differ on this line"
    );
    assert!(d.iter().any(|d| d.range.start.line == line));
    // Every reported column on that line must fit the UTF-16 length of the line.
    let line_len = utf16_len(t.lines().nth(line as usize).unwrap());
    assert!(d
        .iter()
        .filter(|d| d.range.start.line == line)
        .all(|d| d.range.end.character <= line_len));
    h.finish().await;
}
