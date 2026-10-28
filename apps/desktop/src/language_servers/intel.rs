//! Data for the "Language intelligence" UI: overall install progress, work done
//! progress (`$/progress`) from servers, per-workspace trust, and the descriptive fields of
//! `lsp_status` rows.

use super::dto::LanguageServerId;
use super::{InstallPhase, LanguageServerStateDto};
use serde::{Deserialize, Serialize};
use span_lsp::servers::install::InstallProgress;
use span_lsp::servers::manager::{WorkProgress, WorkProgressKind};
use span_lsp::servers::ServerId;
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri_specta::Event;

// ---------------------------------------------------------------------------
// Install progress across all artifacts
// ---------------------------------------------------------------------------

/// One number for the whole install: bytes received and expected across every artifact,
/// the artifact being worked on, and a fraction that never goes backwards.
#[derive(Debug, Clone, Default)]
pub struct OverallTracker {
    size_hint: Option<u64>,
    count: usize,
    index: usize,
    received: Vec<u64>,
    totals: Vec<Option<u64>>,
    reported: u64,
    last_fraction: f64,
}

/// Overall progress at one moment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Overall {
    pub received: u64,
    pub total: Option<u64>,
    /// Zero based index of the artifact being worked on.
    pub index: u32,
    pub count: u32,
}

impl OverallTracker {
    pub fn new(size_hint: Option<u64>) -> Self {
        Self {
            size_hint,
            ..Default::default()
        }
    }

    fn ensure(&mut self, index: usize) {
        if self.received.len() <= index {
            self.received.resize(index + 1, 0);
            self.totals.resize(index + 1, None);
        }
        self.count = self.count.max(index + 1);
    }

    fn finish_download(&mut self, index: usize) {
        self.ensure(index);
        if let Some(total) = self.totals[index] {
            self.received[index] = self.received[index].max(total);
        }
    }

    pub fn apply(&mut self, progress: &InstallProgress) {
        match progress {
            InstallProgress::Started { artifacts, .. } => {
                self.count = *artifacts;
                if *artifacts > 0 {
                    self.ensure(*artifacts - 1);
                }
            }
            InstallProgress::Downloading {
                index,
                received,
                total,
            } => {
                self.ensure(*index);
                self.index = *index;
                self.received[*index] = self.received[*index].max(*received);
                if total.is_some() {
                    self.totals[*index] = *total;
                }
            }
            InstallProgress::Reused { index }
            | InstallProgress::Verifying { index }
            | InstallProgress::Extracting { index } => {
                self.index = *index;
                self.finish_download(*index);
            }
            InstallProgress::Finalizing => {
                for index in 0..self.count {
                    self.finish_download(index);
                }
                self.index = self.count.saturating_sub(1);
            }
            _ => {}
        }
    }

    /// Current numbers. The fraction and the byte count only ever grow.
    pub fn snapshot(&mut self) -> Overall {
        let known: u64 = self.totals.iter().flatten().sum();
        let all_known = self.count > 0 && self.totals.iter().take(self.count).all(Option::is_some);
        let mut total = if all_known {
            Some(known)
        } else {
            let best = self.size_hint.unwrap_or(0).max(known);
            (best > 0).then_some(best)
        };
        let mut received: u64 = self.received.iter().sum();
        if let Some(t) = total {
            let t = t.max(received);
            total = Some(t);
            if t > 0 {
                let fraction = received as f64 / t as f64;
                if fraction < self.last_fraction {
                    // A newly discovered artifact grew the total: hold the fraction.
                    received = ((self.last_fraction * t as f64).ceil() as u64).min(t);
                } else {
                    self.last_fraction = fraction;
                }
            }
        }
        received = received.max(self.reported);
        self.reported = received;
        Overall {
            received,
            total,
            index: self.index as u32,
            count: self.count as u32,
        }
    }

    /// Everything is downloaded: report the whole size.
    pub fn complete(&mut self) -> Overall {
        let mut o = self.snapshot();
        let total = o.total.unwrap_or(o.received).max(o.received);
        o.received = total;
        o.total = Some(total);
        self.reported = total;
        self.last_fraction = 1.0;
        o
    }
}

/// Where an in-flight install stands, as carried by `lsp_status` rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatusDto {
    pub phase: InstallPhase,
    pub overall_received: u64,
    pub overall_total: Option<u64>,
    pub artifact_index: u32,
    pub artifact_count: u32,
}

// ---------------------------------------------------------------------------
// Work done progress
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum WorkProgressKindDto {
    Begin,
    Report,
    End,
}

