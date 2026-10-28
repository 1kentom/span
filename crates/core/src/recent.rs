use crate::{io_error, workspace::atomic_write, CoreError, Result};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_PROJECTS: usize = 50;
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub root: String,
    pub name: String,
    /// Unix milliseconds, represented as a JSON number.
    pub last_opened: f64,
    #[serde(default)]
    pub missing: bool,
}

/// Independent history, so clearing history never deletes workspace files or the saved session.
pub struct RecentProjectStore {
    path: PathBuf,
}
impl RecentProjectStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
    pub fn for_current_user() -> Result<Self> {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .ok_or_else(|| {
                CoreError::Settings("Cannot locate user profile for recent projects".into())
            })?;
        Ok(Self::new(
            PathBuf::from(home).join(".config/span/recent-projects.json"),
        ))
    }
    pub fn load(&self) -> Result<Vec<RecentProject>> {
        let _lock = self.lock()?;
        self.read()
    }
    pub fn record_open(&self, root: &Path) -> Result<Vec<RecentProject>> {
        let root = fs::canonicalize(root).map_err(|e| io_error("Open recent project", root, e))?;
        if !root.is_dir() {
            return Err(CoreError::Settings(
                "Recent project must be a directory".into(),
            ));
        }
        let root_text = path_string(&root)?;
        let name = root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| root_text.clone());
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as f64;
        let _lock = self.lock()?;
        let mut projects = self.read()?;
        projects.retain(|p| !same_root(&p.root, &root_text));
        projects.insert(
            0,
            RecentProject {
                root: root_text,
                name,
                last_opened: now,
                missing: false,
            },
        );
        projects.truncate(MAX_PROJECTS);
        self.write(&projects)?;
        Ok(projects)
    }
    pub fn remove(&self, root: &str) -> Result<Vec<RecentProject>> {
        let canonical = fs::canonicalize(root)
            .ok()
            .and_then(|path| path.to_str().map(str::to_owned));
        let root = canonical.as_deref().unwrap_or(root);
        let _lock = self.lock()?;
        let mut projects = self.read()?;
        projects.retain(|project| !same_root(&project.root, root));
        self.write(&projects)?;
        Ok(projects)
    }
    pub fn clear(&self) -> Result<()> {
        let _lock = self.lock()?;
        self.write(&[])
    }
    fn lock(&self) -> Result<File> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| CoreError::Settings("Invalid recent project storage path".into()))?;
        fs::create_dir_all(parent)
            .map_err(|e| io_error("Create recent project profile", parent, e))?;
        let lock_path = self.path.with_extension("json.lock");
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .map_err(|e| io_error("Open recent project lock", &lock_path, e))?;
        file.lock()
            .map_err(|e| io_error("Lock recent projects", &lock_path, e))?;
        Ok(file)
    }
    fn read(&self) -> Result<Vec<RecentProject>> {
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(io_error("Read recent projects", &self.path, e)),
        };
        let mut text = String::new();
        file.take(MAX_BYTES + 1)
            .read_to_string(&mut text)
            .map_err(|e| io_error("Read recent projects", &self.path, e))?;
        if text.len() as u64 > MAX_BYTES {
            return Err(CoreError::Settings(
                "Recent projects file exceeds 1 MiB".into(),
            ));
        }
        let projects: Vec<RecentProject> = serde_json::from_str(&text)
            .map_err(|e| CoreError::Settings(format!("Read recent projects: {e}")))?;
        let mut unique: Vec<RecentProject> = vec![];
        for mut project in projects {
            if !Path::new(&project.root).is_absolute() || !project.last_opened.is_finite() {
                return Err(CoreError::Settings("Invalid recent project record".into()));
            }
            if let Ok(root) = fs::canonicalize(&project.root) {
                project.root = path_string(&root)?;
            }
            project.missing = !Path::new(&project.root).is_dir();
            if !unique.iter().any(|p| same_root(&p.root, &project.root)) {
                unique.push(project);
            }
            if unique.len() == MAX_PROJECTS {
                break;
            }
        }
        Ok(unique)
    }
    fn write(&self, projects: &[RecentProject]) -> Result<()> {
        let bytes =
            serde_json::to_vec_pretty(projects).map_err(|e| CoreError::Settings(e.to_string()))?;
        atomic_write(&self.path, &bytes)
    }
}
fn path_string(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| CoreError::Settings("Project path is not valid Unicode".into()))
}
fn same_root(a: &str, b: &str) -> bool {
    #[cfg(windows)]
    {
        a.eq_ignore_ascii_case(b)
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deduplicates_canonical_paths_and_preserves_missing_roots() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        let store = RecentProjectStore::new(temp.path().join("profile/recent.json"));
        store.record_open(&root).unwrap();
        store.record_open(&root.join(".")).unwrap();
        assert_eq!(store.load().unwrap().len(), 1);
        fs::remove_dir(&root).unwrap();
        assert!(store.load().unwrap()[0].missing);
        let recorded_root = store.load().unwrap()[0].root.clone();
        assert!(store.remove(&recorded_root).unwrap().is_empty());
    }
    #[test]
    fn bounded_history_and_clear_leave_code_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let store = RecentProjectStore::new(temp.path().join("recent.json"));
        for i in 0..55 {
            let root = temp.path().join(format!("project-{i}"));
            fs::create_dir(&root).unwrap();
            store.record_open(&root).unwrap();
        }
        assert_eq!(store.load().unwrap().len(), 50);
        let code = temp.path().join("project-54/code.rs");
        fs::write(&code, "precious").unwrap();
        store
            .remove(temp.path().join("project-54").to_str().unwrap())
            .unwrap();
        assert_eq!(fs::read_to_string(&code).unwrap(), "precious");
        store.clear().unwrap();
        assert!(store.load().unwrap().is_empty());
        assert!(code.exists());
    }
    #[test]
    fn corrupt_history_is_reported_and_not_overwritten_on_open() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("recent.json");
        fs::write(&path, "broken JSON").unwrap();
        let store = RecentProjectStore::new(&path);
        assert!(store.load().is_err());
        assert!(store.record_open(temp.path()).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "broken JSON");
    }
    #[test]
    fn concurrent_updates_keep_all_projects() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("recent.json");
        let workers: Vec<_> = (0..12)
            .map(|i| {
                let root = temp.path().join(format!("project-{i}"));
                fs::create_dir(&root).unwrap();
                let path = path.clone();
                std::thread::spawn(move || {
                    RecentProjectStore::new(path).record_open(&root).unwrap()
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(RecentProjectStore::new(path).load().unwrap().len(), 12);
    }
}
