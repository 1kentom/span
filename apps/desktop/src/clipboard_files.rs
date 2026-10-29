//! OS clipboard file lists for the Explorer: Copy puts workspace paths on the clipboard as files (so Finder or
//! Explorer can paste them), Paste reads files copied elsewhere. Uses `arboard`, which the clipboard manager
//! plugin already builds, so no new crate is compiled. Clipboard content is never logged.
use crate::{startup, with_workspace, DesktopState};
use serde::Serialize;
use specta::Type;
use std::path::{Path, PathBuf};
use tauri::State;

/// Most paths one clipboard read or write may carry.
const MAX_CLIPBOARD_PATHS: usize = 128;
/// Largest clipboard image or text Span writes into a new file.
const MAX_PASTED_BYTES: usize = 64 * 1024 * 1024;

/// What the OS clipboard holds that the Explorer can paste. Files win over an image, an image over text.
#[derive(Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardContents {
    pub files: Vec<startup::DroppedPath>,
    pub has_image: bool,
    pub has_text: bool,
}

/// What a new pasted file is made from.
#[derive(Clone, Copy, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PastedKind {
    Image,
    Text,
}

/// Canonical clipboard paths that may be copied: existing, outside any `.git` folder, at most
/// [`MAX_CLIPBOARD_PATHS`]. Validation matches dropped paths.
pub(crate) fn validated_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    paths
        .into_iter()
        .take(MAX_CLIPBOARD_PATHS)
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .filter(|path| !inside_git(path))
        .collect()
}

fn inside_git(path: &Path) -> bool {
    path.components()
        .any(|part| part.as_os_str() == std::ffi::OsStr::new(".git"))
}

fn clipboard() -> Result<arboard::Clipboard, String> {
    arboard::Clipboard::new().map_err(|error| format!("The clipboard is unavailable: {error}"))
}

/// Reads the OS clipboard. Its file paths become the only clipboard paths `import_paths` accepts.
#[tauri::command]
#[specta::specta]
pub async fn clipboard_files(state: State<'_, DesktopState>) -> Result<ClipboardContents, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut board = clipboard()?;
        let paths = validated_paths(board.get().file_list().unwrap_or_default());
        if let Ok(mut recorded) = state.clipboard_paths.lock() {
            recorded.clone_from(&paths);
        }
        let files: Vec<_> = paths
            .iter()
            .filter_map(|path| startup::path_info(path).ok())
            .collect();
        let (has_image, has_text) = if files.is_empty() {
            (
                board.get_image().is_ok(),
                board.get_text().is_ok_and(|text| !text.is_empty()),
            )
        } else {
            (false, false)
        };
        Ok(ClipboardContents {
            files,
            has_image,
            has_text,
        })
    })
    .await
    .map_err(|error| format!("Clipboard task failed: {error}"))?
}

/// Puts workspace files and folders on the OS clipboard as a file list.
#[tauri::command]
#[specta::specta]
pub async fn set_clipboard_files(
    state: State<'_, DesktopState>,
    paths: Vec<String>,
) -> Result<(), String> {
    if paths.len() > MAX_CLIPBOARD_PATHS {
        return Err(format!(
            "Copy at most {MAX_CLIPBOARD_PATHS} items at a time"
        ));
    }
    let absolute = with_workspace(state.inner().clone(), move |workspace| {
        paths
            .iter()
            .map(|path| workspace.existing_path(path))
            .collect::<span_core::Result<Vec<_>>>()
    })
    .await?;
    tauri::async_runtime::spawn_blocking(move || {
        clipboard()?
            .set()
            .file_list(&absolute)
            .map_err(|error| format!("Could not copy the files to the clipboard: {error}"))
    })
    .await
    .map_err(|error| format!("Clipboard task failed: {error}"))?
}

/// Writes the clipboard image (as PNG) or text into a new workspace file. Never replaces an existing file.
#[tauri::command]
#[specta::specta]
pub async fn paste_clipboard_file(
    state: State<'_, DesktopState>,
    path: String,
    kind: PastedKind,
) -> Result<span_core::FileEntry, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut board = clipboard()?;
        match kind {
            PastedKind::Text => {
                let text = board
                    .get_text()
                    .map_err(|_| "The clipboard has no text".to_owned())?;
                if text.len() > MAX_PASTED_BYTES {
                    return Err("The clipboard text is larger than 64 MiB".to_owned());
                }
                Ok(text.into_bytes())
            }
            PastedKind::Image => {
                let image = board
                    .get_image()
                    .map_err(|_| "The clipboard has no image".to_owned())?;
                encode_png(image.width, image.height, &image.bytes)
            }
        }
    })
    .await
    .map_err(|error| format!("Clipboard task failed: {error}"))??;
    let state = state.inner().clone();
    let entry = with_workspace(state.clone(), move |workspace| {
        workspace.write_new_file(&path, &bytes)
    })
    .await?;
    crate::file_import::refresh_index(&state, &[entry.path.clone()]);
    Ok(entry)
}

/// RGBA pixels to a PNG file.
fn encode_png(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let expected = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or("The clipboard image is too large")?;
    if expected != rgba.len() || expected > MAX_PASTED_BYTES * 4 {
        return Err("The clipboard image is too large or malformed".to_owned());
    }
    let width = u32::try_from(width).map_err(|_| "The clipboard image is too wide")?;
    let height = u32::try_from(height).map_err(|_| "The clipboard image is too tall")?;
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| format!("Could not encode the image: {error}"))?;
        writer
            .write_image_data(rgba)
            .map_err(|error| format!("Could not encode the image: {error}"))?;
    }
    if output.len() > MAX_PASTED_BYTES {
        return Err("The pasted image is larger than 64 MiB".to_owned());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_paths_are_canonical_capped_and_never_inside_git() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join(".git")).unwrap();
        std::fs::write(directory.path().join(".git/config"), "x").unwrap();
        std::fs::write(directory.path().join("a.txt"), "a").unwrap();
        let paths = validated_paths(vec![
            directory.path().join("a.txt"),
            directory.path().join(".git/config"),
            directory.path().join("missing.txt"),
        ]);
        assert_eq!(
            paths,
            vec![std::fs::canonicalize(directory.path().join("a.txt")).unwrap()]
        );
        let many = vec![directory.path().join("a.txt"); MAX_CLIPBOARD_PATHS + 10];
        assert_eq!(validated_paths(many).len(), MAX_CLIPBOARD_PATHS);
    }

    #[test]
    fn clipboard_images_encode_as_png() {
        let png = encode_png(2, 1, &[255, 0, 0, 255, 0, 255, 0, 255]).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert!(encode_png(2, 2, &[0; 4]).is_err());
    }
}