impl From<WorkProgressKind> for WorkProgressKindDto {
    fn from(kind: WorkProgressKind) -> Self {
        match kind {
            WorkProgressKind::Begin => Self::Begin,
            WorkProgressKind::Report => Self::Report,
            WorkProgressKind::End => Self::End,
        }
    }
}

/// A server is busy: importing, building, indexing. Keyed by `(server, root, token)`,
/// at most about four `report` events per second per token; `begin` and `end` always
/// arrive.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerWorkProgress {
    pub server: LanguageServerId,
    pub root: String,
    pub token: String,
    pub title: Option<String>,
    pub message: Option<String>,
    pub percentage: Option<u32>,
    pub kind: WorkProgressKindDto,
}

/// One running piece of work, for late subscribers (`ServerStatusDto.activity`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDto {
    pub token: String,
    pub title: Option<String>,
    pub message: Option<String>,
    pub percentage: Option<u32>,
}

const REPORT_INTERVAL: Duration = Duration::from_millis(250);

type WorkKey = (ServerId, PathBuf, String);

#[derive(Default)]
pub struct WorkTracker {
    entries: HashMap<WorkKey, ActivityDto>,
    last_emit: HashMap<WorkKey, Instant>,
}

impl WorkTracker {
    /// Record one report. Returns the event to emit, or `None` when it is throttled.
    pub fn apply(
        &mut self,
        server: ServerId,
        root: &Path,
        report: WorkProgress,
    ) -> Option<LanguageServerWorkProgress> {
        let WorkProgress {
            token,
            kind,
            title,
            message,
            percentage,
        } = report;
        let key = (server, root.to_path_buf(), token.clone());
        let entry = match kind {
            WorkProgressKind::End => self.entries.remove(&key),
            _ => {
                let e = self.entries.entry(key.clone()).or_insert(ActivityDto {
                    token: token.clone(),
                    title: None,
                    message: None,
                    percentage: None,
                });
                if title.is_some() {
                    e.title = title.clone();
                }
                if message.is_some() {
                    e.message = message.clone();
                }
                if percentage.is_some() {
                    e.percentage = percentage;
                }
                Some(e.clone())
            }
        };
        match kind {
            WorkProgressKind::Report => {
                let now = Instant::now();
                if self
                    .last_emit
                    .get(&key)
                    .is_some_and(|t| now.duration_since(*t) < REPORT_INTERVAL)
                {
                    return None;
                }
                self.last_emit.insert(key, now);
            }
            WorkProgressKind::Begin => {
                self.last_emit.insert(key, Instant::now());
            }
            WorkProgressKind::End => {
                self.last_emit.remove(&key);
            }
        }
        let entry = entry.unwrap_or(ActivityDto {
            token: token.clone(),
            title: None,
            message: None,
            percentage: None,
        });
        Some(LanguageServerWorkProgress {
            server: server.into(),
            root: root.to_string_lossy().into_owned(),
            token,
            title: entry.title.or(title),
            message: entry.message.or(message),
            percentage: entry.percentage.or(percentage),
            kind: kind.into(),
        })
    }

    /// Work in flight for one server instance, in a stable order.
    pub fn activity(&self, server: ServerId, root: &Path) -> Vec<ActivityDto> {
        let mut out: Vec<ActivityDto> = self
            .entries
            .iter()
            .filter(|((s, r, _), _)| *s == server && r == root)
            .map(|(_, v)| v.clone())
            .collect();
        out.sort_by(|a, b| a.token.cmp(&b.token));
        out
    }

    /// Forget everything of one instance (it stopped or crashed).
    pub fn clear(&mut self, server: ServerId, root: &Path) {
        self.entries
            .retain(|(s, r, _), _| !(*s == server && r == root));
        self.last_emit
            .retain(|(s, r, _), _| !(*s == server && r == root));
    }

    pub fn clear_all(&mut self) {
        self.entries.clear();
        self.last_emit.clear();
    }
}

// ---------------------------------------------------------------------------
// Descriptive row data
// ---------------------------------------------------------------------------

pub fn display_name(server: ServerId) -> &'static str {
    match server {
        ServerId::Jdtls => "Java (Eclipse JDT LS)",
        ServerId::Vtsls => "TypeScript and JavaScript (vtsls)",
        ServerId::Html => "HTML",
        ServerId::Css => "CSS, SCSS and Less",
        ServerId::Json => "JSON",
        ServerId::RustAnalyzer => "Rust (rust-analyzer)",
        ServerId::Basedpyright => "Python (basedpyright)",
    }
}

