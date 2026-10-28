use span_core::{
    BufferRevision, BufferSnapshot, CancellationToken, CoreWorkspace, FileEntry, SearchMatch,
    SearchQuery, Settings, SettingsScope, TextEdit, Workspace,
};
use span_syntax::{SyntaxEngine, SyntaxSnapshot};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};
use tauri_specta::{collect_commands, collect_events, Builder, ErrorHandlingMode};
mod agents;
mod cli;
mod events;
mod file_index;
#[doc(hidden)]
pub mod language_servers;
mod menu;
#[doc(hidden)]
pub mod services;
pub mod session_meta;
mod startup;
mod uploads;
mod window;

/// The authoritative workspace is only accessed by blocking workers.
type FormatterJobs =
    Arc<Mutex<std::collections::HashMap<(usize, String), (u64, Option<u64>, CancellationToken)>>>;

#[derive(Clone, Default)]
pub struct DesktopState {
    pub workspace: Arc<Mutex<Option<Arc<Mutex<CoreWorkspace>>>>>,
    pub agent: Arc<Mutex<Option<agents::ActiveAgent>>>,
    pub user_settings: Arc<Mutex<Option<CoreWorkspace>>>,
    /// Every agent connection. The single agent commands use its primary one.
    pub sessions: span_acp::SessionManager,
    /// span-agents servers of the user's lead sessions (ADR 0003).
    pub leads: span_acp::tools::LeadServers,
    pub connection_gate: Arc<tokio::sync::Mutex<()>>,
    pub session_gate: Arc<tokio::sync::Mutex<()>>,
    pub startup_requests: Arc<Mutex<std::collections::VecDeque<cli::StartupRequest>>>,
    pub syntax: Arc<Mutex<SyntaxEngine>>,
    pub searches: Arc<Mutex<std::collections::HashMap<String, CancellationToken>>>,
    pub formatter_jobs: FormatterJobs,
    pub file_index: file_index::FileIndexRuntime,
    pub file_index_root: Arc<Mutex<Option<PathBuf>>>,
}

async fn with_workspace<T, F>(state: DesktopState, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut CoreWorkspace) -> span_core::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?
            .clone()
            .ok_or_else(|| "Open a folder to use the filesystem".to_owned())?;
        let mut workspace = workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?;
        operation(&mut workspace).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Workspace task failed: {error}"))?
}

