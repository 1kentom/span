//! Integration tests that drive the REAL desktop language server service against the
//! REAL pinned language servers.
//!
//! Nothing is mocked. The service is built the way the app builds it
//! (`production_with_fetch`: catalog resolver, gated installs, the real `HttpFetch`
//! behind a counting wrapper), and the tests call the same hooks and methods the Tauri
//! commands call: `workspace_changed`, `on_snapshot`, `edit_buffer_delta`,
//! `completion`, `hover`, `definition`, `format`, `restart`, `install`, `status` and
//! `shutdown_blocking`. Events are collected from the service's event sink.
//!
//! Environment:
//! - `SPAN_LSP_TEST_CACHE`: cache root (default `<target dir>/span-lsp-test-cache`),
//!   shared with `crates/lsp/tests/servers_smoke.rs` so nothing downloads twice.
//! - Node.js 18+ on `PATH`, a JDK 25+ (the `javaHome` setting points at the Homebrew
//!   OpenJDK 25 when present, else the resolver searches the host), `rustfmt` for the
//!   Rust formatting check, and network access on the first run. A missing runtime or
//!   network FAILS a test with the service's own message. Nothing is skipped.
//!
//! Tests run one at a time (a process wide lock) so that the process tree of the test
//! binary belongs to exactly one service.

use span_core::{BufferRevision, BufferSnapshot, CoreWorkspace, Settings, TextEdit};
use span_desktop_lib::language_servers::{
    production_with_fetch, CapabilitiesDto, CompletionItemDto, DiagnosticDto, DiagnosticsPublished,
    HoverDto, LanguageServerStateDto, LocationDto, LspErrorDto, LspEvent, LspResponse, LspService,
    PositionDto, RangeDto, ServerStatusDto, ServiceConfig, TextEditDto,
};
use span_desktop_lib::{services, DesktopState};
use span_lsp::servers::install::{BoxFuture, Fetch, FetchError, FetchResponse, HttpFetch};
use span_lsp::servers::ServerId;
use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

/// Cold start of a family: download (first run only), runtime probe, initialize.
const READY_LIMIT: Duration = Duration::from_secs(900);

fn diag_limit(server: ServerId) -> Duration {
    match server {
        ServerId::RustAnalyzer | ServerId::Jdtls => Duration::from_secs(420),
        _ => Duration::from_secs(240),
    }
}

fn request_limit(server: ServerId) -> Duration {
    match server {
        ServerId::RustAnalyzer | ServerId::Jdtls => Duration::from_secs(420),
        _ => Duration::from_secs(120),
    }
}

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn shared_cache() -> PathBuf {
    if let Some(v) = std::env::var_os("SPAN_LSP_TEST_CACHE") {
        return PathBuf::from(v);
    }
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target"));
    target.join("span-lsp-test-cache")
}

// ---------------------------------------------------------------------------
// Counting download source (real HTTP underneath)
// ---------------------------------------------------------------------------

struct CountingFetch {
    inner: HttpFetch,
    count: AtomicUsize,
    urls: StdMutex<Vec<String>>,
}

impl CountingFetch {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: HttpFetch::new().expect("build HTTP client"),
            count: AtomicUsize::new(0),
            urls: StdMutex::new(Vec::new()),
        })
    }

    fn requests(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }
}

impl Fetch for CountingFetch {
    fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<FetchResponse, FetchError>> {
        self.count.fetch_add(1, Ordering::SeqCst);
        self.urls.lock().unwrap().push(url.to_owned());
        self.inner.get(url)
    }
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

fn process_table() -> Vec<(u32, u32, String)> {
    let out = Command::new("ps")
        .args(["-axo", "pid=,ppid=,stat=,comm="])
        .output()
        .expect("run ps");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let row = (
                it.next()?.parse().ok()?,
                it.next()?.parse().ok()?,
                it.next()?.to_string(),
            );
            // The `ps` run that produced this table is itself a child of the test
            // process; it is not a language server.
            let comm = it.collect::<Vec<_>>().join(" ");
            (Path::new(&comm).file_name()? != "ps").then_some(row)
        })
        .collect()
}

