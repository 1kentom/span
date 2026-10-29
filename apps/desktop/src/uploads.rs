//! Tauri commands for the Uploads panel (ADR 0006). The store and its rules live in
//! `span_core::UploadStore`; this file resolves the open workspace, moves bytes as
//! base64, and launches the system file manager or default app without a shell.
use crate::DesktopState;
use serde::Serialize;
use span_core::{
    ClearedUploads, CoreWorkspace, SavedAttachment, Upload, UploadSource, UploadStore, UploadUsage,
    MAX_UPLOAD_BYTES,
};
use specta::Type;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;

/// One bounded read, base64 encoded for IPC.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UploadChunk {
    pub data_base64: String,
    pub offset: u64,
    /// Size of the whole upload.
    pub size: u64,
    pub eof: bool,
}

fn open_workspace(state: &DesktopState) -> Result<Arc<Mutex<CoreWorkspace>>, String> {
    state
        .workspace
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open a folder to use uploads".to_owned())
}

fn store_for(workspace: &Arc<Mutex<CoreWorkspace>>) -> Result<UploadStore, String> {
    let root = workspace
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?
        .workspace()
        .root;
    UploadStore::for_current_user(Path::new(&root)).map_err(|error| error.to_string())
}

/// Runs `operation` on a blocking worker against the open workspace's store.
async fn with_store<T, F>(state: &DesktopState, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&UploadStore) -> Result<T, String> + Send + 'static,
{
    let workspace = open_workspace(state)?;
    tauri::async_runtime::spawn_blocking(move || operation(&store_for(&workspace)?))
        .await
        .map_err(|error| format!("Uploads task failed: {error}"))?
}

