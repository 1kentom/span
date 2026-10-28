use crate::{io_error, workspace::atomic_write, CoreError, Result};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum MarkdownView {
    Source,
    Preview,
    Both,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroup {
    pub paths: Vec<String>,
    pub active_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionPanels {
    pub project_width: u32,
    pub assistant_width: u32,
    pub terminal_height: u32,
    pub project_collapsed: bool,
    pub assistant_collapsed: bool,
    pub terminal_collapsed: bool,
}
impl Default for SessionPanels {
    fn default() -> Self {
        Self {
            project_width: 230,
            assistant_width: 380,
            terminal_height: 230,
            project_collapsed: false,
            assistant_collapsed: false,
            terminal_collapsed: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub workspace_root: String,
    pub groups: Vec<SessionGroup>,
    pub active_group: u32,
    pub panels: SessionPanels,
    pub markdown_views: HashMap<String, MarkdownView>,
    /// Two editor groups are stacked (one above the other) instead of side by side.
    #[serde(default)]
    pub split_vertical: bool,
}

pub struct SessionStore {
    path: PathBuf,
}
impl SessionStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
    pub fn for_current_user() -> Result<Self> {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .ok_or_else(|| {
                CoreError::Settings("Cannot locate user profile for session storage".into())
            })?;
        Ok(Self::new(
            PathBuf::from(home).join(".config/span/session.json"),
        ))
    }
    pub fn load(&self) -> Result<Option<SessionState>> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error("Read previous session", &self.path, error)),
        };
        if text.len() > 1024 * 1024 {
            return Err(CoreError::Settings("Session file exceeds 1 MiB".into()));
        }
        let state: SessionState = serde_json::from_str(&text)
            .map_err(|error| CoreError::Settings(format!("Read previous session: {error}")))?;
        if !Path::new(&state.workspace_root).is_dir() {
            return Ok(None);
        }
        Ok(Some(sanitize(state)?))
    }
    pub fn save(&self, state: SessionState) -> Result<()> {
        let state = sanitize(state)?;
        let text = serde_json::to_vec_pretty(&state)
            .map_err(|error| CoreError::Settings(error.to_string()))?;
        let parent = self
            .path
            .parent()
            .ok_or_else(|| CoreError::Settings("Invalid session storage path".into()))?;
        fs::create_dir_all(parent)
            .map_err(|error| io_error("Create session profile", parent, error))?;
        atomic_write(&self.path, &text)
    }
}

fn sanitize(mut state: SessionState) -> Result<SessionState> {
    let workspace = crate::CoreWorkspace::open(&state.workspace_root)?;
    state.workspace_root = workspace.workspace().root;
    if state.groups.is_empty()
        || state.groups.len() > 8
        || state
            .groups
            .iter()
            .map(|group| group.paths.len())
            .sum::<usize>()
            > 256
    {
        return Err(CoreError::Settings(
            "Session must contain 1 to 8 groups and at most 256 files".into(),
        ));
    }
    for group in &mut state.groups {
        let mut paths = Vec::new();
        for path in &group.paths {
            let Ok(resolved) = workspace.resolve(path) else {
                continue;
            };
            if !resolved.is_file() {
                continue;
            }
            let relative = workspace.relative(&resolved)?;
            if !paths.contains(&relative) {
                paths.push(relative);
            }
        }
        group.active_path = group
            .active_path
            .as_ref()
            .filter(|active| paths.contains(active))
            .cloned()
            .or_else(|| paths.first().cloned());
        group.paths = paths;
    }
    state.active_group = state
        .active_group
        .min(state.groups.len().saturating_sub(1) as u32);
    state.panels.project_width = state.panels.project_width.clamp(120, 1000);
    state.panels.assistant_width = state.panels.assistant_width.clamp(120, 1000);
    state.panels.terminal_height = state.panels.terminal_height.clamp(80, 1000);
    state
        .markdown_views
        .retain(|path, _| state.groups.iter().any(|group| group.paths.contains(path)));
    Ok(state)
}