/// Live (non zombie) descendants of this test process.
fn live_descendants() -> Vec<u32> {
    let table = process_table();
    let mut found = vec![std::process::id()];
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
        .into_iter()
        .skip(1)
        .filter(|p| {
            table
                .iter()
                .any(|(pid, _, stat)| pid == p && !stat.starts_with('Z'))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Text helpers (positions are UTF-16, as in LSP and CodeMirror)
// ---------------------------------------------------------------------------

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// UTF-16 offset in the whole document of byte offset `at`.
fn offset16(text: &str, at: usize) -> u32 {
    utf16_len(&text[..at])
}

fn pos_at_byte(text: &str, at: usize) -> PositionDto {
    let head = &text[..at];
    let line = head.matches('\n').count() as u32;
    let line_start = head.rfind('\n').map(|i| i + 1).unwrap_or(0);
    PositionDto {
        line,
        character: utf16_len(&head[line_start..]),
    }
}

/// Position just after the first occurrence of `needle`.
fn after(text: &str, needle: &str) -> PositionDto {
    let at = text
        .find(needle)
        .unwrap_or_else(|| panic!("{needle:?} not in text"))
        + needle.len();
    pos_at_byte(text, at)
}

/// Position of the start of the first occurrence of `needle`.
fn before(text: &str, needle: &str) -> PositionDto {
    let at = text
        .find(needle)
        .unwrap_or_else(|| panic!("{needle:?} not in text"));
    pos_at_byte(text, at)
}

fn byte_offset(text: &str, pos: PositionDto) -> usize {
    let mut line_start = 0usize;
    for _ in 0..pos.line {
        line_start += text[line_start..]
            .find('\n')
            .unwrap_or_else(|| panic!("line {} not in text", pos.line))
            + 1;
    }
    let mut units = 0u32;
    for (i, ch) in text[line_start..].char_indices() {
        if units >= pos.character || ch == '\n' {
            return line_start + i;
        }
        units += ch.len_utf16() as u32;
    }
    text.len()
}

fn apply_edits(text: &str, edits: &[TextEditDto]) -> String {
    let mut spans: Vec<(usize, usize, &str)> = edits
        .iter()
        .map(|e| {
            (
                byte_offset(text, e.range.start),
                byte_offset(text, e.range.end),
                e.new_text.as_str(),
            )
        })
        .collect();
    spans.sort_by_key(|s| std::cmp::Reverse(s.0));
    let mut out = text.to_owned();
    for (from, to, insert) in spans {
        out.replace_range(from..to, insert);
    }
    out
}

fn labels(items: &[CompletionItemDto]) -> Vec<&str> {
    items.iter().map(|i| i.label.as_str()).collect()
}

fn describe(d: &[DiagnosticDto]) -> Vec<String> {
    d.iter()
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
        .collect()
}

/// Whether a published diagnostics event belongs to buffer revision `revision`. A
/// server that reports a document version must map back to exactly that revision.
/// Some servers (the JSON server among them) omit `version`; then the event carries
/// neither version nor revision and the caller's range assertions prove freshness.
fn fresh(d: &DiagnosticsPublished, revision: u64) -> bool {
    match d.version {
        Some(_) => d.revision == Some(revision),
        None => d.revision.is_none(),
    }
}

fn has_message(d: &[DiagnosticDto], needle: &str) -> bool {
    d.iter().any(|d| d.message.contains(needle))
}

/// After inserting `delta` UTF-16 units at column `insert_col` of line 0, every old
/// diagnostic that started at or after that column must reappear shifted by exactly
/// `delta` (not by the byte length of the inserted text).
fn assert_shifted(old: &[DiagnosticDto], new: &[DiagnosticDto], insert_col: u32, delta: u32) {
    let mut checked = 0;
    for o in old
        .iter()
        .filter(|d| d.range.start.line == 0 && d.range.start.character >= insert_col)
    {
        checked += 1;
        let want = o.range.start.character + delta;
        assert!(
            new.iter().any(|n| n.message == o.message
                && n.range.start.line == 0
                && n.range.start.character == want),
            "diagnostic {:?} should have moved from column {} to {want} (UTF-16); new set: {:?}",
            o.message,
            o.range.start.character,
            describe(new)
        );
    }
    assert!(
        checked > 0,
        "no diagnostic after the edit: {:?}",
        describe(old)
    );
}

// ---------------------------------------------------------------------------
// Environment: workspace + the real service
// ---------------------------------------------------------------------------

struct Env {
    _guard: tokio::sync::MutexGuard<'static, ()>,
    _dir: tempfile::TempDir,
    root: PathBuf,
    ws: Arc<StdMutex<CoreWorkspace>>,
    svc: LspService,
    events: Arc<StdMutex<Vec<LspEvent>>>,
    fetch: Arc<CountingFetch>,
    baseline: HashSet<u32>,
    settings: Settings,
    shut: bool,
}

struct EnvOptions {
    cache: PathBuf,
    auto_install: bool,
    java_home: Option<String>,
}

impl EnvOptions {
    fn shared() -> Self {
        let java = Path::new("/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home");
        Self {
            cache: shared_cache(),
            auto_install: true,
            java_home: java.exists().then(|| java.to_string_lossy().into_owned()),
        }
    }
}

fn make_settings(o: &EnvOptions) -> Settings {
    let mut settings = Settings::default();
    settings.language_servers.auto_install = o.auto_install;
    settings.language_servers.java_home = o.java_home.clone();
    settings
}

impl Env {
    async fn start(files: &[(&str, &str)]) -> Env {
        Self::start_with(files, EnvOptions::shared()).await
    }

    async fn start_with(files: &[(&str, &str)], options: EnvOptions) -> Env {
        let guard = SERIAL.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let project = std::fs::canonicalize(dir.path()).unwrap().join("project");
        std::fs::create_dir_all(&project).unwrap();
        for (rel, text) in files {
            let p = project.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        std::fs::create_dir_all(&options.cache).unwrap();
        let ws = CoreWorkspace::open(&project)
            .unwrap()
            .with_user_settings(None);
        let root = PathBuf::from(ws.workspace().root);
        let events: Arc<StdMutex<Vec<LspEvent>>> = Arc::default();
        let sink_events = events.clone();
        let fetch = CountingFetch::new();
        let baseline: HashSet<u32> = live_descendants().into_iter().collect();
        let svc = production_with_fetch(
            options.cache.clone(),
            fetch.clone(),
            Arc::new(move |e| sink_events.lock().unwrap().push(e)),
            ServiceConfig::default(),
        );
        let settings = make_settings(&options);
        svc.workspace_changed(root.clone(), &settings);
        Env {
            _guard: guard,
            _dir: dir,
            root,
            ws: Arc::new(StdMutex::new(ws)),
            svc,
            events,
            fetch,
            baseline,
            settings,
            shut: false,
        }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    fn disk(&self, rel: &str) -> String {
        std::fs::read_to_string(self.path(rel)).unwrap()
    }

    // --- buffer hooks, exactly as the commands call them -------------------

    fn open(&self, rel: &str) -> BufferSnapshot {
        let mut ws = self.ws.lock().unwrap();
        let snapshot = ws.open_buffer(rel).unwrap();
        self.svc.on_snapshot(&snapshot);
        snapshot
    }

    fn snapshot(&self, rel: &str) -> BufferSnapshot {
        self.ws.lock().unwrap().buffer_snapshot(rel).unwrap()
    }

    fn edit(&self, rel: &str, from: u32, to: u32, insert: &str) -> BufferRevision {
        let mut ws = self.ws.lock().unwrap();
        let revision = ws.buffer_snapshot(rel).unwrap().revision;
        self.svc
            .edit_buffer_delta(
                &mut ws,
                rel,
                revision,
                vec![TextEdit {
                    from,
                    to,
                    insert: insert.into(),
                }],
            )
            .unwrap()
    }

    /// Replace the whole buffer text (an unsaved draft).
    fn replace(&self, rel: &str, text: &str) -> BufferRevision {
        let old = self.snapshot(rel).text;
        self.edit(rel, 0, utf16_len(&old), text)
    }

    /// Insert at a UTF-16 offset of the whole document.
    fn insert(&self, rel: &str, at: u32, text: &str) -> BufferRevision {
        self.edit(rel, at, at, text)
    }

    // --- events -------------------------------------------------------------

    fn mark(&self) -> usize {
        self.events.lock().unwrap().len()
    }

    fn event_dump(&self) -> String {
        let events = self.events.lock().unwrap();
        let mut lines = Vec::new();
        for e in events.iter() {
            match e {
                LspEvent::Diagnostics(d) => lines.push(format!(
                    "diagnostics {} v{:?} rev{:?} {:?}",
                    d.path,
                    d.version,
                    d.revision,
                    describe(&d.diagnostics)
                )),
                LspEvent::State(s) => lines.push(format!("state {:?} {:?}", s.server, s.state)),
                LspEvent::Error(x) => lines.push(format!("ERROR {:?}: {}", x.server, x.message)),
                LspEvent::Install(i) => {
                    if i.phase != span_desktop_lib::language_servers::InstallPhase::Downloading {
                        lines.push(format!("install {:?} {:?}", i.server, i.phase));
                    }
                }
            }
        }
        lines.join("\n  ")
    }

    fn errors(&self) -> Vec<String> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                LspEvent::Error(x) => Some(format!("{:?}: {}", x.server, x.message)),
                _ => None,
            })
            .collect()
    }

    /// Waits for a `DiagnosticsPublished` event for `rel`, after event index `from`,
    /// that satisfies `pred`.
    async fn diagnostics(
        &self,
        server: ServerId,
        rel: &str,
        from: usize,
        what: &str,
        pred: impl Fn(&DiagnosticsPublished) -> bool,
    ) -> DiagnosticsPublished {
        match self
            .try_diagnostics(server, rel, from, what, diag_limit(server), pred)
            .await
        {
            Some(d) => d,
            None => panic!(
                "{server:?}: no matching DiagnosticsPublished for {rel} ({what}) within {:?}. events:\n  {}",
                diag_limit(server),
                self.event_dump()
            ),
        }
    }

    /// Waits up to `limit` for a matching publish after event index `from`.
    async fn try_diagnostics(
        &self,
        server: ServerId,
        rel: &str,
        from: usize,
        what: &str,
        limit: Duration,
        pred: impl Fn(&DiagnosticsPublished) -> bool,
    ) -> Option<DiagnosticsPublished> {
        let deadline = Instant::now() + limit;
        loop {
            {
                let events = self.events.lock().unwrap();
                for e in events.iter().skip(from) {
                    if let LspEvent::Diagnostics(d) = e {
                        if d.path == rel && pred(d) {
                            eprintln!(
                                "[evidence] {server:?} {rel} diagnostics ({what}): version {:?} revision {:?} {:?}",
                                d.version,
                                d.revision,
                                describe(&d.diagnostics)
                            );
                            return Some(d.clone());
                        }
                    }
                }
            }
            if Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Syntax error diagnostics for the buffer after `edit` (issue #72).
    ///
    /// rust-analyzer can lose the diagnostics of an edit that lands while it is
    /// (re)priming its caches: it publishes an empty list for the new version and
    /// never recomputes until the document changes again (protocol traces from CI:
    /// the edit arrived 70 ms after the previous publish, cachePriming was cancelled
    /// and restarted, an empty publish for the new version followed, then silence).
    /// An editor recovers on the next keystroke, so this does the same: when no
    /// fresh syntax error arrives within `SETTLE`, append a space after the final
    /// newline (which leaves line 0 and its diagnostics untouched) and wait for
    /// that revision instead. The assertions on the result are unchanged.
    async fn syntax_diagnostics_after(
        &self,
        server: ServerId,
        rel: &str,
        what: &str,
        mark: usize,
        edit: BufferRevision,
    ) -> DiagnosticsPublished {
        const SETTLE: Duration = Duration::from_secs(30);
        const NUDGES: usize = 6;
        let mut mark = mark;
        let mut revision = edit.revision;
        for attempt in 0..=NUDGES {
            let found = self
                .try_diagnostics(server, rel, mark, what, SETTLE, |d| {
                    fresh(d, revision) && has_message(&d.diagnostics, "Syntax Error")
                })
                .await;
            if let Some(d) = found {
                return d;
            }
            if attempt == NUDGES {
                break;
            }
            eprintln!(
                "[evidence] {server:?} {rel} ({what}): no syntax error for revision {revision} within {SETTLE:?}, nudging with a trailing space"
            );
            mark = self.mark();
            let end = utf16_len(&self.snapshot(rel).text);
            revision = self.insert(rel, end, " ").revision;
        }
        panic!(
            "{server:?}: no matching DiagnosticsPublished for {rel} ({what}) after {NUDGES} nudges. events:\n  {}",
            self.event_dump()
        );
    }

    // --- status ---------------------------------------------------------------

    async fn rows(&self, server: ServerId) -> Vec<ServerStatusDto> {
        let wanted: span_desktop_lib::language_servers::LanguageServerId = server.into();
        self.svc
            .status()
            .await
            .into_iter()
            .filter(|r| r.server == wanted)
            .collect()
    }

    async fn ready_row(&self, server: ServerId) -> Option<ServerStatusDto> {
        self.rows(server)
            .await
            .into_iter()
            .find(|r| r.state == LanguageServerStateDto::Ready && r.root.is_some())
    }

    /// Waits until the server is `Ready` for some root, failing fast with the
    /// service's own reason when it can never start.
    async fn wait_ready(&self, server: ServerId) -> ServerStatusDto {
        let deadline = Instant::now() + READY_LIMIT;
        loop {
            for row in self.rows(server).await {
                match &row.state {
                    LanguageServerStateDto::Ready if row.root.is_some() => {
                        eprintln!(
                            "[evidence] {server:?} Ready, root {:?}, version {}, epoch {}, installed {}, capabilities {:?}",
                            row.root, row.version, row.epoch, row.installed, row.capabilities
                        );
                        return row;
                    }
                    LanguageServerStateDto::StartFailed { .. }
                    | LanguageServerStateDto::RuntimeMissing { .. }
                    | LanguageServerStateDto::InstallFailed { .. }
                    | LanguageServerStateDto::NeedsInstall { .. }
                    | LanguageServerStateDto::Crashed => panic!(
                        "{server:?} cannot become ready (missing runtime, no network or server failure): {:?}. events:\n  {}",
                        row.state,
                        self.event_dump()
                    ),
                    _ => {}
                }
            }
            assert!(
                Instant::now() < deadline,
                "{server:?} not Ready within {READY_LIMIT:?}. events:\n  {}",
                self.event_dump()
            );
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    // --- retrying requests ----------------------------------------------------

    /// Repeats `f` while the service says "not ready" or "stale", up to the family limit.
    async fn settle<T, F, Fut>(
        &self,
        server: ServerId,
        what: &str,
        mut f: F,
    ) -> Result<T, LspErrorDto>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<T, LspErrorDto>>,
    {
        let deadline = Instant::now() + request_limit(server);
        loop {
            match f().await {
                Err(LspErrorDto::NotReady { .. }) | Err(LspErrorDto::Stale)
                    if Instant::now() < deadline =>
                {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                Err(e @ (LspErrorDto::NotReady { .. } | LspErrorDto::Stale)) => {
                    panic!(
                        "{server:?}: {what} never settled: {e:?}. events:\n  {}",
                        self.event_dump()
                    )
                }
                other => return other,
            }
        }
    }

    async fn completion_until(
        &self,
        server: ServerId,
        rel: &str,
        pos: PositionDto,
        pred: impl Fn(&[CompletionItemDto]) -> bool,
    ) -> LspResponse<span_desktop_lib::language_servers::CompletionListDto> {
        let deadline = Instant::now() + request_limit(server);
        let mut last;
        loop {
            match self.svc.completion(rel, pos, None, None).await {
                Ok(r) => {
                    if pred(&r.data.items) {
                        let l = labels(&r.data.items);
                        eprintln!(
                            "[evidence] {server:?} {rel} completion at {}:{}: {} items (revision {}, epoch {}), first {:?}",
                            pos.line,
                            pos.character,
                            r.data.items.len(),
                            r.revision,
                            r.epoch,
                            &l[..l.len().min(8)]
                        );
                        return r;
                    }
                    last = format!("{} items: {:?}", r.data.items.len(), labels(&r.data.items));
                }
                Err(e @ (LspErrorDto::Unsupported { .. } | LspErrorDto::ServerCrashed { .. })) => {
                    panic!("{server:?}: completion failed: {e:?}")
                }
                Err(e) => last = format!("error {e:?}"),
            }
            assert!(
                Instant::now() < deadline,
                "{server:?}: completion for {rel} never satisfied the check; last = {last}. events:\n  {}",
                self.event_dump()
            );
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn hover_until(
        &self,
        server: ServerId,
        rel: &str,
        pos: PositionDto,
        pred: impl Fn(&str) -> bool,
    ) -> HoverDto {
        let deadline = Instant::now() + request_limit(server);
        let mut last;
        loop {
            match self.svc.hover(rel, pos, None).await {
                Ok(r) => match r.data {
                    Some(h) if pred(&h.markdown) => {
                        eprintln!(
                            "[evidence] {server:?} {rel} hover: {:?}",
                            h.markdown.chars().take(100).collect::<String>()
                        );
                        return h;
                    }
                    Some(h) => last = format!("text {:?}", h.markdown),
                    None => last = "none".into(),
                },
                Err(e @ LspErrorDto::Unsupported { .. }) => {
                    panic!("{server:?}: hover failed: {e:?}")
                }
                Err(e) => last = format!("error {e:?}"),
            }
            assert!(
                Instant::now() < deadline,
                "{server:?}: hover never matched; last = {last}"
            );
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn definition_until(
        &self,
        server: ServerId,
        rel: &str,
        pos: PositionDto,
        pred: impl Fn(&[LocationDto]) -> bool,
    ) -> Vec<LocationDto> {
        let deadline = Instant::now() + request_limit(server);
        let mut last;
        loop {
            match self.svc.definition(rel, pos, None).await {
                Ok(r) => {
                    if pred(&r.data) {
                        eprintln!(
                            "[evidence] {server:?} {rel} definition: {:?}",
                            r.data
                                .iter()
                                .map(|l| (l.path.clone(), l.range.start.line))
                                .collect::<Vec<_>>()
                        );
                        return r.data;
                    }
                    last = format!("{:?}", r.data);
                }
                Err(e @ LspErrorDto::Unsupported { .. }) => {
                    panic!("{server:?}: definition failed: {e:?}")
                }
                Err(e) => last = format!("error {e:?}"),
            }
            assert!(
                Instant::now() < deadline,
                "{server:?}: definition never matched; last = {last}"
            );
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    /// Format edits for the whole document. Asserts that the buffer (text and
    /// revision) is untouched afterwards, and returns the edits.
    async fn format_edits(&self, server: ServerId, rel: &str) -> Vec<TextEditDto> {
        let before = self.snapshot(rel);
        let r = self
            .settle(server, "format", || self.svc.format(rel, None, None))
            .await
            .unwrap_or_else(|e| panic!("{server:?}: format failed: {e:?}"));
        assert_eq!(r.revision, before.revision, "format reply revision stamp");
        let after_snapshot = self.snapshot(rel);
        assert_eq!(
            after_snapshot.text, before.text,
            "format must not modify the buffer"
        );
        assert_eq!(after_snapshot.revision, before.revision);
        eprintln!(
            "[evidence] {server:?} {rel} format: {} edits {:?}",
            r.data.len(),
            r.data
                .iter()
                .take(2)
                .map(|e| e.new_text.chars().take(30).collect::<String>())
                .collect::<Vec<_>>()
        );
        r.data
    }

    /// The capability flags that `lsp_status` reports must match what actually works:
    /// a flag that is false means `Unsupported`, a flag that is true means it is not.
    async fn assert_capabilities(
        &self,
        server: ServerId,
        rel: &str,
        hover_pos: PositionDto,
        def_pos: PositionDto,
    ) -> CapabilitiesDto {
        let row = self.ready_row(server).await.expect("server is ready");
        let caps = row.capabilities.expect("a Ready row carries capabilities");
        assert!(caps.completion, "{server:?} must advertise completion");
        let range = RangeDto {
            start: PositionDto {
                line: 0,
                character: 0,
            },
            end: pos_at_byte(&self.snapshot(rel).text, 0),
        };
        let hover = self
            .settle(server, "hover", || self.svc.hover(rel, hover_pos, None))
            .await;
        let def = self
            .settle(server, "definition", || {
                self.svc.definition(rel, def_pos, None)
            })
            .await;
        let fmt = self
            .settle(server, "format", || self.svc.format(rel, None, None))
            .await;
        let rfmt = self
            .settle(server, "range format", || {
                self.svc.format(rel, Some(range), None)
            })
            .await;
        for (name, flag, outcome) in [
            ("hover", caps.hover, hover.map(|_| ())),
            ("definition", caps.definition, def.map(|_| ())),
            ("formatting", caps.formatting, fmt.map(|_| ())),
            ("rangeFormatting", caps.range_formatting, rfmt.map(|_| ())),
        ] {
            if flag {
                assert!(
                    !matches!(outcome, Err(LspErrorDto::Unsupported { .. })),
                    "{server:?}: {name} is advertised but the service says {outcome:?}"
                );
                assert!(
                    outcome.is_ok(),
                    "{server:?}: {name} is advertised but failed: {outcome:?}"
                );
            } else {
                assert!(
                    matches!(outcome, Err(LspErrorDto::Unsupported { .. })),
                    "{server:?}: {name} is not advertised, expected Unsupported, got {outcome:?}"
                );
            }
        }
        eprintln!("[evidence] {server:?} capability flags match behaviour: {caps:?}");
        caps
    }

    // --- processes ------------------------------------------------------------

    fn server_pids(&self) -> Vec<u32> {
        live_descendants()
            .into_iter()
            .filter(|p| !self.baseline.contains(p))
            .collect()
    }

    async fn wait_gone(&self, what: &str, pids: &[u32]) {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let table = process_table();
            let alive: Vec<u32> = pids
                .iter()
                .copied()
                .filter(|p| {
                    table
                        .iter()
                        .any(|(pid, _, stat)| pid == p && !stat.starts_with('Z'))
                })
                .collect();
            if alive.is_empty() {
                eprintln!("[evidence] {what}: pids {pids:?} are gone");
                return;
            }
            if Instant::now() > deadline {
                for p in &alive {
                    let _ = Command::new("kill").args(["-9", &p.to_string()]).status();
                }
                panic!("{what}: processes still alive: {alive:?}");
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// App exit path: `shutdown_blocking`, then no child of the test process is left.
    async fn exit_and_assert_clean(&mut self) {
        let tree = self.server_pids();
        self.shutdown();
        self.wait_gone("app exit shutdown", &tree).await;
        let rest = self.server_pids();
        assert!(rest.is_empty(), "children left after app exit: {rest:?}");
        eprintln!("[evidence] app exit: server tree {tree:?} gone, no children left");
    }

    fn shutdown(&mut self) {
        self.shut = true;
        let svc = self.svc.clone();
        std::thread::spawn(move || svc.shutdown_blocking(Duration::from_secs(60)))
            .join()
            .unwrap();
    }

    /// End of a family test: no background error events, then app exit leaves nothing.
    async fn finish(&mut self) {
        let errors = self.errors();
        assert!(
            errors.is_empty(),
            "LanguageServerError events: {errors:?}\nevents:\n  {}",
            self.event_dump()
        );
        self.exit_and_assert_clean().await;
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        if !self.shut {
            let svc = self.svc.clone();
            let _ =
                std::thread::spawn(move || svc.shutdown_blocking(Duration::from_secs(30))).join();
        }
    }
}

fn path_uri(p: &Path) -> String {
    span_lsp::path_to_uri(p).unwrap().to_string()
}

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn json_family() {
    let id = ServerId::Json;
    let schema = r#"{"type":"object","properties":{"mode":{"enum":["fast","slow"],"description":"Run mode"},"flag":{"type":"boolean"}}}"#;
    let mut env = Env::start(&[
        ("package.json", "{}"),
        ("schema.json", schema),
        ("a.json", "{}\n"),
    ])
    .await;
    let schema_uri = path_uri(&env.path("schema.json"));

    env.open("a.json");
    // Unsaved draft: the text exists only in the app buffer.
    let draft = format!("{{\n  \"$schema\": \"{schema_uri}\",\n  \"mode\": \n}}\n");
    let rev = env.replace("a.json", &draft);
    assert_eq!(env.disk("a.json"), "{}\n", "the draft must stay unsaved");
    env.wait_ready(id).await;

    let r = env
        .completion_until(id, "a.json", after(&draft, "\"mode\": "), |i| {
            labels(i).contains(&"\"fast\"")
        })
        .await;
    assert_eq!(r.revision, rev.revision);
    assert_eq!(r.data.items.len(), 2, "{:?}", labels(&r.data.items));

    // Diagnostics for an enum violation on a line that also holds a string we then
    // extend with emoji and CJK.
    let one_line = format!("{{\"$schema\": \"{schema_uri}\", \"s\": \"\", \"mode\": \"other\"}}\n");
    let mark = env.mark();
    let rev1 = env.replace("a.json", &one_line);
    let d1 = env
        .diagnostics(id, "a.json", mark, "enum violation", |d| {
            fresh(d, rev1.revision) && has_message(&d.diagnostics, "Value is not accepted")
        })
        .await;
    let want1 = before(&one_line, "\"other\"");
    assert_eq!(d1.diagnostics[0].range.start, want1);

    let insert_at = one_line.find("\"s\": \"").unwrap() + "\"s\": \"".len();
    let insert_col = pos_at_byte(&one_line, insert_at).character;
    let mark = env.mark();
    let rev2 = env.insert("a.json", offset16(&one_line, insert_at), "😀日本");
    assert_eq!(rev2.revision, rev1.revision + 1);
    let text2 = env.snapshot("a.json").text;
    let d2 = env
        .diagnostics(
            id,
            "a.json",
            mark,
            "enum violation after unicode edit",
            |d| fresh(d, rev2.revision) && has_message(&d.diagnostics, "Value is not accepted"),
        )
        .await;
    let want2 = before(&text2, "\"other\"");
    assert_eq!(d2.diagnostics[0].range.start, want2);
    assert_shifted(&d1.diagnostics, &d2.diagnostics, insert_col, 4);
    let byte_col = text2[..text2.find("\"other\"").unwrap()].len() as u32;
    assert_ne!(byte_col, want2.character, "byte and UTF-16 columns differ");

    // Hover is advertised: schema description appears.
    env.hover_until(id, "a.json", before(&text2, "\"mode\""), |t| {
        t.contains("Run mode")
    })
    .await;
    env.assert_capabilities(
        id,
        "a.json",
        before(&text2, "\"mode\""),
        before(&text2, "\"mode\""),
    )
    .await;

    // Format returns edits without touching the buffer; applying them formats.
    let ugly = "{\"a\":1,\n\"b\":[1,2]}";
    env.replace("a.json", ugly);
    let edits = env.format_edits(id, "a.json").await;
    assert!(!edits.is_empty());
    let formatted = apply_edits(ugly, &edits);
    assert_ne!(formatted, ugly);
    assert!(formatted.contains("\"a\": 1"), "{formatted:?}");
    assert_eq!(env.disk("a.json"), "{}\n");

    env.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn css_family() {
    let id = ServerId::Css;
    let mut env = Env::start(&[("package.json", "{}"), ("a.css", "a {}\n")]).await;
    env.open("a.css");
    let css = "a {\n  col\n}\n";
    env.replace("a.css", css);
    assert_eq!(env.disk("a.css"), "a {}\n");
    env.wait_ready(id).await;
    let r = env
        .completion_until(id, "a.css", after(css, "  col"), |i| {
            labels(i).contains(&"color")
        })
        .await;
    assert!(r.data.items.len() > 10);

    let ok = "a {\n  color: red;\n}\n";
    env.replace("a.css", ok);
    env.hover_until(id, "a.css", after(ok, "  col"), |t| !t.is_empty())
        .await;
    env.assert_capabilities(id, "a.css", after(ok, "  col"), after(ok, "  col"))
        .await;

    let one_line = "a::after { content: \"\"; colr: red; }\n";
    let mark = env.mark();
    let rev1 = env.replace("a.css", one_line);
    let d1 = env
        .diagnostics(id, "a.css", mark, "unknown property", |d| {
            fresh(d, rev1.revision) && has_message(&d.diagnostics, "Unknown property: 'colr'")
        })
        .await;
    assert_eq!(d1.diagnostics[0].range.start, before(one_line, "colr"));

    let at = one_line.find("\"\"").unwrap() + 1;
    let insert_col = pos_at_byte(one_line, at).character;
    let mark = env.mark();
    let rev2 = env.insert("a.css", offset16(one_line, at), "😀日本");
    let text2 = env.snapshot("a.css").text;
    let d2 = env
        .diagnostics(id, "a.css", mark, "unknown property after unicode", |d| {
            fresh(d, rev2.revision) && has_message(&d.diagnostics, "Unknown property: 'colr'")
        })
        .await;
    assert_eq!(d2.diagnostics[0].range.start, before(&text2, "colr"));
    assert_shifted(&d1.diagnostics, &d2.diagnostics, insert_col, 4);

    let ugly = "a{color:red;\nbackground:blue}\n";
    env.replace("a.css", ugly);
    let edits = env.format_edits(id, "a.css").await;
    assert!(!edits.is_empty());
    assert_ne!(apply_edits(ugly, &edits), ugly);

    env.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn html_family() {
    let id = ServerId::Html;
    let mut env = Env::start(&[("package.json", "{}"), ("a.html", "<p></p>\n")]).await;
    env.open("a.html");
    let html = "<!DOCTYPE html>\n<html>\n<body>\n<div cla\n</body>\n</html>\n";
    env.replace("a.html", html);
    assert_eq!(env.disk("a.html"), "<p></p>\n");
    env.wait_ready(id).await;
    let r = env
        .completion_until(id, "a.html", after(html, "<div cla"), |i| {
            labels(i).contains(&"class")
        })
        .await;
    assert!(r.data.items.len() > 5);
    let ok = "<!DOCTYPE html>\n<html>\n<body>\n<div class=\"a\">x</div>\n</body>\n</html>\n";
    env.replace("a.html", ok);
    env.hover_until(id, "a.html", after(ok, "<di"), |t| !t.is_empty())
        .await;
    env.assert_capabilities(id, "a.html", after(ok, "<di"), after(ok, "<di"))
        .await;
    // The HTML server publishes no diagnostics for plain markup, so this family has
    // no diagnostic assertion (documented gap, not a skip).
    env.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn typescript_family() {
    let id = ServerId::Vtsls;
    let mut env = Env::start(&[
        (
            "tsconfig.json",
            r#"{"compilerOptions":{"strict":true,"target":"es2020"}}"#,
        ),
        ("a.ts", "export {};\n"),
    ])
    .await;
    env.open("a.ts");
    let ts = "const count = 41;\nconst total = count + 1;\ncount.toF";
    env.replace("a.ts", ts);
    assert_eq!(env.disk("a.ts"), "export {};\n");
    env.wait_ready(id).await;
    let r = env
        .completion_until(id, "a.ts", after(ts, "count.toF"), |i| {
            labels(i).contains(&"toFixed")
        })
        .await;
    assert!(r.data.items.len() > 3);
    env.hover_until(id, "a.ts", before(ts, "total"), |t| t.contains("number"))
        .await;
    let def = env
        .definition_until(id, "a.ts", before(ts, "count + 1"), |l| {
            l.iter().any(|l| l.range.start.line == 0)
        })
        .await;
    assert!(def[0].path.ends_with("a.ts"), "{:?}", def[0].path);
    env.assert_capabilities(id, "a.ts", before(ts, "total"), before(ts, "count + 1"))
        .await;

    let one_line = "const s = \"\", n: number = \"x\";\n";
    let mark = env.mark();
    let rev1 = env.replace("a.ts", one_line);
    let d1 = env
        .diagnostics(id, "a.ts", mark, "type error", |d| {
            fresh(d, rev1.revision)
                && d.diagnostics
                    .iter()
                    .any(|x| x.code.as_deref() == Some("2322"))
        })
        .await;
    let at = one_line.find("\"\"").unwrap() + 1;
    let insert_col = pos_at_byte(one_line, at).character;
    let mark = env.mark();
    let rev2 = env.insert("a.ts", offset16(one_line, at), "😀日本");
    let text2 = env.snapshot("a.ts").text;
    assert_eq!(text2, "const s = \"😀日本\", n: number = \"x\";\n");
    let d2 = env
        .diagnostics(id, "a.ts", mark, "type error after unicode", |d| {
            fresh(d, rev2.revision)
                && d.diagnostics
                    .iter()
                    .any(|x| x.code.as_deref() == Some("2322"))
        })
        .await;
    let got = d2
        .diagnostics
        .iter()
        .find(|x| x.code.as_deref() == Some("2322"))
        .unwrap();
    assert_eq!(got.range.start, before(&text2, "n: number"));
    assert_shifted(&d1.diagnostics, &d2.diagnostics, insert_col, 4);
    assert_ne!(
        text2[..text2.find("n: number").unwrap()].len() as u32,
        got.range.start.character
    );

    let ugly = "const   spaced   =  1 ;\nfunction f( a:number ){return a}\n";
    env.replace("a.ts", ugly);
    let edits = env.format_edits(id, "a.ts").await;
    assert!(!edits.is_empty());
    assert_ne!(apply_edits(ugly, &edits), ugly);

    env.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn python_family() {
    let id = ServerId::Basedpyright;
    let mut env = Env::start(&[
        ("pyproject.toml", "[project]\nname = \"demo\"\n"),
        ("main.py", "pass\n"),
    ])
    .await;
    env.open("main.py");
    let py = "import os\n\n\ndef greet(name: str) -> str:\n    return name\n\n\nvalue = greet(\"a\")\nos.pa";
    env.replace("main.py", py);
    assert_eq!(env.disk("main.py"), "pass\n");
    env.wait_ready(id).await;
    let r = env
        .completion_until(id, "main.py", after(py, "os.pa"), |i| {
            labels(i).contains(&"path")
        })
        .await;
    assert!(r.data.items.len() > 3);
    env.hover_until(id, "main.py", before(py, "greet(\"a\")"), |t| {
        t.contains("greet")
    })
    .await;
    let def = env
        .definition_until(id, "main.py", before(py, "greet(\"a\")"), |l| {
            l.iter().any(|l| l.range.start.line == 3)
        })
        .await;
    assert!(def[0].path.ends_with("main.py"));
    let caps = env
        .assert_capabilities(
            id,
            "main.py",
            before(py, "greet(\"a\")"),
            before(py, "greet(\"a\")"),
        )
        .await;
    assert!(!caps.formatting, "basedpyright ships no formatter");

    let one_line = "s = \"\"; count: int = \"text\"\n";
    let mark = env.mark();
    let rev1 = env.replace("main.py", one_line);
    let d1 = env
        .diagnostics(id, "main.py", mark, "type error", |d| {
            fresh(d, rev1.revision) && has_message(&d.diagnostics, "not assignable")
        })
        .await;
    assert_eq!(d1.diagnostics[0].range.start, before(one_line, "\"text\""));
    let at = one_line.find("\"\"").unwrap() + 1;
    let insert_col = pos_at_byte(one_line, at).character;
    let mark = env.mark();
    let rev2 = env.insert("main.py", offset16(one_line, at), "😀日本");
    let text2 = env.snapshot("main.py").text;
    let d2 = env
        .diagnostics(id, "main.py", mark, "type error after unicode", |d| {
            fresh(d, rev2.revision) && has_message(&d.diagnostics, "not assignable")
        })
        .await;
    assert_eq!(d2.diagnostics[0].range.start, before(&text2, "\"text\""));
    assert_shifted(&d1.diagnostics, &d2.diagnostics, insert_col, 4);

    // Format on a server without a formatter is a typed Unsupported.
    let f = env.svc.format("main.py", None, None).await;
    assert!(
        matches!(f, Err(LspErrorDto::Unsupported { .. })),
        "format: {f:?}"
    );
    env.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rust_family() {
    let id = ServerId::RustAnalyzer;
    let mut env = Env::start(&[
        (
            "Cargo.toml",
            "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        ),
        ("src/main.rs", "fn main() {}\n"),
    ])
    .await;
    env.open("src/main.rs");
    let rs = "struct Point {\n    field_x: i32,\n}\n\nfn main() {\n    let p = Point { field_x: 1 };\n    p.field_\n}\n";
    env.replace("src/main.rs", rs);
    assert_eq!(env.disk("src/main.rs"), "fn main() {}\n");
    env.wait_ready(id).await;
    let r = env
        .completion_until(id, "src/main.rs", after(rs, "p.field_"), |i| {
            labels(i).contains(&"field_x")
        })
        .await;
    assert!(!r.data.items.is_empty());
    env.hover_until(id, "src/main.rs", before(rs, "Point {\n"), |t| {
        t.contains("Point")
    })
    .await;
    let def = env
        .definition_until(id, "src/main.rs", before(rs, "Point { field_x: 1"), |l| {
            l.iter().any(|l| l.range.start.line == 0)
        })
        .await;
    assert!(def[0].path.ends_with("main.rs"));
    env.assert_capabilities(
        id,
        "src/main.rs",
        before(rs, "Point {\n"),
        before(rs, "Point { field_x: 1"),
    )
    .await;

    let one_line = "fn main() { let s = \"\"; let x = ; }\n";
    let mark = env.mark();
    let rev1 = env.replace("src/main.rs", one_line);
    let d1 = env
        .syntax_diagnostics_after(id, "src/main.rs", "syntax error", mark, rev1)
        .await;
    assert!(d1.diagnostics.iter().all(|x| x.range.start.line == 0));
    let at = one_line.find("\"\"").unwrap() + 1;
    let insert_col = pos_at_byte(one_line, at).character;
    let mark = env.mark();
    let rev2 = env.insert("src/main.rs", offset16(one_line, at), "😀日本");
    let d2 = env
        .syntax_diagnostics_after(id, "src/main.rs", "syntax error after unicode", mark, rev2)
        .await;
    assert_shifted(&d1.diagnostics, &d2.diagnostics, insert_col, 4);

    let ugly = "fn   main( ){let   x=1;\n}\n";
    env.replace("src/main.rs", ugly);
    let edits = env.format_edits(id, "src/main.rs").await;
    assert!(!edits.is_empty());
    assert_ne!(apply_edits(ugly, &edits), ugly);

    env.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn java_family() {
    let id = ServerId::Jdtls;
    let mut env = Env::start(&[(
        "Hello.java",
        "public class Hello {\n    public static void main(String[] args) {}\n}\n",
    )])
    .await;
    let disk = env.disk("Hello.java");
    env.open("Hello.java");
    let java = "public class Hello {\n    public static void main(String[] args) {\n        String s = \"abc\";\n        s.len\n    }\n}\n";
    env.replace("Hello.java", java);
    assert_eq!(env.disk("Hello.java"), disk);
    env.wait_ready(id).await;
    let r = env
        .completion_until(id, "Hello.java", after(java, "s.len"), |i| {
            i.iter().any(|i| i.label.starts_with("length"))
        })
        .await;
    assert!(!r.data.items.is_empty());
    env.hover_until(id, "Hello.java", before(java, "String s"), |t| {
        t.contains("String")
    })
    .await;
    let def = env
        .definition_until(id, "Hello.java", before(java, "s.len"), |l| {
            l.iter().any(|l| l.range.start.line == 2)
        })
        .await;
    assert!(def[0].path.ends_with("Hello.java"));
    env.assert_capabilities(
        id,
        "Hello.java",
        before(java, "String s"),
        before(java, "s.len"),
    )
    .await;

    let one_line = "public class Hello {\n    int a = 1; String s = \"\"; int x = \"text\";\n}\n";
    let mark = env.mark();
    let rev1 = env.replace("Hello.java", one_line);
    let d1 = env
        .diagnostics(id, "Hello.java", mark, "type mismatch", |d| {
            fresh(d, rev1.revision) && has_message(&d.diagnostics, "Type mismatch")
        })
        .await;
    let want = before(one_line, "\"text\"");
    assert!(
        d1.diagnostics.iter().any(|x| x.range.start == want),
        "{:?}",
        describe(&d1.diagnostics)
    );
    let at = one_line.find("s = \"\"").unwrap() + "s = \"".len();
    let mark = env.mark();
    let rev2 = env.insert("Hello.java", offset16(one_line, at), "😀日本");
    let text2 = env.snapshot("Hello.java").text;
    let d2 = env
        .diagnostics(id, "Hello.java", mark, "type mismatch after unicode", |d| {
            fresh(d, rev2.revision) && has_message(&d.diagnostics, "Type mismatch")
        })
        .await;
    let want2 = before(&text2, "\"text\"");
    assert!(
        d2.diagnostics.iter().any(|x| x.range.start == want2),
        "{:?}",
        describe(&d2.diagnostics)
    );

    let ugly = "public class Hello {\nint   x=1 ;\n}\n";
    env.replace("Hello.java", ugly);
    let edits = env.format_edits(id, "Hello.java").await;
    assert!(!edits.is_empty());
    assert_ne!(apply_edits(ugly, &edits), ugly);

    env.finish().await;
}

// ---------------------------------------------------------------------------
// Cross cutting behaviour with real servers
// ---------------------------------------------------------------------------

/// An edit between request and reply: the reply is dropped as `Stale`, and nothing
/// stamped with the old revision is ever returned as current.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stale_reply_after_edit_between_request_and_reply() {
    let id = ServerId::Json;
    let mut env = Env::start(&[("package.json", "{}"), ("a.json", "{}\n")]).await;
    env.open("a.json");
    env.replace("a.json", "{\"a\": 1}\n");
    env.wait_ready(id).await;
    env.completion_until(
        id,
        "a.json",
        PositionDto {
            line: 0,
            character: 1,
        },
        |_| true,
    )
    .await;

    let mut stale = 0;
    let mut ok = 0;
    for attempt in 0..120u64 {
        let svc = env.svc.clone();
        let before_rev = env.snapshot("a.json").revision;
        let request = tokio::spawn(async move {
            svc.completion(
                "a.json",
                PositionDto {
                    line: 0,
                    character: 1,
                },
                None,
                None,
            )
            .await
        });
        // Vary how long the request is in flight before the edit lands.
        tokio::time::sleep(Duration::from_micros((attempt % 40) * 250)).await;
        let rev = env.insert("a.json", 1, " ");
        match request.await.unwrap() {
            Err(LspErrorDto::Stale) => stale += 1,
            Ok(r) => {
                ok += 1;
                assert!(
                    r.revision <= rev.revision,
                    "reply stamped with a future revision"
                );
                assert_eq!(
                    r.revision, before_rev,
                    "an Ok reply belongs to the old revision only if no edit landed first"
                );
            }
            Err(e) => panic!("unexpected error {e:?}"),
        }
        if stale >= 3 {
            break;
        }
    }
    eprintln!("[evidence] stale test: {stale} Stale, {ok} Ok replies");
    assert!(stale >= 1, "never observed Stale ({ok} Ok replies)");

    // The current revision still answers.
    env.completion_until(
        id,
        "a.json",
        PositionDto {
            line: 0,
            character: 1,
        },
        |_| true,
    )
    .await;
    env.finish().await;
}

/// A request sent to a cold server returns promptly with a typed outcome, and cancelling its
/// id never leaves it hanging. A real server cannot be made slow on demand, so which outcome
/// wins is a race: the service may answer `NotReady` while the server is starting, or the
/// cancel may land first. Deterministic `Cancelled` coverage uses the slow fake server
/// (`language_servers/tests.rs`).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cold_server_request_returns_promptly_and_cancel_is_harmless() {
    let id = ServerId::Json;
    let mut env = Env::start(&[("package.json", "{}"), ("a.json", "{}\n")]).await;
    env.open("a.json");
    env.replace("a.json", "{\"a\": 1}\n");
    let svc = env.svc.clone();
    let started = Instant::now();
    let request = tokio::spawn(async move {
        svc.completion(
            "a.json",
            PositionDto {
                line: 0,
                character: 1,
            },
            None,
            Some("slow-1".into()),
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    env.svc.cancel("slow-1");
    let outcome = tokio::time::timeout(Duration::from_secs(30), request)
        .await
        .expect("a request on a cold server returns promptly")
        .unwrap();
    assert!(
        matches!(
            outcome,
            Err(LspErrorDto::Cancelled) | Err(LspErrorDto::NotReady { .. }) | Ok(_)
        ),
        "unexpected outcome for a cold-server request: {outcome:?}"
    );
    eprintln!(
        "[evidence] cold request outcome after {:?}: {}",
        started.elapsed(),
        match &outcome {
            Ok(_) => "Ok".to_string(),
            Err(e) => format!("{e:?}"),
        }
    );
    // The id is free again and the service still works.
    env.wait_ready(id).await;
    let r = env
        .completion_until(
            id,
            "a.json",
            PositionDto {
                line: 0,
                character: 1,
            },
            |_| true,
        )
        .await;
    assert_eq!(r.revision, env.snapshot("a.json").revision);
    env.finish().await;
}

/// `lsp_restart` bumps the epoch, replaces the process and replays unsaved documents.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn restart_bumps_epoch_and_replays_documents() {
    let id = ServerId::Json;
    let mut env = Env::start(&[("package.json", "{}"), ("a.json", "{}\n")]).await;
    let schema = r#"{"type":"object","properties":{"mode":{"enum":["fast","slow"]}}}"#;
    std::fs::write(env.path("schema.json"), schema).unwrap();
    let schema_uri = path_uri(&env.path("schema.json"));
    env.open("a.json");
    let draft = format!("{{\n  \"$schema\": \"{schema_uri}\",\n  \"mode\": \n}}\n");
    env.replace("a.json", &draft);
    let row = env.wait_ready(id).await;
    let at = after(&draft, "\"mode\": ");
    let r = env
        .completion_until(id, "a.json", at, |i| labels(i).contains(&"\"fast\""))
        .await;
    assert_eq!(r.epoch, row.epoch);
    let old_pids = env.server_pids();
    assert!(!old_pids.is_empty());

    env.svc.restart(id).await.expect("restart succeeds");
    let epoch_after = env.rows(id).await[0].epoch;
    assert_eq!(epoch_after, row.epoch + 1, "restart bumps the epoch");
    env.wait_gone("old json server", &old_pids).await;
    env.wait_ready(id).await;
    let new_pids = env.server_pids();
    assert!(!new_pids.is_empty());
    assert!(
        new_pids.iter().all(|p| !old_pids.contains(p)),
        "restart must start a new process: old {old_pids:?} new {new_pids:?}"
    );

    // The unsaved draft was replayed into the new process.
    let r2 = env
        .completion_until(id, "a.json", at, |i| labels(i).contains(&"\"fast\""))
        .await;
    assert_eq!(r2.epoch, epoch_after);
    assert_eq!(r2.revision, env.snapshot("a.json").revision);
    assert_eq!(env.disk("a.json"), "{}\n");
    // Edits after the restart still sync.
    let rev = env.insert("a.json", 0, " ");
    let r3 = env
        .completion_until(
            id,
            "a.json",
            PositionDto {
                line: 0,
                character: 1,
            },
            |_| true,
        )
        .await;
    assert_eq!(r3.revision, rev.revision);
    env.finish().await;
}

/// Opening another workspace shuts the old server (and its children) down.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn workspace_change_kills_old_server_process_tree() {
    let id = ServerId::Vtsls;
    let mut env = Env::start(&[
        ("tsconfig.json", r#"{"compilerOptions":{"strict":true}}"#),
        ("a.ts", "export {};\n"),
    ])
    .await;
    env.open("a.ts");
    env.replace("a.ts", "const n = 1;\nn.toF");
    env.wait_ready(id).await;
    env.completion_until(
        id,
        "a.ts",
        PositionDto {
            line: 1,
            character: 4,
        },
        |i| labels(i).contains(&"toFixed"),
    )
    .await;
    // Make sure the tsserver child exists too.
    let tree = env.server_pids();
    eprintln!("[evidence] vtsls tree before workspace change: {tree:?}");
    assert!(!tree.is_empty());

    let other = tempfile::tempdir().unwrap();
    let other_root = std::fs::canonicalize(other.path()).unwrap();
    std::fs::write(other_root.join("b.ts"), "export {};\n").unwrap();
    let ws2 = CoreWorkspace::open(&other_root)
        .unwrap()
        .with_user_settings(None);
    let root2 = PathBuf::from(ws2.workspace().root);
    env.svc.workspace_changed(root2, &env.settings);
    env.wait_gone("old workspace server tree", &tree).await;

    // The old document is no longer open in the service.
    let r = env
        .svc
        .completion(
            "a.ts",
            PositionDto {
                line: 1,
                character: 4,
            },
            None,
            None,
        )
        .await;
    assert!(
        matches!(
            r,
            Err(LspErrorDto::NotReady { .. }) | Err(LspErrorDto::Unsupported { .. })
        ),
        "old document after workspace change: {r:?}"
    );
    let rows = env.rows(id).await;
    assert!(
        rows.iter()
            .all(|r| r.root.is_none() || r.root.as_deref() != Some(env.root.to_str().unwrap())),
        "old root still reported: {rows:?}"
    );
    let rest = env.server_pids();
    assert!(rest.is_empty(), "children left: {rest:?}");
    env.exit_and_assert_clean().await;
}

/// App exit with two different servers running leaves no child process.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn app_exit_shutdown_all_leaves_no_children() {
    let mut env = Env::start(&[
        ("tsconfig.json", r#"{"compilerOptions":{"strict":true}}"#),
        ("a.ts", "export {};\n"),
        ("b.css", "a {}\n"),
        ("package.json", "{}"),
    ])
    .await;
    env.open("a.ts");
    env.open("b.css");
    env.replace("a.ts", "const n = 1;\nn.toF");
    env.replace("b.css", "a {\n  col\n}\n");
    env.wait_ready(ServerId::Vtsls).await;
    env.wait_ready(ServerId::Css).await;
    env.completion_until(
        ServerId::Vtsls,
        "a.ts",
        PositionDto {
            line: 1,
            character: 4,
        },
        |i| labels(i).contains(&"toFixed"),
    )
    .await;
    let tree = env.server_pids();
    eprintln!("[evidence] process tree before exit: {tree:?}");
    assert!(tree.len() >= 2, "expected at least two server processes");
    env.exit_and_assert_clean().await;
}

/// NeedsInstall with auto install off: nothing is downloaded. `lsp_install` then
/// downloads (real network) and the server works.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn needs_install_downloads_nothing_until_install_is_called() {
    let id = ServerId::Json;
    let fresh = tempfile::tempdir().unwrap();
    let mut options = EnvOptions::shared();
    options.cache = std::fs::canonicalize(fresh.path()).unwrap().join("cache");
    options.auto_install = false;
    let mut env = Env::start_with(&[("package.json", "{}"), ("a.json", "{}\n")], options).await;
    env.open("a.json");
    env.replace("a.json", "{\"a\": 1}\n");

    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let rows = env.rows(id).await;
        if rows
            .iter()
            .any(|r| matches!(r.state, LanguageServerStateDto::NeedsInstall { .. }))
        {
            break;
        }
        assert!(Instant::now() < deadline, "never NeedsInstall: {rows:?}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let r = env
        .svc
        .completion(
            "a.json",
            PositionDto {
                line: 0,
                character: 1,
            },
            None,
            None,
        )
        .await;
    match &r {
        Err(LspErrorDto::NeedsInstall { version, .. }) => {
            assert!(!version.is_empty())
        }
        other => panic!("expected NeedsInstall, got {other:?}"),
    }
    // Give a wrongly eager download time to show itself.
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(env.fetch.requests(), 0, "no download before opt in");
    assert!(env.server_pids().is_empty(), "nothing may be started");
    let row = &env.rows(id).await[0];
    assert!(!row.installed);
    eprintln!(
        "[evidence] NeedsInstall with autoInstall=false: 0 download requests, state {:?}",
        row.state
    );

    env.svc.install(id).await.expect("install starts");
    env.wait_ready(id).await;
    let requests = env.fetch.requests();
    assert!(requests >= 1, "install must have used the network");
    eprintln!(
        "[evidence] lsp_install: {requests} download request(s): {:?}",
        env.fetch.urls.lock().unwrap()
    );
    let r = env
        .completion_until(
            id,
            "a.json",
            PositionDto {
                line: 0,
                character: 1,
            },
            |_| true,
        )
        .await;
    assert_eq!(r.revision, env.snapshot("a.json").revision);
    assert!(env.rows(id).await[0].installed);
    env.finish().await;
}

/// A broken formatter must not block saving, and a language server format request is
/// independent of saving: the draft always reaches the disk.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn save_writes_draft_when_formatter_is_broken() {
    let id = ServerId::Json;
    let mut env = Env::start(&[
        ("package.json", "{}"),
        ("a.json", "{}\n"),
        (
            ".span/settings.jsonc",
            "{\"formatOnSave\": true, \"formatters\": {\"json\": [\"/nonexistent/span-formatter\"]}}\n",
        ),
    ])
    .await;
    env.open("a.json");
    let draft = "{\"draft\":   true}\n";
    let rev = env.replace("a.json", draft);
    env.wait_ready(id).await;
    env.completion_until(
        id,
        "a.json",
        PositionDto {
            line: 0,
            character: 1,
        },
        |_| true,
    )
    .await;

    // The language server formatter works and leaves the buffer alone.
    let edits = env.format_edits(id, "a.json").await;
    assert!(!edits.is_empty());

    // Save through the same service the command uses, with the external formatter broken.
    let state = DesktopState {
        workspace: Arc::new(StdMutex::new(Some(env.ws.clone()))),
        ..Default::default()
    };
    let warnings: Arc<StdMutex<Vec<String>>> = Arc::default();
    let sink_warnings = warnings.clone();
    let snapshot = services::format_or_save_with_warning(
        state,
        "a.json".into(),
        rev.revision,
        true,
        Some(Arc::new(move |w| {
            sink_warnings.lock().unwrap().push(w.message)
        })),
    )
    .await
    .expect("save succeeds although the formatter is broken");
    env.svc.on_snapshot(&snapshot);
    assert_eq!(env.disk("a.json"), draft, "the draft was written as is");
    assert_eq!(snapshot.text, draft);
    let w = warnings.lock().unwrap().clone();
    assert_eq!(w.len(), 1, "one formatter notice expected: {w:?}");
    eprintln!(
        "[evidence] broken formatter notice: {:?}; draft saved",
        w[0]
    );

    // Language server still in sync after the save.
    let r = env
        .completion_until(
            id,
            "a.json",
            PositionDto {
                line: 0,
                character: 1,
            },
            |_| true,
        )
        .await;
    assert_eq!(r.revision, snapshot.revision);
    env.finish().await;
}
