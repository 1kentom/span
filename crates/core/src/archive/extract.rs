//! Two-phase extraction: [`plan_extract`] decides every entry's fate without writing, and
//! [`extract`] re-plans (never trusting a plan from the UI) and then streams the files.
use super::safety::{self, SafePath};
use super::{
    judge_all, walk, ArchiveError, ArchiveErrorKind, ArchiveLimits, ArchiveResult, ArchiveSource,
    RawEntry, RawKind, Step, UnsafeReason, Visitor,
};
use crate::attachment::{ensure_dir_under, numbered, publish_new};
use crate::search::CancellationToken;
use crate::CoreError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const CHUNK: usize = 64 * 1024;
const PROGRESS_EVERY: u64 = 1024 * 1024;
const MAX_RENAME_SUFFIX: u32 = 10_000;

static TEMP_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictMode {
    /// Plan only reports conflicts; nothing is written until each has a decision.
    Ask,
    Skip,
    /// Replace existing files. Never replaces a folder, a symlink, or a file with a folder.
    Replace,
    /// Write under a numbered name such as `a (1).txt`.
    Rename,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictAction {
    Skip,
    Replace,
    Rename,
}

/// The user's answer for one conflicting target (workspace-relative, as planned).
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDecision {
    pub target: String,
    pub action: ConflictAction,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExtractOptions {
    /// Entry paths as listed. A folder path selects everything below it. `None` is all.
    pub selection: Option<Vec<String>>,
    /// Workspace-relative folder; empty means the workspace root.
    pub destination: String,
    pub keep_structure: bool,
    pub skip_hidden: bool,
    pub conflict: ConflictMode,
    /// Create a new folder named after the archive (numbered if taken) inside `destination`.
    pub into_new_folder: bool,
    /// Answers for conflicts from an earlier `ask` plan.
    pub decisions: Option<Vec<ConflictDecision>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ExistingKind {
    File,
    Folder,
    Symlink,
    /// No file on disk yet, but an editor buffer is open for this path.
    OpenBuffer,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExtractConflict {
    pub entry: String,
    /// Workspace-relative target path.
    pub target: String,
    pub existing: ExistingKind,
    /// How it is or was resolved; `None` means it still needs a decision.
    pub resolution: Option<ConflictAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SkipReason {
    /// Always skipped by the safety rules.
    Unsafe { reason: UnsafeReason },
    /// OS clutter skipped by the "Skip hidden files" option.
    Hidden,
    /// The target exists and the conflict mode or decision was skip.
    Exists,
    /// Another selected entry already maps to this target (flattened folders).
    DuplicateTarget,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkippedEntry {
    pub entry: String,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExtractPlan {
    /// Workspace-relative destination, including the predicted new folder.
    pub destination: String,
    pub files: u32,
    pub folders: u32,
    /// Sum of planned file sizes from the headers.
    pub bytes: u64,
    pub skipped: Vec<SkippedEntry>,
    pub conflicts: Vec<ExtractConflict>,
    /// True when the mode is `ask` and a conflict has no decision yet.
    pub needs_decision: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WrittenFile {
    pub entry: String,
    /// Workspace-relative path that was written.
    pub path: String,
    pub size: u64,
    pub renamed: bool,
    pub replaced: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExtractFailure {
    pub entry: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExtractProgress {
    pub files_done: u32,
    pub files_total: u32,
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// Entry being written, if any.
    pub current: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExtractReport {
    pub destination: String,
    pub written: Vec<WrittenFile>,
    pub folders_created: u32,
    pub skipped: Vec<SkippedEntry>,
    pub conflicts: Vec<ExtractConflict>,
    pub errors: Vec<ExtractFailure>,
    pub cancelled: bool,
    /// Nothing was written because an `ask` conflict has no decision.
    pub needs_decision: bool,
}

/// Workspace facts captured under the workspace lock.
#[derive(Debug, Clone)]
pub struct ExtractContext {
    /// Canonical workspace root.
    pub root: PathBuf,
    /// Workspace-relative paths with an open buffer; they count as taken.
    pub open_buffers: HashSet<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Policy {
    /// Create new or skip; `ask` reports a late conflict, `skip` reports `Exists`.
    CreateOrSkip {
        ask: bool,
    },
    CreateOrRename,
    Replace,
}

#[derive(Debug, Clone)]
struct Item {
    entry: String,
    /// Components inside the destination folder.
    rel: Vec<String>,
    is_dir: bool,
    size: u64,
    policy: Policy,
}

struct Plan {
    summary: ExtractPlan,
    dest_rel: Vec<String>,
    new_folder: Option<String>,
    items: HashMap<usize, Item>,
}

fn invalid(message: impl Into<String>) -> ArchiveError {
    ArchiveError::new(ArchiveErrorKind::InvalidPath, message)
}

fn core_failure(error: CoreError) -> ArchiveError {
    match error {
        CoreError::Io { .. } => ArchiveError::new(ArchiveErrorKind::Io, error.to_string()),
        other => invalid(format!("Destination is not usable: {other}")),
    }
}

/// Validate a workspace-relative destination with the entry rules (no absolute, drive,
/// `..`, protected or reserved components). Empty is the workspace root.
fn destination_components(destination: &str) -> ArchiveResult<Vec<String>> {
    let trimmed = destination.trim_matches('/');
    if destination.starts_with(['/', '\\']) {
        return Err(invalid("Destination must be relative to the workspace"));
    }
    if trimmed.is_empty() || trimmed == "." {
        return Ok(Vec::new());
    }
    safety::classify_path(trimmed)
        .map(|p| p.components)
        .map_err(|reason| invalid(format!("Destination is not allowed ({reason:?})")))
}

fn rel_string(parts: &[String]) -> String {
    parts.join("/")
}

fn join_rel(base: &[String], rest: &[String]) -> String {
    let mut all = base.to_vec();
    all.extend_from_slice(rest);
    rel_string(&all)
}

fn existing_kind(path: &Path) -> Option<ExistingKind> {
    let metadata = path.symlink_metadata().ok()?;
    Some(if metadata.file_type().is_symlink() {
        ExistingKind::Symlink
    } else if metadata.is_dir() {
        ExistingKind::Folder
    } else {
        ExistingKind::File
    })
}

fn selected(selection: &Option<Vec<String>>, path: &str) -> bool {
    let Some(list) = selection else {
        return true;
    };
    list.iter().any(|s| {
        let s = s.trim_end_matches('/');
        path == s
            || path
                .strip_prefix(s)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

fn build_plan(
    source: &ArchiveSource,
    options: &ExtractOptions,
    ctx: &ExtractContext,
    limits: &ArchiveLimits,
) -> ArchiveResult<Plan> {
    let dest_rel = destination_components(&options.destination)?;
    let (_, judged, _) = judge_all(source, limits, true)?;
    let dest_abs: PathBuf = dest_rel.iter().fold(ctx.root.clone(), |p, c| p.join(c));
    let new_folder = options.into_new_folder.then(|| {
        let base = safety::folder_name_for(source.name());
        (0..=MAX_RENAME_SUFFIX)
            .map(|n| {
                if n == 0 {
                    base.clone()
                } else {
                    numbered(&base, n)
                }
            })
            .find(|name| dest_abs.join(name).symlink_metadata().is_err())
            .unwrap_or(base)
    });
    let mut final_rel = dest_rel.clone();
    final_rel.extend(new_folder.clone());
    let final_abs: PathBuf = final_rel.iter().fold(ctx.root.clone(), |p, c| p.join(c));

    let decisions: HashMap<&str, ConflictAction> = options
        .decisions
        .iter()
        .flatten()
        .map(|d| (d.target.as_str(), d.action))
        .collect();
    let default_policy = match options.conflict {
        ConflictMode::Ask => Policy::CreateOrSkip { ask: true },
        ConflictMode::Skip => Policy::CreateOrSkip { ask: false },
        ConflictMode::Replace => Policy::Replace,
        ConflictMode::Rename => Policy::CreateOrRename,
    };

    let mut summary = ExtractPlan {
        destination: rel_string(&final_rel),
        files: 0,
        folders: 0,
        bytes: 0,
        skipped: Vec::new(),
        conflicts: Vec::new(),
        needs_decision: false,
    };
    let mut items = HashMap::new();
    let mut taken: HashSet<String> = HashSet::new();
    for j in judged {
        let entry = match &j.verdict {
            Ok(safe) => safe.joined(),
            Err(_) => super::display_name(&j.raw.name),
        };
        if !selected(&options.selection, &entry) {
            continue;
        }
        let safe: SafePath = match j.verdict {
            Ok(safe) => safe,
            Err(reason) => {
                summary.skipped.push(SkippedEntry {
                    entry,
                    reason: SkipReason::Unsafe { reason },
                });
                continue;
            }
        };
        if options.skip_hidden && safety::is_hidden_clutter(&safe.components) {
            summary.skipped.push(SkippedEntry {
                entry,
                reason: SkipReason::Hidden,
            });
            continue;
        }
        let is_dir = j.raw.kind == RawKind::Dir;
        if is_dir && !options.keep_structure {
            continue;
        }
        let mut rel = if options.keep_structure {
            safe.components.clone()
        } else {
            vec![safe.components.last().cloned().unwrap_or_default()]
        };
        if !is_dir {
            let key = rel_string(&rel).to_lowercase();
            if taken.contains(&key) {
                if options.conflict == ConflictMode::Rename {
                    let name = rel.pop().unwrap_or_default();
                    let fresh = (1..=MAX_RENAME_SUFFIX)
                        .map(|n| numbered(&name, n))
                        .find(|n| {
                            let mut probe = rel.clone();
                            probe.push(n.clone());
                            !taken.contains(&rel_string(&probe).to_lowercase())
                        })
                        .unwrap_or(name);
                    rel.push(fresh);
                } else {
                    summary.skipped.push(SkippedEntry {
                        entry,
                        reason: SkipReason::DuplicateTarget,
                    });
                    continue;
                }
            }
            taken.insert(rel_string(&rel).to_lowercase());
        }
        let target = join_rel(&final_rel, &rel);
        let target_abs = rel.iter().fold(final_abs.clone(), |p, c| p.join(c));
        let existing = existing_kind(&target_abs).or_else(|| {
            ctx.open_buffers
                .contains(&target)
                .then_some(ExistingKind::OpenBuffer)
        });
        let mut policy = default_policy;
        match (is_dir, existing) {
            (true, None | Some(ExistingKind::Folder) | Some(ExistingKind::Symlink)) => {}
            (false, None) => {}
            (_, Some(existing)) => {
                let decided = decisions.get(target.as_str()).copied();
                let resolution = decided.or(match options.conflict {
                    ConflictMode::Ask => None,
                    ConflictMode::Skip => Some(ConflictAction::Skip),
                    ConflictMode::Replace => Some(ConflictAction::Replace),
                    ConflictMode::Rename => Some(ConflictAction::Rename),
                });
                summary.conflicts.push(ExtractConflict {
                    entry: entry.clone(),
                    target: target.clone(),
                    existing,
                    resolution,
                });
                match resolution {
                    None => summary.needs_decision = true,
                    Some(ConflictAction::Skip) => {
                        summary.skipped.push(SkippedEntry {
                            entry,
                            reason: SkipReason::Exists,
                        });
                        continue;
                    }
                    Some(ConflictAction::Replace) => policy = Policy::Replace,
                    Some(ConflictAction::Rename) => policy = Policy::CreateOrRename,
                }
            }
        }
        if is_dir {
            summary.folders += 1;
        } else {
            summary.files += 1;
            summary.bytes = summary.bytes.saturating_add(j.raw.size);
        }
        items.insert(
            j.index,
            Item {
                entry,
                rel,
                is_dir,
                size: j.raw.size,
                policy,
            },
        );
    }
    if summary.bytes > limits.max_total_bytes {
        return Err(ArchiveError::new(
            ArchiveErrorKind::TooLarge,
            "The selection unpacks beyond the total size limit",
        ));
    }
    Ok(Plan {
        summary,
        dest_rel,
        new_folder,
        items,
    })
}

/// Decide what extraction would do without writing anything.
pub fn plan_extract(
    source: &ArchiveSource,
    options: &ExtractOptions,
    ctx: &ExtractContext,
    limits: &ArchiveLimits,
) -> ArchiveResult<ExtractPlan> {
    build_plan(source, options, ctx, limits).map(|plan| plan.summary)
}

enum DirError {
    Escapes,
    Failed(String),
}

struct Executor<'a> {
    ctx: &'a ExtractContext,
    limits: &'a ArchiveLimits,
    cancel: &'a CancellationToken,
    progress: &'a mut dyn FnMut(&ExtractProgress),
    items: HashMap<usize, Item>,
    dest_abs: PathBuf,
    dest_rel: Vec<String>,
    ready_dirs: HashMap<Vec<String>, PathBuf>,
    report: ExtractReport,
    state: ExtractProgress,
    last_emit: u64,
    pending: Option<(Item, PathBuf)>,
}

impl Executor<'_> {
    fn emit(&mut self) {
        (self.progress)(&self.state);
        self.last_emit = self.state.bytes_done;
    }

    fn fail(&mut self, entry: &str, message: impl Into<String>) {
        self.report.errors.push(ExtractFailure {
            entry: entry.to_owned(),
            message: message.into(),
        });
    }

    /// Create `rel` inside the destination one level at a time. Every level is
    /// canonicalised and must stay under the canonical destination, so a symlinked
    /// folder already on disk cannot redirect the write.
    fn ensure_dir(&mut self, rel: &[String]) -> Result<PathBuf, DirError> {
        if let Some(path) = self.ready_dirs.get(rel) {
            return Ok(path.clone());
        }
        let mut current = self.dest_abs.clone();
        for depth in 0..rel.len() {
            if let Some(path) = self.ready_dirs.get(&rel[..=depth]) {
                current = path.clone();
                continue;
            }
            current.push(&rel[depth]);
            if current.symlink_metadata().is_err() {
                match fs::create_dir(&current) {
                    Ok(()) => self.report.folders_created += 1,
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(e) => {
                        return Err(DirError::Failed(format!(
                            "Could not create folder {}: {e}",
                            rel[..=depth].join("/")
                        )))
                    }
                }
            }
            current = current
                .canonicalize()
                .map_err(|e| DirError::Failed(format!("Could not resolve folder: {e}")))?;
            if !current.starts_with(&self.dest_abs) {
                return Err(DirError::Escapes);
            }
            if !current.is_dir() {
                return Err(DirError::Failed(format!(
                    "A file already exists where the folder {} is needed",
                    rel[..=depth].join("/")
                )));
            }
            self.ready_dirs
                .insert(rel[..=depth].to_vec(), current.clone());
        }
        Ok(current)
    }

    fn skip(&mut self, entry: &str, reason: SkipReason) {
        self.report.skipped.push(SkippedEntry {
            entry: entry.to_owned(),
            reason,
        });
    }

    fn workspace_rel(&self, rel_parent: &[String], name: &str) -> String {
        let mut parts = self.dest_rel.clone();
        parts.extend_from_slice(rel_parent);
        parts.push(name.to_owned());
        rel_string(&parts)
    }

    /// Stream the entry into a new temp file next to its target. Returns the temp path,
    /// or `None` after recording why nothing was written. The temp file is always removed
    /// on failure, and permissions are never taken from the archive.
    fn write_temp(
        &mut self,
        item: &Item,
        dir: &Path,
        raw: &RawEntry,
        reader: &mut dyn Read,
    ) -> Result<Option<PathBuf>, Stop> {
        let temp = dir.join(format!(
            ".archive.span-{}-{}",
            std::process::id(),
            TEMP_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(file) => file,
            Err(e) => {
                self.fail(&item.entry, format!("Could not create the file: {e}"));
                return Ok(None);
            }
        };
        let mut buffer = vec![0u8; CHUNK];
        let mut written = 0u64;
        let outcome: Result<(), Outcome> = loop {
            if self.cancel.is_cancelled() {
                break Err(Outcome::Cancelled);
            }
            let n = match reader.read(&mut buffer) {
                Ok(0) => break Ok(()),
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => break Err(Outcome::Failed(format!("The entry is damaged: {e}"))),
            };
            written += n as u64;
            self.state.bytes_done += n as u64;
            if written > self.limits.max_entry_bytes {
                break Err(Outcome::Skipped(UnsafeReason::EntryTooLarge));
            }
            if let Some(packed) = raw.packed {
                if written > self.limits.ratio_floor
                    && written > packed.saturating_mul(self.limits.max_ratio)
                {
                    break Err(Outcome::Skipped(UnsafeReason::CompressionRatio));
                }
            }
            if written > raw.size {
                break Err(Outcome::Failed(
                    "The entry is larger than its header says (damaged or hostile)".into(),
                ));
            }
            if self.state.bytes_done > self.limits.max_total_bytes {
                break Err(Outcome::TotalExceeded);
            }
            if let Err(e) = file.write_all(&buffer[..n]) {
                break Err(Outcome::Failed(format!("Could not write the file: {e}")));
            }
            if self.state.bytes_done - self.last_emit >= PROGRESS_EVERY {
                self.emit();
            }
        };
        let outcome = outcome.and_then(|()| {
            if written < raw.size {
                Err(Outcome::Failed("The entry ends early (damaged)".into()))
            } else {
                file.sync_all()
                    .map_err(|e| Outcome::Failed(format!("Could not flush the file: {e}")))
            }
        });
        drop(file);
        match outcome {
            Ok(()) => Ok(Some(temp)),
            Err(outcome) => {
                let _ = fs::remove_file(&temp);
                match outcome {
                    Outcome::Cancelled => {
                        self.report.cancelled = true;
                        Err(Stop)
                    }
                    Outcome::TotalExceeded => {
                        self.fail(
                            &item.entry,
                            "Stopped: the archive unpacks beyond the total size limit",
                        );
                        Err(Stop)
                    }
                    Outcome::Skipped(reason) => {
                        self.skip(&item.entry, SkipReason::Unsafe { reason });
                        Ok(None)
                    }
                    Outcome::Failed(message) => {
                        self.fail(&item.entry, message);
                        Ok(None)
                    }
                }
            }
        }
    }

    /// Publish `temp` as the target according to the item's policy.
    fn publish(&mut self, item: &Item, dir: &Path, temp: &Path) {
        let (parent, name) = item.rel.split_at(item.rel.len() - 1);
        let name = &name[0];
        let result = match item.policy {
            Policy::Replace => publish_replace(dir, name, temp),
            Policy::CreateOrSkip { ask } => {
                let target = dir.join(name);
                let rel = self.workspace_rel(parent, name);
                if self.ctx.open_buffers.contains(&rel) {
                    Err(io::Error::from(io::ErrorKind::AlreadyExists))
                } else {
                    link_new(temp, &target)
                }
                .map(|()| Some((name.clone(), false, false)))
                .or_else(|e| {
                    if e.kind() != io::ErrorKind::AlreadyExists {
                        return Err(e);
                    }
                    if ask {
                        self.report.conflicts.push(ExtractConflict {
                            entry: item.entry.clone(),
                            target: rel,
                            existing: existing_kind(&target).unwrap_or(ExistingKind::OpenBuffer),
                            resolution: None,
                        });
                    } else {
                        self.skip(&item.entry, SkipReason::Exists);
                    }
                    Ok(None)
                })
            }
            Policy::CreateOrRename => {
                let mut outcome = Err(io::Error::other("too many files with the same name"));
                for n in 0..=MAX_RENAME_SUFFIX {
                    let candidate = if n == 0 {
                        name.clone()
                    } else {
                        numbered(name, n)
                    };
                    if self
                        .ctx
                        .open_buffers
                        .contains(&self.workspace_rel(parent, &candidate))
                    {
                        continue;
                    }
                    match link_new(temp, &dir.join(&candidate)) {
                        Ok(()) => {
                            outcome = Ok(Some((candidate, n > 0, false)));
                            break;
                        }
                        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                        Err(e) => {
                            outcome = Err(e);
                            break;
                        }
                    }
                }
                outcome
            }
        };
        let _ = fs::remove_file(temp);
        match result {
            Ok(Some((final_name, renamed, replaced))) => {
                let path = self.workspace_rel(parent, &final_name);
                self.report.written.push(WrittenFile {
                    entry: item.entry.clone(),
                    path,
                    size: item.size,
                    renamed,
                    replaced,
                });
            }
            Ok(None) => {}
            Err(e) => self.fail(&item.entry, format!("Could not save the file: {e}")),
        }
    }
}

fn publish_replace(
    dir: &Path,
    name: &str,
    temp: &Path,
) -> io::Result<Option<(String, bool, bool)>> {
    let target = dir.join(name);
    let existed = match existing_kind(&target) {
        Some(ExistingKind::Folder) => {
            return Err(io::Error::other(
                "a folder exists at the target and is never replaced by a file",
            ))
        }
        Some(ExistingKind::Symlink) => {
            return Err(io::Error::other(
                "a symbolic link exists at the target and is never replaced",
            ))
        }
        Some(_) => true,
        None => false,
    };
    // Rename is atomic: readers see the old file or the complete new one.
    fs::rename(temp, &target)?;
    Ok(Some((name.to_owned(), false, existed)))
}

/// Create-new publish: a hard link fails if the target exists; filesystems without hard
/// links fall back to a `create_new` copy. Never replaces anything.
fn link_new(temp: &Path, target: &Path) -> io::Result<()> {
    match fs::hard_link(temp, target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(e),
        Err(_) if target.symlink_metadata().is_ok() => {
            Err(io::Error::from(io::ErrorKind::AlreadyExists))
        }
        // `publish_new` removes `temp` on success and keeps it on failure, so a later
        // candidate name can still be tried; the caller's removal is then a no-op.
        Err(_) => publish_new(temp, target),
    }
}

struct Stop;

enum Outcome {
    Cancelled,
    TotalExceeded,
    Skipped(UnsafeReason),
    Failed(String),
}

impl Visitor for Executor<'_> {
    fn entry(&mut self, index: usize, _raw: &RawEntry) -> ArchiveResult<Step> {
        if self.cancel.is_cancelled() {
            self.report.cancelled = true;
            return Ok(Step::Stop);
        }
        let Some(item) = self.items.remove(&index) else {
            return Ok(Step::Skip);
        };
        let dir_rel = if item.is_dir {
            &item.rel[..]
        } else {
            &item.rel[..item.rel.len() - 1]
        };
        match self.ensure_dir(dir_rel) {
            Err(DirError::Escapes) => {
                self.skip(
                    &item.entry,
                    SkipReason::Unsafe {
                        reason: UnsafeReason::EscapesDestination,
                    },
                );
                Ok(Step::Skip)
            }
            Err(DirError::Failed(message)) => {
                self.fail(&item.entry, message);
                Ok(Step::Skip)
            }
            Ok(_) if item.is_dir => Ok(Step::Skip),
            Ok(dir) => {
                self.state.current = Some(item.entry.clone());
                self.emit();
                self.pending = Some((item, dir));
                Ok(Step::Read)
            }
        }
    }

    fn data(&mut self, _: usize, raw: &RawEntry, reader: &mut dyn Read) -> ArchiveResult<bool> {
        let Some((item, dir)) = self.pending.take() else {
            return Ok(true);
        };
        let before = self.state.bytes_done;
        match self.write_temp(&item, &dir, raw, reader) {
            Err(Stop) => {
                self.emit();
                return Ok(false);
            }
            Ok(None) => {}
            Ok(Some(temp)) => self.publish(&item, &dir, &temp),
        }
        // Keep the byte count at the planned size for files that were cut short, so the
        // percentage stays monotonic and reaches the total.
        self.state.bytes_done = self.state.bytes_done.max(before + item.size);
        self.state.files_done += 1;
        self.state.current = None;
        self.emit();
        Ok(true)
    }
}

/// Re-plan, then write. With `ask` and an undecided conflict nothing is written and the
/// report carries the conflicts with `needs_decision`.
pub fn extract(
    source: &ArchiveSource,
    options: &ExtractOptions,
    ctx: &ExtractContext,
    limits: &ArchiveLimits,
    cancel: &CancellationToken,
    progress: &mut dyn FnMut(&ExtractProgress),
) -> ArchiveResult<ExtractReport> {
    let plan = build_plan(source, options, ctx, limits)?;
    let mut report = ExtractReport {
        destination: plan.summary.destination.clone(),
        skipped: plan.summary.skipped.clone(),
        conflicts: plan.summary.conflicts.clone(),
        ..ExtractReport::default()
    };
    if plan.summary.needs_decision {
        report.needs_decision = true;
        return Ok(report);
    }
    let base = ensure_dir_under(&ctx.root, &rel_string(&plan.dest_rel)).map_err(core_failure)?;
    let mut dest_rel = plan.dest_rel.clone();
    let dest_abs = match &plan.new_folder {
        None => base,
        Some(predicted) => {
            let mut created = None;
            for n in 0..=MAX_RENAME_SUFFIX {
                let name = if n == 0 {
                    predicted.clone()
                } else {
                    numbered(predicted, n)
                };
                match fs::create_dir(base.join(&name)) {
                    Ok(()) => {
                        created = Some(name);
                        break;
                    }
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(e) => {
                        return Err(ArchiveError::new(
                            ArchiveErrorKind::Io,
                            format!("Could not create the folder: {e}"),
                        ))
                    }
                }
            }
            let name = created.ok_or_else(|| invalid("Too many folders with the same name"))?;
            report.folders_created += 1;
            let path = base
                .join(&name)
                .canonicalize()
                .map_err(|e| ArchiveError::new(ArchiveErrorKind::Io, e.to_string()))?;
            if !path.starts_with(&base) {
                return Err(invalid("The new folder resolves outside the destination"));
            }
            dest_rel.push(name);
            path
        }
    };
    report.destination = rel_string(&dest_rel);
    let state = ExtractProgress {
        files_done: 0,
        files_total: plan.summary.files,
        bytes_done: 0,
        bytes_total: plan.summary.bytes,
        current: None,
    };
    let mut executor = Executor {
        ctx,
        limits,
        cancel,
        progress,
        items: plan.items,
        dest_abs,
        dest_rel,
        ready_dirs: HashMap::new(),
        report,
        state,
        last_emit: 0,
        pending: None,
    };
    executor.emit();
    let walked = walk(source, limits, &mut executor);
    if let Err(error) = walked {
        executor.fail("", error.message);
    }
    Ok(executor.report)
}
