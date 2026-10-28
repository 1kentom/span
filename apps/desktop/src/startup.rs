use crate::{
    cli::{CliAction, StartupRequest},
    DesktopState,
};
use serde::Serialize;
use specta::Type;
use tauri::{Manager, State};
use tauri_specta::Event;

#[derive(Clone, Serialize, Type, Event)]
pub struct StartupRequestsChanged {
    pub pending: bool,
}

#[derive(Clone, Serialize, Type, Event)]
pub struct StartupRequestError {
    pub message: String,
}

pub fn receive_drop(app: tauri::AppHandle, paths: Vec<std::path::PathBuf>) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<DesktopState>().inner().clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let paths = paths
                .into_iter()
                .map(|path| {
                    path.into_os_string()
                        .into_string()
                        .map_err(|_| "Dropped path is not valid Unicode".to_owned())
                })
                .collect::<Result<Vec<_>, _>>()?;
            let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
            enqueue(&state, paths_request(paths, &cwd)?)
        })
        .await
        .map_err(|error| format!("Open dropped paths task failed: {error}"))
        .and_then(|result| result);
        match result {
            Ok(()) => {
                let _ = (StartupRequestsChanged { pending: true }).emit(&app);
            }
            Err(message) => {
                let _ = (StartupRequestError { message }).emit(&app);
            }
        }
    });
}

pub fn enqueue(state: &DesktopState, request: StartupRequest) -> Result<(), String> {
    if request.workspace_root.is_none() && request.files.is_empty() {
        return Ok(());
    }
    let mut queue = state
        .startup_requests
        .lock()
        .map_err(|_| "Startup request state is unavailable".to_owned())?;
    if queue.len() >= 128 {
        return Err(
            "Too many pending file-open requests. Finish opening the queued projects first."
                .to_owned(),
        );
    }
    queue.push_back(request);
    Ok(())
}

pub fn forwarded(app: &tauri::AppHandle, args: Vec<String>, cwd: String) {
    match crate::cli::parse_args(args.into_iter().skip(1), std::path::Path::new(&cwd)) {
        Ok(CliAction::Open(request)) => {
            let state = app.state::<DesktopState>();
            match enqueue(&state, request) {
                Ok(()) => {
                    let _ = (StartupRequestsChanged { pending: true }).emit(app);
                }
                Err(error) => eprintln!("Could not queue file-open request: {error}"),
            }
        }
        Ok(CliAction::Help | CliAction::Version) => {}
        Err(error) => eprintln!("Could not open requested path: {error}"),
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn paths_request(paths: Vec<String>, cwd: &std::path::Path) -> Result<StartupRequest, String> {
    if paths.len() > 128 {
        return Err("Drop at most 128 files at a time".to_owned());
    }
    match crate::cli::parse_args(std::iter::once("--".to_owned()).chain(paths), cwd)? {
        CliAction::Open(request) => Ok(request),
        _ => Err("Expected files or a folder".to_owned()),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn enqueue_dropped_paths(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    paths: Vec<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    let state = state.inner().clone();
    let cwd = match cwd {
        Some(cwd) => std::path::PathBuf::from(cwd),
        None => std::env::current_dir().map_err(|error| error.to_string())?,
    };
    tauri::async_runtime::spawn_blocking(move || enqueue(&state, paths_request(paths, &cwd)?))
        .await
        .map_err(|error| format!("Open dropped paths task failed: {error}"))??;
    (StartupRequestsChanged { pending: true })
        .emit(&app)
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn take_startup_requests(
    state: State<'_, DesktopState>,
) -> Result<Vec<StartupRequest>, String> {
    let mut queue = state
        .startup_requests
        .lock()
        .map_err(|_| "Startup request state is unavailable".to_owned())?;
    Ok(queue.drain(..).collect())
}

#[cfg(test)]
mod tests {
    #[test]
    fn dropped_paths_are_literal_and_use_the_explicit_invoking_directory() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("--help"), "fixture").unwrap();
        let request = super::paths_request(vec!["--help".into()], directory.path()).unwrap();
        assert_eq!(request.files.len(), 1);
        assert!(std::path::Path::new(&request.files[0].path).is_absolute());
        assert_eq!(request.files[0].line, None);
        assert!(super::paths_request(vec!["missing.txt".into()], directory.path()).is_err());
    }

    #[test]
    fn requests_survive_until_frontend_drains_in_order() {
        let state = crate::DesktopState::default();
        let one = crate::cli::StartupRequest {
            workspace_root: Some("one".into()),
            files: vec![],
        };
        let two = crate::cli::StartupRequest {
            workspace_root: Some("two".into()),
            files: vec![],
        };
        assert!(super::enqueue(&state, one.clone()).is_ok());
        assert!(super::enqueue(&state, two.clone()).is_ok());
        let queue = state.startup_requests.lock().unwrap();
        assert_eq!(queue.iter().cloned().collect::<Vec<_>>(), vec![one, two]);
    }
}