pub fn languages(server: ServerId) -> Vec<String> {
    let names: &[&str] = match server {
        ServerId::Jdtls => &["Java"],
        ServerId::Vtsls => &["TypeScript", "JavaScript"],
        ServerId::Html => &["HTML"],
        ServerId::Css => &["CSS", "SCSS", "Less"],
        ServerId::Json => &["JSON", "JSON with comments"],
        ServerId::RustAnalyzer => &["Rust"],
        ServerId::Basedpyright => &["Python"],
    };
    names.iter().map(|n| (*n).to_owned()).collect()
}

/// Total size of the files below `dir`, without following symlinks. Bounded, so a huge
/// or odd tree cannot stall a status call.
pub fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut seen = 0usize;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in read.flatten() {
            seen += 1;
            if seen > 500_000 {
                return total;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    total
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDto {
    /// `Node.js` or `JDK`.
    pub name: String,
    pub required_version: u32,
    pub found_version: Option<String>,
    pub found_path: Option<String>,
}

/// Plain-language reason and the technical details for a failed state.
pub fn failure(state: &LanguageServerStateDto) -> Option<(String, String)> {
    use LanguageServerStateDto as S;
    Some(match state {
        S::InstallFailed { reason, retryable } => (
            if *retryable {
                "The download did not finish. Check your connection and try again.".to_owned()
            } else {
                "This language server cannot be installed on this computer.".to_owned()
            },
            reason.clone(),
        ),
        S::StartFailed { reason } => (
            "The language server could not start. Try restarting it.".to_owned(),
            reason.clone(),
        ),
        S::Crashed => (
            "The language server stopped unexpectedly. Restart it to continue.".to_owned(),
            "the server process exited".to_owned(),
        ),
        S::RuntimeMissing {
            runtime,
            required_version,
            found,
        } => (
            format!(
                "{} {required_version} or newer is needed to run this server{}.",
                runtime_title(runtime),
                if found.is_empty() {
                    ", but none was found".to_owned()
                } else {
                    format!(", but only {} was found", found.join(", "))
                }
            ),
            format!("runtime {runtime} >= {required_version}, found {found:?}"),
        ),
        _ => return None,
    })
}

pub fn runtime_title(runtime: &str) -> &'static str {
    match runtime {
        "java" => "A JDK",
        "node" => "Node.js",
        _ => "A runtime",
    }
}

// ---------------------------------------------------------------------------
// Workspace trust
// ---------------------------------------------------------------------------

/// Whether running a project's own build code is allowed for it, and whether the
/// restricted mode is costing results.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrustDto {
    pub workspace_trusted: bool,
    pub needs_trust: bool,
    pub reason: Option<String>,
}

/// The build files at `root` that change what `server` can resolve, as a sentence.
/// Plain existence checks (and one small file read for Cargo).
pub fn trust_reason(server: ServerId, root: &Path) -> Option<String> {
    let has = |name: &str| root.join(name).is_file();
    match server {
        ServerId::Jdtls => {
            if has("pom.xml") {
                Some(
                    "This Maven project's dependencies can only be loaded by running Maven.".into(),
                )
            } else if [
                "build.gradle",
                "build.gradle.kts",
                "settings.gradle",
                "settings.gradle.kts",
            ]
            .iter()
            .any(|f| has(f))
            {
                Some(
                    "This Gradle project's dependencies can only be loaded by running Gradle."
                        .into(),
                )
            } else {
                None
            }
        }
        ServerId::RustAnalyzer => {
            let manifest = root.join("Cargo.toml");
            if !manifest.is_file() {
                return None;
            }
            let text = read_small(&manifest);
            let section_with_entries = |header: &str| {
                let mut inside = false;
                for line in text.lines() {
                    let line = line.trim();
                    if line.starts_with('[') {
                        inside = line.trim_end().starts_with(header);
                    } else if inside && !line.is_empty() && !line.starts_with('#') {
                        return true;
                    }
                }
                false
            };
            if has("build.rs")
                || section_with_entries("[dependencies")
                || section_with_entries("[build-dependencies")
                || text.contains("[workspace")
            {
                Some(
                    "This Rust project's dependencies and build scripts can only be loaded by running Cargo."
                        .into(),
                )
            } else {
                None
            }
        }
        _ => None,
    }
}

fn read_small(path: &Path) -> String {
    use std::io::Read;
    let mut text = String::new();
    if let Ok(file) = std::fs::File::open(path) {
        let _ = file.take(256 * 1024).read_to_string(&mut text);
    }
    text
}

/// Is `root` covered by the global override or by a trusted workspace root?
pub fn is_trusted(global: bool, trusted: &[PathBuf], root: &Path) -> bool {
    global || trusted.iter().any(|t| root.starts_with(t))
}

#[cfg(test)]
mod tests;