async fn with_settings<T, F>(
    state: DesktopState,
    scope: SettingsScope,
    operation: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut CoreWorkspace) -> span_core::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?
            .clone();
        if let Some(workspace) = workspace.filter(|_| scope == SettingsScope::Workspace) {
            let mut workspace = workspace
                .lock()
                .map_err(|_| "Workspace state is unavailable".to_owned())?;
            operation(&mut workspace).map_err(|error| error.to_string())
        } else if scope == SettingsScope::User {
            let mut context = state
                .user_settings
                .lock()
                .map_err(|_| "User settings state is unavailable".to_owned())?;
            if context.is_none() {
                *context =
                    Some(CoreWorkspace::for_user_settings().map_err(|error| error.to_string())?);
            }
            let context = context
                .as_mut()
                .ok_or_else(|| "User settings state is unavailable".to_owned())?;
            operation(context).map_err(|error| error.to_string())
        } else {
            Err("Open a folder to use workspace settings".to_owned())
        }
    })
    .await
    .map_err(|error| format!("Settings task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
async fn open_workspace(
    state: State<'_, DesktopState>,
    lsp: State<'_, language_servers::LspService>,
    path: String,
) -> Result<Workspace, String> {
    let state = state.inner().clone();
    let lsp = lsp.inner().clone();
    let _gate = state.connection_gate.lock().await;
    let workspace = tauri::async_runtime::spawn_blocking(move || {
        CoreWorkspace::open(path).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Open folder task failed: {error}"))??;
    agents::disconnect_and_wait(&state).await?;
    services::cancel_all_formatter_jobs(&state);
    let (result, settings, workspace) = tauri::async_runtime::spawn_blocking(move || {
        let result = workspace.workspace();
        let settings = workspace.get_settings().unwrap_or_default();
        Ok::<_, String>((result, settings, workspace))
    })
    .await
    .map_err(|error| format!("Open folder task failed: {error}"))??;
    state
        .file_index
        .activate(PathBuf::from(&result.root))
        .await?;
    let worker_state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = worker_state
            .workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?;
        *guard = Some(Arc::new(Mutex::new(workspace)));
        drop(guard);
        *worker_state
            .file_index_root
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())? =
            Some(PathBuf::from(&result.root));
        // Closes the previous workspace's documents and servers; never waits for them.
        lsp.workspace_changed(std::path::PathBuf::from(&result.root), &settings);
        if let Err(error) = span_core::RecentProjectStore::for_current_user()
            .and_then(|store| store.record_open(std::path::Path::new(&result.root)))
        {
            eprintln!("Could not update project history: {error}");
        }
        Ok(result)
    })
    .await
    .map_err(|error| format!("Open folder task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
async fn list_directory(
    state: State<'_, DesktopState>,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    with_workspace(state.inner().clone(), move |workspace| {
        workspace.list_directory(&path)
    })
    .await
}

#[tauri::command]
#[specta::specta]
async fn list_files(state: State<'_, DesktopState>) -> Result<Vec<FileEntry>, String> {
    with_workspace(state.inner().clone(), |workspace| workspace.list_files()).await
}

#[tauri::command]
#[specta::specta]
async fn open_buffer(
    state: State<'_, DesktopState>,
    lsp: State<'_, language_servers::LspService>,
    path: String,
) -> Result<BufferSnapshot, String> {
    let lsp = lsp.inner().clone();
    with_workspace(state.inner().clone(), move |workspace| {
        let snapshot = workspace.open_buffer(&path)?;
        lsp.on_snapshot(&snapshot);
        Ok(snapshot)
    })
    .await
}

/// The last editor showing `path` closed or was evicted: close the document in the language
/// servers so they stop tracking (and holding memory for) a file nobody is looking at. The
/// backend reopens it on the next `open_buffer`. Returns the paths that were closed.
#[tauri::command]
#[specta::specta]
async fn buffer_released(
    lsp: State<'_, language_servers::LspService>,
    path: String,
) -> Result<Vec<String>, String> {
    Ok(lsp.on_closed(&path))
}

/// Reads a file for a preview (the Goto picker). Unlike `open_buffer` it opens no buffer
/// and never reaches the language servers, so highlighting a file starts nothing.
#[tauri::command]
#[specta::specta]
async fn peek_buffer(
    state: State<'_, DesktopState>,
    path: String,
) -> Result<BufferSnapshot, String> {
    with_workspace(state.inner().clone(), move |workspace| {
        workspace.peek_buffer(&path)
    })
    .await
}

#[tauri::command]
#[specta::specta]
async fn edit_buffer_delta(
    state: State<'_, DesktopState>,
    lsp: State<'_, language_servers::LspService>,
    path: String,
    expected_revision: u64,
    changes: Vec<TextEdit>,
) -> Result<BufferRevision, String> {
    let state = state.inner().clone();
    let lsp = lsp.inner().clone();
    let edited_path = path.clone();
    let result = with_workspace(state.clone(), move |workspace| {
        lsp.edit_buffer_delta(workspace, &path, expected_revision, changes)
    })
    .await?;
    services::cancel_formatter_jobs_for_path(&state, &edited_path);
    Ok(result)
}

#[tauri::command]
#[specta::specta]
async fn save_buffer(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    lsp: State<'_, language_servers::LspService>,
    path: String,
    expected_revision: u64,
) -> Result<BufferSnapshot, String> {
    let warning: services::FormatWarningSink = Arc::new(move |warning| {
        events::emit(&app, &warning);
    });
    let index_root = state
        .file_index_root
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?
        .clone();
    // The workspace may be switched while the save runs; remember which one this is.
    let generation = lsp.generation();
    // Saving never waits for a language server: the hooks below only queue.
    let snapshot = services::format_or_save_with_warning(
        state.inner().clone(),
        path,
        expected_revision,
        true,
        Some(warning),
    )
    .await?;
    if let Some(root) = index_root {
        let _ = state.file_index.apply_for_root(
            &root,
            span_file_index::FileEvent::Upsert(PathBuf::from(&snapshot.path)),
        );
    }
    let same_workspace = lsp.after_save(generation, &snapshot);
    if same_workspace && snapshot.path.ends_with(".span/settings.jsonc") {
        if let Ok(settings) = with_workspace(state.inner().clone(), |w| w.get_settings()).await {
            lsp.inner().apply_settings(&settings);
        }
    }
    Ok(snapshot)
}

#[tauri::command]
#[specta::specta]
async fn discard_buffer(
    state: State<'_, DesktopState>,
    lsp: State<'_, language_servers::LspService>,
    path: String,
) -> Result<BufferSnapshot, String> {
    let state = state.inner().clone();
    let lsp = lsp.inner().clone();
    let discarded_path = path.clone();
    let result = with_workspace(state.clone(), move |workspace| {
        let snapshot = workspace.discard_buffer(&path)?;
        lsp.on_discard(&snapshot);
        Ok(snapshot)
    })
    .await?;
    services::cancel_formatter_jobs_for_path(&state, &discarded_path);
    Ok(result)
}

#[tauri::command]
#[specta::specta]
async fn save_attachment(
    state: State<'_, DesktopState>,
    dir: String,
    file_name: String,
    data_base64: String,
) -> Result<span_core::SavedAttachment, String> {
    use base64::Engine;
    if data_base64.len() / 4 * 3 > span_core::MAX_ATTACHMENT_BYTES + 3 {
        return Err("Attachment is too large to save.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|_| "Attachment data is not valid base64.".to_string())?;
    with_workspace(state.inner().clone(), move |workspace| {
        workspace.save_attachment(&dir, &file_name, &bytes)
    })
    .await
}

#[tauri::command]
#[specta::specta]
async fn search(
    state: State<'_, DesktopState>,
    query: SearchQuery,
) -> Result<Vec<SearchMatch>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?
            .clone()
            .ok_or_else(|| "Open a folder before searching".to_owned())?;
        let snapshot = workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?
            .search_snapshot();
        snapshot.search(query).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Search task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
async fn search_stream(
    state: State<'_, DesktopState>,
    id: String,
    query: SearchQuery,
    on_match: tauri::ipc::Channel<SearchMatch>,
) -> Result<u32, String> {
    let state = state.inner().clone();
    let cancellation = CancellationToken::default();
    {
        let mut searches = state
            .searches
            .lock()
            .map_err(|_| "Search state is unavailable".to_owned())?;
        if searches.contains_key(&id) {
            return Err("Search ID is already active".to_owned());
        }
        searches.insert(id.clone(), cancellation.clone());
    }
    let worker_state = state.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let workspace = worker_state
            .workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?
            .clone()
            .ok_or_else(|| "Open a folder before searching".to_owned())?;
        let snapshot = workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?
            .search_snapshot();
        snapshot
            .search_stream(query, &cancellation, |found| on_match.send(found).is_ok())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Search task failed: {error}"))?;
    state
        .searches
        .lock()
        .map_err(|_| "Search state is unavailable".to_owned())?
        .remove(&id);
    result
}

#[tauri::command]
#[specta::specta]
async fn cancel_search(state: State<'_, DesktopState>, id: String) -> Result<(), String> {
    if let Some(cancellation) = state
        .searches
        .lock()
        .map_err(|_| "Search state is unavailable".to_owned())?
        .get(&id)
    {
        cancellation.cancel();
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn get_settings(state: State<'_, DesktopState>) -> Result<Settings, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = state
            .workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?;
        match guard.as_ref() {
            Some(workspace) => workspace
                .lock()
                .map_err(|_| "Workspace state is unavailable".to_owned())?
                .get_settings()
                .map_err(|error| error.to_string()),
            None => CoreWorkspace::for_user_settings()
                .and_then(|context| context.get_settings_for_scope(SettingsScope::User))
                .map_err(|error| error.to_string()),
        }
    })
    .await
    .map_err(|error| format!("Settings task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
async fn update_settings(
    state: State<'_, DesktopState>,
    lsp: State<'_, language_servers::LspService>,
    settings: Settings,
) -> Result<Settings, String> {
    let saved = with_workspace(state.inner().clone(), move |workspace| {
        workspace.update_settings(settings)
    })
    .await?;
    lsp.inner().apply_settings(&saved);
    Ok(saved)
}

#[tauri::command]
#[specta::specta]
async fn update_settings_jsonc(
    state: State<'_, DesktopState>,
    lsp: State<'_, language_servers::LspService>,
    text: String,
) -> Result<Settings, String> {
    let saved = with_workspace(state.inner().clone(), move |workspace| {
        workspace.update_settings_jsonc(&text)
    })
    .await?;
    lsp.inner().apply_settings(&saved);
    Ok(saved)
}

#[tauri::command]
#[specta::specta]
async fn get_settings_jsonc(state: State<'_, DesktopState>) -> Result<String, String> {
    with_workspace(state.inner().clone(), |workspace| {
        workspace.get_settings_jsonc()
    })
    .await
}

#[tauri::command]
#[specta::specta]
async fn syntax(state: State<'_, DesktopState>, path: String) -> Result<SyntaxSnapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?
            .clone()
            .ok_or_else(|| "Open a folder before parsing a file".to_owned())?;
        let snapshot = workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?
            .buffer_snapshot_bounded(&path, 8 * 1024 * 1024)
            .map_err(|error| error.to_string())?;
        let revision = u32::try_from(snapshot.revision)
            .map_err(|_| "Syntax revision exceeds supported range".to_owned())?;
        state
            .syntax
            .lock()
            .map_err(|_| "Syntax state is unavailable".to_owned())?
            .highlight(&path, &snapshot.text, revision, None)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Syntax task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
async fn new_file(
    state: State<'_, DesktopState>,
    lsp: State<'_, language_servers::LspService>,
    path: String,
) -> Result<BufferSnapshot, String> {
    let state = state.inner().clone();
    let lsp = lsp.inner().clone();
    let index_root = state
        .file_index_root
        .lock()
        .ok()
        .and_then(|root| root.clone());
    let snapshot = with_workspace(state.clone(), move |workspace| {
        let snapshot = workspace.new_file(&path)?;
        lsp.on_snapshot(&snapshot);
        Ok(snapshot)
    })
    .await?;
    if let Some(root) = index_root {
        let _ = state.file_index.apply_for_root(
            &root,
            span_file_index::FileEvent::Upsert(PathBuf::from(&snapshot.path)),
        );
    }
    Ok(snapshot)
}

#[tauri::command]
#[specta::specta]
async fn new_directory(state: State<'_, DesktopState>, path: String) -> Result<FileEntry, String> {
    let state = state.inner().clone();
    let entry = with_workspace(state.clone(), move |workspace| {
        workspace.new_directory(&path)
    })
    .await?;
    if entry.is_dir {
        if let Some(root) = state
            .file_index_root
            .lock()
            .ok()
            .and_then(|root| root.clone())
        {
            let _ = state.file_index.reconcile(&root);
        }
    }
    Ok(entry)
}

#[tauri::command]
#[specta::specta]
async fn rename_path(
    state: State<'_, DesktopState>,
    lsp: State<'_, language_servers::LspService>,
    from: String,
    to: String,
) -> Result<FileEntry, String> {
    let state = state.inner().clone();
    let lsp = lsp.inner().clone();
    let index_root = state
        .file_index_root
        .lock()
        .ok()
        .and_then(|root| root.clone());
    let worker_from = from.clone();
    let worker_to = to.clone();
    let entry = with_workspace(state.clone(), move |workspace| {
        let entry = workspace.rename_path(&worker_from, &worker_to)?;
        // The old paths leave the servers; the buffers that moved with the rename
        // are opened again under their new paths.
        for old in lsp.on_closed(&worker_from) {
            let suffix = old.strip_prefix(worker_from.as_str()).unwrap_or("");
            let new = format!("{}{suffix}", entry.path);
            if let Ok(snapshot) = workspace.buffer_snapshot(&new) {
                lsp.on_snapshot(&snapshot);
            }
        }
        Ok(entry)
    })
    .await?;
    if let Some(root) = index_root {
        let event = if entry.is_dir {
            state.file_index.reconcile(&root).map(|_| ())
        } else {
            state.file_index.apply_for_root(
                &root,
                span_file_index::FileEvent::Rename {
                    from: PathBuf::from(from),
                    to: PathBuf::from(&entry.path),
                },
            )
        };
        if let Err(error) = event {
            eprintln!("Could not update file index after rename: {error}");
        }
    }
    Ok(entry)
}

#[tauri::command]
#[specta::specta]
async fn duplicate_path(
    state: State<'_, DesktopState>,
    lsp: State<'_, language_servers::LspService>,
    from: String,
    to: String,
) -> Result<FileEntry, String> {
    let state = state.inner().clone();
    let lsp = lsp.inner().clone();
    let index_root = state
        .file_index_root
        .lock()
        .ok()
        .and_then(|root| root.clone());
    let entry = with_workspace(state.clone(), move |workspace| {
        let entry = workspace.duplicate_path(&from, &to)?;
        // A copied source file reaches the servers like any created file.
        if !entry.is_dir && lsp.handles_path(&entry.path) {
            if let Ok(snapshot) = workspace.open_buffer(&entry.path) {
                lsp.on_snapshot(&snapshot);
            }
        }
        Ok(entry)
    })
    .await?;
    if let Some(root) = index_root {
        let result = if entry.is_dir {
            state.file_index.reconcile(&root).map(|_| ())
        } else {
            state.file_index.apply_for_root(
                &root,
                span_file_index::FileEvent::Upsert(PathBuf::from(&entry.path)),
            )
        };
        if let Err(error) = result {
            eprintln!("Could not update file index after duplicate: {error}");
        }
    }
    Ok(entry)
}

#[tauri::command]
#[specta::specta]
async fn trash_path(
    state: State<'_, DesktopState>,
    lsp: State<'_, language_servers::LspService>,
    path: String,
) -> Result<Vec<String>, String> {
    let state = state.inner().clone();
    let lsp = lsp.inner().clone();
    let index_root = state
        .file_index_root
        .lock()
        .ok()
        .and_then(|root| root.clone());
    let absolute = index_root.as_ref().map(|root| root.join(&path));
    let is_dir = absolute.as_ref().is_some_and(|path| path.is_dir());
    let removed = with_workspace(state.clone(), move |workspace| {
        let removed = workspace.trash_path(&path)?;
        lsp.on_closed(&path);
        Ok(removed)
    })
    .await?;
    if let (Some(root), Some(absolute)) = (index_root, absolute) {
        let result = if is_dir {
            state.file_index.reconcile(&root).map(|_| ())
        } else {
            state
                .file_index
                .apply_for_root(&root, span_file_index::FileEvent::Remove(absolute))
        };
        if let Err(error) = result {
            eprintln!("Could not update file index after trash: {error}");
        }
    }
    Ok(removed)
}

#[tauri::command]
#[specta::specta]
async fn get_settings_for_scope(
    state: State<'_, DesktopState>,
    scope: SettingsScope,
) -> Result<Settings, String> {
    with_settings(state.inner().clone(), scope, move |workspace| {
        workspace.get_settings_for_scope(scope)
    })
    .await
}

#[tauri::command]
#[specta::specta]
async fn get_settings_jsonc_for_scope(
    state: State<'_, DesktopState>,
    scope: SettingsScope,
) -> Result<String, String> {
    with_settings(state.inner().clone(), scope, move |workspace| {
        workspace.get_settings_jsonc_for_scope(scope)
    })
    .await
}

#[tauri::command]
#[specta::specta]
async fn get_settings_keys_for_scope(
    state: State<'_, DesktopState>,
    scope: SettingsScope,
) -> Result<Vec<String>, String> {
    with_settings(state.inner().clone(), scope, move |workspace| {
        workspace.get_settings_keys_for_scope(scope)
    })
    .await
}

/// Push the effective (user plus workspace) settings to the language server service after a
/// scoped settings change. With no workspace open there is nothing running to update.
async fn apply_effective_settings(state: &DesktopState, lsp: &language_servers::LspService) {
    if let Ok(effective) = with_workspace(state.clone(), |workspace| workspace.get_settings()).await
    {
        lsp.apply_settings(&effective);
    }
}

#[tauri::command]
#[specta::specta]
async fn update_settings_jsonc_for_scope(
    state: State<'_, DesktopState>,
    lsp: State<'_, language_servers::LspService>,
    scope: SettingsScope,
    text: String,
) -> Result<Settings, String> {
    let saved = with_settings(state.inner().clone(), scope, move |workspace| {
        workspace.update_settings_jsonc_for_scope(scope, &text)
    })
    .await?;
    apply_effective_settings(state.inner(), lsp.inner()).await;
    Ok(saved)
}

#[tauri::command]
#[specta::specta]
async fn update_setting(
    state: State<'_, DesktopState>,
    lsp: State<'_, language_servers::LspService>,
    scope: SettingsScope,
    key: String,
    value_json: Option<String>,
) -> Result<Settings, String> {
    let saved = with_settings(state.inner().clone(), scope, move |workspace| {
        workspace.update_setting(scope, &key, value_json.as_deref())
    })
    .await?;
    apply_effective_settings(state.inner(), lsp.inner()).await;
    Ok(saved)
}

#[tauri::command]
#[specta::specta]
async fn open_settings_buffer(
    state: State<'_, DesktopState>,
    scope: SettingsScope,
) -> Result<BufferSnapshot, String> {
    with_settings(state.inner().clone(), scope, move |workspace| {
        workspace.open_settings_buffer(scope)
    })
    .await
}

#[tauri::command]
#[specta::specta]
async fn edit_settings_buffer(
    state: State<'_, DesktopState>,
    scope: SettingsScope,
    expected_revision: u64,
    changes: Vec<TextEdit>,
) -> Result<BufferRevision, String> {
    with_settings(state.inner().clone(), scope, move |workspace| {
        workspace.edit_settings_buffer(scope, expected_revision, changes)
    })
    .await
}

#[tauri::command]
#[specta::specta]
async fn save_settings_buffer(
    state: State<'_, DesktopState>,
    lsp: State<'_, language_servers::LspService>,
    scope: SettingsScope,
    expected_revision: u64,
) -> Result<BufferSnapshot, String> {
    let saved = with_settings(state.inner().clone(), scope, move |workspace| {
        workspace.save_settings_buffer(scope, expected_revision)
    })
    .await?;
    apply_effective_settings(state.inner(), lsp.inner()).await;
    Ok(saved)
}

#[tauri::command]
#[specta::specta]
async fn discard_settings_buffer(
    state: State<'_, DesktopState>,
    scope: SettingsScope,
) -> Result<BufferSnapshot, String> {
    with_settings(state.inner().clone(), scope, move |workspace| {
        workspace.discard_settings_buffer(scope)
    })
    .await
}

pub fn ipc_builder() -> Builder<tauri::Wry> {
    Builder::new()
        .error_handling(ErrorHandlingMode::Throw)
        // Revisions and offsets are bounded by available document memory, below JS integer precision.
        .dangerously_cast_bigints_to_number()
        .events(collect_events![
            services::FormatWarning,
            menu::NativeActionEvent,
            startup::StartupRequestsChanged,
            language_servers::LanguageServerStateChanged,
            language_servers::LanguageServerInstallProgress,
            language_servers::DiagnosticsPublished,
            language_servers::LanguageServerError,
            startup::StartupRequestError,
            agents::AgentSessionStatesChanged
        ])
        .commands(collect_commands![
            open_workspace,
            list_directory,
            list_files,
            file_index::file_index_status,
            file_index::query_file,
            file_index::reconcile_file_index,
            new_file,
            new_directory,
            rename_path,
            duplicate_path,
            trash_path,
            open_buffer,
            peek_buffer,
            buffer_released,
            edit_buffer_delta,
            save_buffer,
            discard_buffer,
            save_attachment,
            search,
            search_stream,
            cancel_search,
            get_settings,
            get_settings_for_scope,
            open_settings_buffer,
            edit_settings_buffer,
            save_settings_buffer,
            discard_settings_buffer,
            get_settings_jsonc_for_scope,
            get_settings_keys_for_scope,
            update_settings_jsonc_for_scope,
            update_setting,
            update_settings,
            update_settings_jsonc,
            get_settings_jsonc,
            services::format_buffer,
            services::cancel_format_buffer,
            services::get_session,
            services::save_session,
            services::list_tools,
            services::recent_projects,
            services::remove_recent_project,
            services::clear_recent_projects,
            services::native_window_state,
            services::read_clipboard,
            services::write_clipboard,
            startup::take_startup_requests,
            startup::enqueue_dropped_paths,
            services::open_external,
            services::read_image,
            menu::sync_native_menu,
            syntax,
            session_meta::session_meta_list,
            session_meta::session_meta_update,
            session_meta::session_meta_set_title,
            session_meta::session_meta_set_archived,
            session_meta::session_meta_delete,
            session_meta::session_export_markdown,
            agents::agent_registry,
            agents::agent_installed,
            agents::agent_install,
            agents::agent_remove,
            agents::agent_update_status,
            agents::app_update_check,
            agents::agent_connect,
            agents::agent_new_session,
            agents::agent_list_sessions,
            agents::agent_resume_session,
            agents::agent_close_session,
            agents::agent_delete_session,
            agents::agent_prompt,
            agents::agent_session_states,
            agents::agent_authenticate,
            agents::agent_authenticate_with,
            agents::agent_presets,
            agents::agent_elicitation,
            agents::agent_set_config,
            agents::agent_cancel,
            agents::agent_disconnect,
            agents::agent_permission,
            agents::agent_review,
            agents::agent_review_hunks,
            language_servers::lsp_completion,
            language_servers::lsp_hover,
            language_servers::lsp_definition,
            language_servers::lsp_format,
            language_servers::lsp_cancel,
            language_servers::lsp_install,
            language_servers::lsp_restart,
            language_servers::lsp_status,
            agents::agent_delegation_status,
            agents::agent_child_permission,
            agents::agent_cancel_task,
            uploads::uploads_list,
            uploads::uploads_usage,
            uploads::uploads_add,
            uploads::uploads_read,
            uploads::uploads_rename,
            uploads::uploads_duplicate,
            uploads::uploads_remove,
            uploads::uploads_save_to_workspace,
            uploads::uploads_copy_path,
            uploads::uploads_reveal,
            uploads::uploads_open,
            window::report_startup_timings,
            window::show_main_window
        ])
}

pub fn export_bindings() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/src/bindings.ts");
    ipc_builder().export(specta_typescript::Typescript::default(), path)?;
    Ok(())
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    window::mark_process_start();
    let action = cli::parse_args(std::env::args().skip(1), &std::env::current_dir()?)?;
    let request = match action {
        cli::CliAction::Help => {
            print!("{}", cli::HELP);
            return Ok(());
        }
        cli::CliAction::Version => {
            println!("span {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        cli::CliAction::Open(request) => request,
    };
    let state = DesktopState::default();
    startup::enqueue(&state, request)?;
    let builder = ipc_builder();
    // Production launches must not write development files into the source checkout.
    #[cfg(debug_assertions)]
    export_bindings()?;
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(startup::forwarded))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state)
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            events::mark_mounted(app);
            let cache = app.path().app_cache_dir()?.join("language-servers");
            app.manage(language_servers::production(
                cache,
                language_servers::tauri_sink(app.handle().clone()),
            ));
            agents::watch_session_states(app.handle());
            menu::install(app.handle())?;
            // The window starts hidden; the frontend shows it once the session has rendered (its
            // own cap is 2s after the first render). This only catches a frontend that never
            // reports, and leaves room for a slow first load of the development server.
            window::show_if_still_hidden(app.handle(), std::time::Duration::from_secs(6));
            window::log_window_created();
            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop {
                        paths, ..
                    }) = event
                    {
                        startup::receive_drop(handle.clone(), paths.clone());
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())?;
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = &event {
            if let Some(window) = app.get_webview_window("main") {
                // Route app quit through the frontend's unsaved-buffer close review.
                api.prevent_exit();
                if let Err(error) = window.close() {
                    eprintln!("Could not request window close: {error}");
                }
            }
        }
        if matches!(event, tauri::RunEvent::Exit) {
            let state = app.state::<DesktopState>();
            let _ = agents::disconnect(&state);
            state.file_index.shutdown();
            // Bounded: a server that ignores shutdown is killed, never waited on forever.
            app.state::<language_servers::LspService>()
                .shutdown_blocking(std::time::Duration::from_secs(8));
            state.leads.shutdown_all();
            if let Ok(searches) = state.searches.lock() {
                for cancellation in searches.values() {
                    cancellation.cancel();
                }
            };
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn user_settings_context_works_without_exposing_a_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let state = super::DesktopState::default();
        let context = span_core::CoreWorkspace::for_user_settings()
            .unwrap()
            .with_user_settings(Some(directory.path().join("settings.jsonc")));
        *state.user_settings.lock().unwrap() = Some(context);
        let snapshot =
            super::with_settings(state.clone(), span_core::SettingsScope::User, |context| {
                context.open_settings_buffer(span_core::SettingsScope::User)
            })
            .await
            .unwrap();
        assert_eq!(snapshot.path, "settings://user");
        assert!(state.workspace.lock().unwrap().is_none());
        assert!(super::with_settings(
            state.clone(),
            span_core::SettingsScope::Workspace,
            |context| context.get_settings()
        )
        .await
        .is_err());
        assert!(
            super::with_workspace(state.clone(), |context| context.list_files())
                .await
                .is_err()
        );
        assert!(
            super::with_settings(state, span_core::SettingsScope::User, |context| context
                .open_buffer("settings.jsonc"))
            .await
            .is_err()
        );
    }

    #[test]
    fn export_typescript_bindings() -> Result<(), Box<dyn std::error::Error>> {
        super::export_bindings()
    }
}
