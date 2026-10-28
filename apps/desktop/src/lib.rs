use span_core::{
    BufferRevision, BufferSnapshot, CancellationToken, CoreWorkspace, FileEntry, SearchMatch,
    SearchQuery, Settings, TextEdit, Workspace,
};
use span_syntax::{SyntaxEngine, SyntaxSnapshot};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};
use tauri_specta::{collect_commands, collect_events, Builder, ErrorHandlingMode};
mod agents;
mod cli;
mod menu;
mod services;
mod startup;

/// The authoritative workspace is only accessed by blocking workers.
#[derive(Clone, Default)]
pub struct DesktopState {
    pub workspace: Arc<Mutex<Option<Arc<Mutex<CoreWorkspace>>>>>,
    pub agent: Arc<Mutex<Option<agents::ActiveAgent>>>,
    pub connection_gate: Arc<tokio::sync::Mutex<()>>,
    pub session_gate: Arc<tokio::sync::Mutex<()>>,
    pub startup_requests: Arc<Mutex<std::collections::VecDeque<cli::StartupRequest>>>,
    pub syntax: Arc<Mutex<SyntaxEngine>>,
    pub searches: Arc<Mutex<std::collections::HashMap<String, CancellationToken>>>,
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

#[tauri::command]
#[specta::specta]
async fn open_workspace(state: State<'_, DesktopState>, path: String) -> Result<Workspace, String> {
    let state = state.inner().clone();
    let _gate = state.connection_gate.lock().await;
    let worker_state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = CoreWorkspace::open(path).map_err(|error| error.to_string())?;
        let result = workspace.workspace();
        agents::disconnect(&worker_state)?;
        let mut guard = worker_state
            .workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?;
        *guard = Some(Arc::new(Mutex::new(workspace)));
        drop(guard);
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
    path: String,
) -> Result<BufferSnapshot, String> {
    with_workspace(state.inner().clone(), move |workspace| {
        workspace.open_buffer(&path)
    })
    .await
}

#[tauri::command]
#[specta::specta]
async fn edit_buffer_delta(
    state: State<'_, DesktopState>,
    path: String,
    expected_revision: u64,
    changes: Vec<TextEdit>,
) -> Result<BufferRevision, String> {
    with_workspace(state.inner().clone(), move |workspace| {
        workspace.edit_buffer_delta(&path, expected_revision, changes)
    })
    .await
}

#[tauri::command]
#[specta::specta]
async fn save_buffer(
    state: State<'_, DesktopState>,
    path: String,
    expected_revision: u64,
) -> Result<BufferSnapshot, String> {
    services::format_or_save(state.inner().clone(), path, expected_revision, true).await
}

#[tauri::command]
#[specta::specta]
async fn discard_buffer(
    state: State<'_, DesktopState>,
    path: String,
) -> Result<BufferSnapshot, String> {
    with_workspace(state.inner().clone(), move |workspace| {
        workspace.discard_buffer(&path)
    })
    .await
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
            None => Ok(Settings::default()),
        }
    })
    .await
    .map_err(|error| format!("Settings task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
async fn update_settings(
    state: State<'_, DesktopState>,
    settings: Settings,
) -> Result<Settings, String> {
    with_workspace(state.inner().clone(), move |workspace| {
        workspace.update_settings(settings)
    })
    .await
}

#[tauri::command]
#[specta::specta]
async fn update_settings_jsonc(
    state: State<'_, DesktopState>,
    text: String,
) -> Result<Settings, String> {
    with_workspace(state.inner().clone(), move |workspace| {
        workspace.update_settings_jsonc(&text)
    })
    .await
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

pub fn ipc_builder() -> Builder<tauri::Wry> {
    Builder::new()
        .error_handling(ErrorHandlingMode::Throw)
        // Revisions and offsets are bounded by available document memory, below JS integer precision.
        .dangerously_cast_bigints_to_number()
        .events(collect_events![
            menu::NativeActionEvent,
            startup::StartupRequestsChanged
        ])
        .commands(collect_commands![
            open_workspace,
            list_directory,
            list_files,
            open_buffer,
            edit_buffer_delta,
            save_buffer,
            discard_buffer,
            save_attachment,
            search,
            search_stream,
            cancel_search,
            get_settings,
            update_settings,
            update_settings_jsonc,
            get_settings_jsonc,
            services::format_buffer,
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
            services::open_external,
            services::read_image,
            menu::sync_native_menu,
            syntax,
            agents::agent_registry,
            agents::agent_installed,
            agents::agent_install,
            agents::agent_connect,
            agents::agent_new_session,
            agents::agent_list_sessions,
            agents::agent_resume_session,
            agents::agent_prompt,
            agents::agent_authenticate,
            agents::agent_elicitation,
            agents::agent_set_config,
            agents::agent_cancel,
            agents::agent_disconnect,
            agents::agent_permission,
            agents::agent_review,
            agents::agent_review_hunks
        ])
}

pub fn export_bindings() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/src/bindings.ts");
    ipc_builder().export(specta_typescript::Typescript::default(), path)?;
    Ok(())
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
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
            menu::install(app.handle())?;
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
    #[test]
    fn export_typescript_bindings() -> Result<(), Box<dyn std::error::Error>> {
        super::export_bindings()
    }
}
