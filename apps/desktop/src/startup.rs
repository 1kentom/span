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
                crate::events::emit(&app, &StartupRequestsChanged { pending: true });
            }
            Err(message) => {
                crate::events::emit(&app, &StartupRequestError { message });
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
                    crate::events::emit(app, &StartupRequestsChanged { pending: true });
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
    crate::events::emit(&app, &StartupRequestsChanged { pending: true });
    Ok(())
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

    fn canonical(path: &std::path::Path) -> String {
        std::fs::canonicalize(path)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn a_dropped_file_alone_is_an_implied_root_request() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("note.txt");
        std::fs::write(&file, "x").unwrap();
        let request =
            super::paths_request(vec![file.to_str().unwrap().to_owned()], directory.path())
                .unwrap();
        assert!(request.implied_root);
        assert_eq!(request.files.len(), 1);
        assert_eq!(request.files[0].path, canonical(&file));
        assert_eq!(request.workspace_root, Some(canonical(directory.path())));
    }

    #[test]
    fn a_dropped_folder_names_its_root_explicitly() {
        let directory = tempfile::tempdir().unwrap();
        let folder = directory.path().join("project");
        std::fs::create_dir(&folder).unwrap();
        let request =
            super::paths_request(vec![folder.to_str().unwrap().to_owned()], directory.path())
                .unwrap();
        assert!(!request.implied_root);
        assert!(request.files.is_empty());
        assert_eq!(request.workspace_root, Some(canonical(&folder)));
    }

    #[test]
    fn mixed_folder_and_files_keep_the_folder_as_root() {
        let directory = tempfile::tempdir().unwrap();
        let folder = directory.path().join("project");
        std::fs::create_dir(&folder).unwrap();
        let file = folder.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let request = super::paths_request(
            vec![
                folder.to_str().unwrap().to_owned(),
                file.to_str().unwrap().to_owned(),
            ],
            directory.path(),
        )
        .unwrap();
        assert!(!request.implied_root);
        assert_eq!(request.files.len(), 1);
        let outside = directory.path().join("outside.txt");
        std::fs::write(&outside, "x").unwrap();
        assert!(super::paths_request(
            vec![
                folder.to_str().unwrap().to_owned(),
                outside.to_str().unwrap().to_owned()
            ],
            directory.path(),
        )
        .is_err());
    }

    #[test]
    fn several_dropped_files_share_their_common_parent() {
        let directory = tempfile::tempdir().unwrap();
        let one = directory.path().join("a").join("one.txt");
        let two = directory.path().join("b").join("two.txt");
        for file in [&one, &two] {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, "x").unwrap();
        }
        let request = super::paths_request(
            vec![
                one.to_str().unwrap().to_owned(),
                two.to_str().unwrap().to_owned(),
            ],
            directory.path(),
        )
        .unwrap();
        assert!(request.implied_root);
        assert_eq!(request.files.len(), 2);
        assert_eq!(request.workspace_root, Some(canonical(directory.path())));
    }

    #[test]
    fn nonexistent_and_foreign_style_paths_are_rejected_without_a_request() {
        let directory = tempfile::tempdir().unwrap();
        assert!(super::paths_request(vec!["nope.txt".into()], directory.path()).is_err());
        if cfg!(not(windows)) {
            assert!(super::paths_request(
                vec!["C:\\Users\\nobody\\file.txt".into()],
                directory.path()
            )
            .is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_style_paths_with_backslashes_resolve() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("note.txt");
        std::fs::write(&file, "x").unwrap();
        let text = file.to_str().unwrap().replace('/', "\\");
        let request = super::paths_request(vec![text], directory.path()).unwrap();
        assert_eq!(request.files.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_dropped_symlink_resolves_to_its_target_file() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("real.txt");
        std::fs::write(&file, "x").unwrap();
        let link = directory.path().join("link.txt");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        let request =
            super::paths_request(vec![link.to_str().unwrap().to_owned()], directory.path())
                .unwrap();
        assert_eq!(request.files[0].path, canonical(&file));
    }

    #[test]
    fn requests_survive_until_frontend_drains_in_order() {
        let state = crate::DesktopState::default();
        let one = crate::cli::StartupRequest {
            workspace_root: Some("one".into()),
            files: vec![],
            implied_root: false,
        };
        let two = crate::cli::StartupRequest {
            workspace_root: Some("two".into()),
            files: vec![],
            implied_root: false,
        };
        assert!(super::enqueue(&state, one.clone()).is_ok());
        assert!(super::enqueue(&state, two.clone()).is_ok());
        let queue = state.startup_requests.lock().unwrap();
        assert_eq!(queue.iter().cloned().collect::<Vec<_>>(), vec![one, two]);
    }
}
