//! Bounded, per-client dynamic registrations for LSP 3.17 file notifications.

use globset::{GlobBuilder, GlobMatcher};
use lsp_types::{
    DidChangeWatchedFilesRegistrationOptions, FileChangeType, FileEvent, GlobPattern, OneOf,
    RegistrationParams, UnregistrationParams, Uri, WatchKind, WorkspaceFolder,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

pub(crate) const METHOD: &str = "workspace/didChangeWatchedFiles";
pub(crate) const MAX_BATCH: usize = 1024;
const MAX_REGISTRATIONS: usize = 128;
const MAX_WATCHERS: usize = 1024;
const MAX_PATTERN_BYTES: usize = 4096;
const MAX_TOTAL_PATTERN_BYTES: usize = 256 * 1024;
const MAX_ID_BYTES: usize = 256;

#[derive(Default)]
pub(crate) struct WatchedFiles {
    roots: Vec<PathBuf>,
    registrations: HashMap<String, Vec<Rule>>,
}

struct Rule {
    matcher: GlobMatcher,
    target: Target,
    kind: WatchKind,
    pattern_bytes: usize,
}

enum Target {
    Workspace,
    Absolute,
    Relative(PathBuf),
}

impl WatchedFiles {
    pub(crate) fn set_workspace(&mut self, folders: &[WorkspaceFolder]) {
        self.roots = folders.iter().filter_map(|f| file_path(&f.uri)).collect();
        self.registrations.clear();
    }

    /// Validate the whole request before committing any registration. IDs are unique
    /// for the lifetime of a registration, so replacements require unregister first.
    pub(crate) fn register(&mut self, params: Option<&Value>) -> Result<(), String> {
        let params: RegistrationParams =
            serde_json::from_value(params.ok_or("missing registration params")?.clone())
                .map_err(|e| format!("invalid registration params: {e}"))?;
        if params.registrations.len() > MAX_REGISTRATIONS {
            return Err("too many registrations in one request".into());
        }
        let mut ids = HashSet::new();
        let mut pending = HashMap::new();
        let mut count: usize = self.registrations.values().map(Vec::len).sum();
        let mut bytes: usize = self
            .registrations
            .values()
            .flatten()
            .map(|rule| rule.pattern_bytes)
            .sum();
        for registration in params.registrations {
            if registration.id.len() > MAX_ID_BYTES || !ids.insert(registration.id.clone()) {
                return Err("duplicate or oversized registration id".into());
            }
            if registration.method != METHOD {
                continue;
            }
            if self.registrations.contains_key(&registration.id) {
                return Err("watched-file registration id is already registered".into());
            }
            if self.registrations.len() + pending.len() >= MAX_REGISTRATIONS {
                return Err("too many watched-file registrations".into());
            }
            let options: DidChangeWatchedFilesRegistrationOptions = serde_json::from_value(
                registration
                    .register_options
                    .ok_or("missing watcher options")?,
            )
            .map_err(|e| format!("invalid watcher options: {e}"))?;
            count += options.watchers.len();
            if count > MAX_WATCHERS {
                return Err("too many watched-file rules".into());
            }
            let mut rules = Vec::with_capacity(options.watchers.len());
            for watcher in options.watchers {
                let (pattern, target) = match watcher.glob_pattern {
                    GlobPattern::String(pattern) => {
                        let target = if Path::new(&pattern).is_absolute() {
                            Target::Absolute
                        } else {
                            Target::Workspace
                        };
                        (pattern, target)
                    }
                    GlobPattern::Relative(relative) => {
                        let uri = match relative.base_uri {
                            OneOf::Left(folder) => folder.uri,
                            OneOf::Right(uri) => uri,
                        };
                        let base =
                            file_path(&uri).ok_or("watcher baseUri must be a local file URI")?;
                        if Path::new(&relative.pattern).is_absolute() {
                            return Err("relative watcher pattern must be relative".into());
                        }
                        (relative.pattern, Target::Relative(base))
                    }
                };
                bytes += pattern.len();
                if pattern.is_empty()
                    || pattern.len() > MAX_PATTERN_BYTES
                    || bytes > MAX_TOTAL_PATTERN_BYTES
                {
                    return Err("empty or oversized watched-file pattern".into());
                }
                // LSP globs use forward slashes. A single star and question mark
                // cannot cross a separator; double stars include zero directories.
                let matcher = GlobBuilder::new(&pattern)
                    .literal_separator(true)
                    .backslash_escape(true)
                    .build()
                    .map_err(|e| format!("invalid watched-file glob: {e}"))?
                    .compile_matcher();
                rules.push(Rule {
                    matcher,
                    target,
                    kind: watcher.kind.unwrap_or_else(WatchKind::all),
                    pattern_bytes: pattern.len(),
                });
            }
            pending.insert(registration.id, rules);
        }
        self.registrations.extend(pending);
        Ok(())
    }

    pub(crate) fn unregister(&mut self, params: Option<&Value>) -> Result<(), String> {
        // The misspelled `unregisterations` field is part of LSP 3.17's wire format.
        let params: UnregistrationParams =
            serde_json::from_value(params.ok_or("missing unregistration params")?.clone())
                .map_err(|e| format!("invalid unregistration params: {e}"))?;
        if params.unregisterations.len() > MAX_REGISTRATIONS
            || params
                .unregisterations
                .iter()
                .any(|r| r.id.len() > MAX_ID_BYTES)
        {
            return Err("too many or oversized unregistrations".into());
        }
        for registration in params.unregisterations {
            if registration.method == METHOD {
                self.registrations.remove(&registration.id);
            }
        }
        Ok(())
    }

    pub(crate) fn filter(&self, changes: Vec<FileEvent>) -> Vec<FileEvent> {
        let mut seen = HashMap::new();
        changes
            .into_iter()
            .filter_map(|mut event| {
                let kind = match event.typ {
                    FileChangeType::CREATED => WatchKind::Create,
                    FileChangeType::CHANGED => WatchKind::Change,
                    FileChangeType::DELETED => WatchKind::Delete,
                    _ => return None,
                };
                let path = file_path(&event.uri)?;
                if !self.roots.iter().any(|root| path.starts_with(root)) {
                    return None;
                }
                // A masked transition must still separate two observable creates.
                let repeated = seen.insert(path.clone(), event.typ) == Some(event.typ);
                let matches = self.registrations.values().flatten().any(|rule| {
                    if !rule.kind.contains(kind) {
                        return false;
                    }
                    match &rule.target {
                        Target::Absolute => rule.matcher.is_match(&path),
                        Target::Relative(base) => path
                            .strip_prefix(base)
                            .is_ok_and(|relative| rule.matcher.is_match(relative)),
                        Target::Workspace => self.roots.iter().any(|root| {
                            path.strip_prefix(root)
                                .is_ok_and(|relative| rule.matcher.is_match(relative))
                        }),
                    }
                });
                if !matches || repeated {
                    return None;
                }
                event.uri = crate::path_to_uri(&path).ok()?;
                Some(event)
            })
            .collect()
    }
}

/// Normalize URI spelling and dot segments lexically. Never canonicalize here:
/// deleted entries must still match and matching must not follow symlink targets.
fn file_path(uri: &Uri) -> Option<PathBuf> {
    let url = url::Url::parse(uri.as_str()).ok()?;
    if url.scheme() != "file" || url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    let path = url.to_file_path().ok()?;
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized.is_absolute().then_some(normalized)
}
