//! Discovery preferences shared by lazy Explorer reads and background scans.
use ignore::WalkBuilder;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScanVisibility {
    pub show_hidden_files: bool,
    pub show_ignored_files: bool,
}
impl Default for ScanVisibility {
    fn default() -> Self {
        Self {
            show_hidden_files: true,
            show_ignored_files: false,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanPurpose {
    Explorer,
    Background,
}

fn directory(entry: &ignore::DirEntry) -> bool {
    entry
        .file_type()
        .is_some_and(|kind| kind.is_dir() || kind.is_symlink())
}
fn metadata_name(name: &std::ffi::OsStr) -> bool {
    [".git", ".hg", ".svn", ".DS_Store", "Thumbs.db"]
        .iter()
        .any(|candidate| name == *candidate)
}
fn recognized_output(path: &Path, is_dir: bool) -> bool {
    if !is_dir {
        return false;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    match path.file_name().and_then(|name| name.to_str()) {
        Some("target") => parent.join("Cargo.toml").is_file(),
        Some("dist" | "build" | ".next" | ".nuxt") => parent.join("package.json").is_file(),
        Some(".venv" | "venv") => path.join("pyvenv.cfg").is_file(),
        _ => false,
    }
}
/// Background work does not traverse dependencies or recognized *ignored*
/// outputs. A source directory named build is not excluded by its name alone.
pub fn background_excluded(path: &Path, is_dir: bool, ignored: bool) -> bool {
    is_dir && path.file_name().is_some_and(|name| name == "node_modules")
        || ignored && recognized_output(path, is_dir)
}
fn ignore_walker(root: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder.hidden(false).require_git(false).follow_links(false);
    builder
}
/// One ancestor-only ignore walk, used only for potential output directories.
/// It never scans unrelated subtrees or executes Git/repository configuration.
fn ignored_path(root: &Path, path: &Path) -> bool {
    let relative = match path.strip_prefix(root) {
        Ok(relative) => relative,
        Err(_) => return true,
    };
    let target = path.to_owned();
    let parents = path.parent().unwrap_or(root).to_owned();
    let mut builder = ignore_walker(root);
    builder
        .max_depth(Some(relative.components().count()))
        .filter_entry(move |entry| {
            entry.depth() == 0 || entry.path() == target || parents.starts_with(entry.path())
        });
    !builder
        .build()
        .filter_map(Result::ok)
        .any(|entry| entry.path() == path)
}
impl ScanVisibility {
    pub fn walker(self, root: &Path, purpose: ScanPurpose) -> WalkBuilder {
        let mut builder = WalkBuilder::new(root);
        builder
            .hidden(!self.show_hidden_files)
            .ignore(!self.show_ignored_files)
            .git_ignore(!self.show_ignored_files)
            .git_global(!self.show_ignored_files)
            .git_exclude(!self.show_ignored_files)
            .require_git(false)
            .follow_links(false);
        let scope = root.to_owned();
        builder.filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            if metadata_name(entry.file_name()) {
                return false;
            }
            let is_dir = directory(entry);
            if is_dir && entry.file_name() == "node_modules" {
                return purpose == ScanPurpose::Explorer && self.show_ignored_files;
            }
            if purpose == ScanPurpose::Background
                && self.show_ignored_files
                && recognized_output(entry.path(), is_dir)
                && ignored_path(&scope, entry.path())
            {
                return false;
            }
            true
        });
        builder
    }
    pub fn visible_background_file(self, root: &Path, path: &Path) -> bool {
        self.visible_path(root, path, ScanPurpose::Background)
    }
    /// Check one existing path without traversing unrelated subtrees. Directory
    /// reads use this to retain hidden/ignored ancestor policy on explicit expansion.
    pub fn visible_path(self, root: &Path, path: &Path, purpose: ScanPurpose) -> bool {
        if path == root {
            return true;
        }
        let Some(parent) = path.parent() else {
            return false;
        };
        let Ok(relative) = path.strip_prefix(root) else {
            return false;
        };
        if relative
            .components()
            .any(|part| metadata_name(part.as_os_str()))
        {
            return false;
        }
        let target = path.to_owned();
        let parents = parent.to_owned();
        let mut builder = self.walker(root, purpose);
        builder.max_depth(Some(relative.components().count()));
        // filter_entry replaces the builder's earlier filter, so keep its exact
        // discovery policy in this bounded ancestor walk too.
        let scope = root.to_owned();
        builder.filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            if entry.path() != target && !parents.starts_with(entry.path()) {
                return false;
            }
            if metadata_name(entry.file_name()) {
                return false;
            }
            let is_dir = directory(entry);
            if is_dir && entry.file_name() == "node_modules" {
                return purpose == ScanPurpose::Explorer && self.show_ignored_files;
            }
            !(purpose == ScanPurpose::Background
                && self.show_ignored_files
                && recognized_output(entry.path(), is_dir)
                && ignored_path(&scope, entry.path()))
        });
        builder
            .build()
            .filter_map(Result::ok)
            .any(|entry| entry.path() == path)
    }
}
/// Mark immediate Explorer children using a single ignore-respecting walk.
/// Starting at the workspace root preserves ignored-ancestor semantics when an
/// ignored folder is explicitly expanded.
pub fn unignored_children(root: &Path, directory: &Path) -> HashSet<PathBuf> {
    let Ok(relative) = directory.strip_prefix(root) else {
        return HashSet::new();
    };
    let target = directory.to_owned();
    let mut builder = ignore_walker(root);
    builder
        .max_depth(Some(relative.components().count() + 1))
        .filter_entry(move |entry| {
            entry.depth() == 0
                || target.starts_with(entry.path())
                || entry.path().parent() == Some(target.as_path())
        });
    builder
        .build()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().parent() == Some(directory))
        .map(|entry| entry.into_path())
        .collect()
}