fn core<T>(result: span_core::Result<T>) -> Result<T, String> {
    result.map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn uploads_list(state: State<'_, DesktopState>) -> Result<Vec<Upload>, String> {
    with_store(state.inner(), |store| core(store.list())).await
}

#[tauri::command]
#[specta::specta]
pub async fn uploads_usage(state: State<'_, DesktopState>) -> Result<UploadUsage, String> {
    with_store(state.inner(), |store| core(store.usage())).await
}

#[tauri::command]
#[specta::specta]
pub async fn uploads_add(
    state: State<'_, DesktopState>,
    name: String,
    data_base64: String,
    source: UploadSource,
) -> Result<Upload, String> {
    use base64::Engine;
    // Checked before decoding so an oversized payload is never expanded in memory.
    if base64_too_large(data_base64.len()) {
        return Err("Upload is too large to store.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|_| "Upload data is not valid base64.".to_string())?;
    with_store(state.inner(), move |store| {
        core(store.add(&name, &bytes, source))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn uploads_read(
    state: State<'_, DesktopState>,
    id: String,
    offset: u64,
    len: u32,
) -> Result<UploadChunk, String> {
    use base64::Engine;
    with_store(state.inner(), move |store| {
        let chunk = core(store.read(&id, offset, len as u64))?;
        Ok(UploadChunk {
            data_base64: base64::engine::general_purpose::STANDARD.encode(&chunk.bytes),
            offset: chunk.offset,
            size: chunk.size,
            eof: chunk.eof,
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn uploads_rename(
    state: State<'_, DesktopState>,
    id: String,
    name: String,
) -> Result<Upload, String> {
    with_store(state.inner(), move |store| core(store.rename(&id, &name))).await
}

#[tauri::command]
#[specta::specta]
pub async fn uploads_duplicate(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<Upload, String> {
    with_store(state.inner(), move |store| core(store.duplicate(&id))).await
}

#[tauri::command]
#[specta::specta]
pub async fn uploads_remove(state: State<'_, DesktopState>, id: String) -> Result<(), String> {
    with_store(state.inner(), move |store| core(store.remove(&id))).await
}

/// Saves into workspace-relative `dir` through `save_attachment`: never overwrites.
#[tauri::command]
#[specta::specta]
pub async fn uploads_save_to_workspace(
    state: State<'_, DesktopState>,
    id: String,
    dir: String,
) -> Result<SavedAttachment, String> {
    let workspace = open_workspace(state.inner())?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = store_for(&workspace)?;
        let mut workspace = workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?;
        core(store.save_to_workspace(&id, &mut workspace, &dir))
    })
    .await
    .map_err(|error| format!("Uploads task failed: {error}"))?
}

/// Path of a named copy of the upload in app data, for an explicit "Copy path".
/// The copy is outside the workspace and is replaced on the next open or reveal.
#[tauri::command]
#[specta::specta]
pub async fn uploads_copy_path(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<String, String> {
    with_store(state.inner(), move |store| {
        let copy = core(store.external_copy(&id))?;
        Ok(display_path(&copy.path))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn uploads_reveal(state: State<'_, DesktopState>, id: String) -> Result<(), String> {
    with_store(state.inner(), move |store| {
        let copy = core(store.external_copy(&id))?;
        launch(&reveal_launch(Os::current(), &copy.path)?)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn uploads_open(state: State<'_, DesktopState>, id: String) -> Result<(), String> {
    with_store(state.inner(), move |store| {
        let copy = core(store.external_copy(&id))?;
        if let Some(reason) = copy.open_refusal() {
            return Err(reason);
        }
        launch(&open_launch(Os::current(), &copy.path)?)
    })
    .await
}

/// The store folder for the open workspace, for Settings > Storage. App data,
/// never inside the workspace.
#[tauri::command]
#[specta::specta]
pub async fn uploads_folder(state: State<'_, DesktopState>) -> Result<String, String> {
    with_store(state.inner(), |store| Ok(display_path(store.dir()))).await
}

/// Opens the store folder in the system file manager.
#[tauri::command]
#[specta::specta]
pub async fn uploads_reveal_folder(state: State<'_, DesktopState>) -> Result<(), String> {
    with_store(state.inner(), |store| {
        launch(&open_launch(Os::current(), store.dir())?)
    })
    .await
}

/// Clear uploads in Settings > Storage, after the user confirmed: removes this
/// workspace's blobs (orphans included), `open/` copies and index. Workspace
/// files and uploads saved into the workspace are untouched.
#[tauri::command]
#[specta::specta]
pub async fn uploads_clear(state: State<'_, DesktopState>) -> Result<ClearedUploads, String> {
    with_store(state.inner(), |store| core(store.clear())).await
}

/// Same bound as `save_attachment`: the decoded size can exceed the cap by at most
/// the padding of the last base64 quantum.
fn base64_too_large(encoded_len: usize) -> bool {
    (encoded_len / 4 * 3) as u64 > MAX_UPLOAD_BYTES + 3
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Os {
    Mac,
    Windows,
    Linux,
}

impl Os {
    pub(crate) fn current() -> Self {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        }
    }
}

/// A program and its arguments. On Windows the arguments are passed verbatim
/// (`raw_arg`) because explorer.exe parses `/select,"path"` itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Launch {
    program: OsString,
    args: Vec<OsString>,
    raw: bool,
    /// explorer.exe exits with 1 even after it opened the window.
    check_status: bool,
}

/// Drops the `\\?\` prefix that `canonicalize` adds on Windows, which explorer.exe
/// does not accept. String level, so it is tested on every platform.
fn windows_plain_path(path: &str) -> String {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(local) = path.strip_prefix(r"\\?\") {
        local.to_owned()
    } else {
        path.to_owned()
    }
}

fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) {
        windows_plain_path(&text)
    } else {
        text.into_owned()
    }
}

fn windows_quoted(path: &Path) -> Result<String, String> {
    let text = windows_plain_path(&path.to_string_lossy());
    // Names are validated without quotes, so this only guards the store location.
    if text.contains('"') {
        return Err("Upload path cannot be passed to the file manager".into());
    }
    Ok(format!("\"{text}\""))
}

fn explorer() -> OsString {
    std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join("explorer.exe").into_os_string())
        .unwrap_or_else(|| "explorer.exe".into())
}

pub(crate) fn reveal_launch(os: Os, path: &Path) -> Result<Launch, String> {
    Ok(match os {
        Os::Mac => Launch {
            program: "/usr/bin/open".into(),
            args: vec!["-R".into(), path.into()],
            raw: false,
            check_status: true,
        },
        Os::Windows => Launch {
            program: explorer(),
            args: vec![format!("/select,{}", windows_quoted(path)?).into()],
            raw: true,
            check_status: false,
        },
        Os::Linux => Launch {
            program: "xdg-open".into(),
            args: vec![path
                .parent()
                .ok_or_else(|| "Upload has no containing folder".to_owned())?
                .into()],
            raw: false,
            check_status: true,
        },
    })
}

pub(crate) fn open_launch(os: Os, path: &Path) -> Result<Launch, String> {
    Ok(match os {
        Os::Mac => Launch {
            program: "/usr/bin/open".into(),
            args: vec!["--".into(), path.into()],
            raw: false,
            check_status: true,
        },
        Os::Windows => Launch {
            program: explorer(),
            args: vec![windows_quoted(path)?.into()],
            raw: true,
            check_status: false,
        },
        Os::Linux => Launch {
            program: "xdg-open".into(),
            args: vec![path.into()],
            raw: false,
            check_status: true,
        },
    })
}

/// Runs the program directly, never through a shell. A bare program name (xdg-open)
/// is resolved on PATH here, so the launch specs stay testable on every platform.
pub(crate) fn launch(spec: &Launch) -> Result<(), String> {
    let program = if Path::new(&spec.program).is_absolute() || cfg!(windows) {
        PathBuf::from(&spec.program)
    } else {
        span_core::resolve_program(&spec.program.to_string_lossy()).ok_or_else(|| {
            format!(
                "No file opener ({}) is installed",
                spec.program.to_string_lossy()
            )
        })?
    };
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    if spec.raw {
        use std::os::windows::process::CommandExt;
        for arg in &spec.args {
            command.raw_arg(arg);
        }
    } else {
        command.args(&spec.args);
    }
    #[cfg(not(windows))]
    {
        debug_assert!(!spec.raw, "verbatim arguments are only built for Windows");
        command.args(&spec.args);
    }
    let status = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|error| format!("Launch file manager: {error}"))?;
    if spec.check_status && !status.success() {
        return Err(format!("The system opener exited with {status}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_commands_use_open_without_a_shell() {
        let path = Path::new("/store/open/abc/a b.pdf");
        let reveal = reveal_launch(Os::Mac, path).unwrap();
        assert_eq!(reveal.program, OsString::from("/usr/bin/open"));
        assert_eq!(reveal.args, vec![OsString::from("-R"), path.into()]);
        let open = open_launch(Os::Mac, path).unwrap();
        assert_eq!(open.args, vec![OsString::from("--"), path.into()]);
        assert!(!open.raw && open.check_status);
    }

    #[test]
    fn windows_commands_select_and_open_through_explorer() {
        let path = Path::new(r"\\?\C:\Users\me\.config\span\uploads\k\open\i\a b.pdf");
        let reveal = reveal_launch(Os::Windows, path).unwrap();
        assert!(reveal.program.to_string_lossy().ends_with("explorer.exe"));
        assert_eq!(
            reveal.args,
            vec![OsString::from(
                r#"/select,"C:\Users\me\.config\span\uploads\k\open\i\a b.pdf""#
            )]
        );
        assert!(reveal.raw && !reveal.check_status);
        let open = open_launch(Os::Windows, path).unwrap();
        assert_eq!(
            open.args,
            vec![OsString::from(
                r#""C:\Users\me\.config\span\uploads\k\open\i\a b.pdf""#
            )]
        );
        assert!(open_launch(Os::Windows, Path::new(r#"C:\bad"name"#)).is_err());
    }

    #[test]
    fn windows_verbatim_prefixes_are_stripped() {
        assert_eq!(windows_plain_path(r"\\?\C:\a\b"), r"C:\a\b");
        assert_eq!(windows_plain_path(r"\\?\UNC\srv\share\a"), r"\\srv\share\a");
        assert_eq!(windows_plain_path(r"C:\a"), r"C:\a");
    }

    #[test]
    fn linux_reveal_opens_the_folder_and_open_opens_the_file() {
        let path = Path::new("/store/open/abc/a.pdf");
        let reveal = reveal_launch(Os::Linux, path).unwrap();
        let open = open_launch(Os::Linux, path).unwrap();
        assert_eq!(reveal.program, OsString::from("xdg-open"));
        assert!(!reveal.raw && !open.raw);
        assert_eq!(reveal.args, vec![OsString::from("/store/open/abc")]);
        assert_eq!(open.args, vec![OsString::from("/store/open/abc/a.pdf")]);
    }

    #[test]
    fn oversized_base64_is_rejected_before_decoding() {
        let exact = (MAX_UPLOAD_BYTES as usize).div_ceil(3) * 4;
        assert!(!base64_too_large(exact));
        assert!(!base64_too_large(0));
        assert!(base64_too_large(exact + 8));
        assert!(base64_too_large(usize::MAX / 2));
    }
}
