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
