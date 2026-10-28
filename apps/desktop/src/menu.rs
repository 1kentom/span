//! Native menu actions route to the same frontend handlers as keyboard commands.
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle,
};
use tauri_specta::Event;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum NativeAction {
    QuickOpen,
    ToggleFiles,
    FocusFiles,
    OpenFile,
    CommandPalette,
    FindInFile,
    SearchWorkspace,
    Settings,
    CloseTab,
    Save,
    OpenFolder,
    SplitEditor,
    ToggleProject,
    ToggleAssistant,
    ToggleTerminal,
    ToggleWordWrap,
    MarkdownPreview,
    FormatDocument,
    FormatWithLanguageServer,
    GoToLine,
    ZoomIn,
    ZoomOut,
    ResetZoom,
    Quit,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct NativeActionEvent {
    pub action: NativeAction,
}

const ACTIONS: &[(&str, &str, NativeAction)] = &[
    ("quickOpen", "Go to File...", NativeAction::QuickOpen),
    ("toggleFiles", "Toggle Files", NativeAction::ToggleFiles),
    ("focusFiles", "Show Files", NativeAction::FocusFiles),
    ("openFile", "Open File...", NativeAction::OpenFile),
    (
        "commandPalette",
        "Show All Commands...",
        NativeAction::CommandPalette,
    ),
    ("findInFile", "Find in File...", NativeAction::FindInFile),
    (
        "searchWorkspace",
        "Search in Files...",
        NativeAction::SearchWorkspace,
    ),
    ("settings", "Settings...", NativeAction::Settings),
    ("closeTab", "Close Tab", NativeAction::CloseTab),
    ("save", "Save", NativeAction::Save),
    ("openFolder", "Open Folder...", NativeAction::OpenFolder),
    ("splitEditor", "Split Editor", NativeAction::SplitEditor),
    (
        "toggleProject",
        "Toggle Project Panel",
        NativeAction::ToggleProject,
    ),
    (
        "toggleAssistant",
        "Toggle AI Assistant",
        NativeAction::ToggleAssistant,
    ),
    (
        "toggleTerminal",
        "Toggle Terminal Panel",
        NativeAction::ToggleTerminal,
    ),
    (
        "markdownPreview",
        "Toggle Markdown Preview",
        NativeAction::MarkdownPreview,
    ),
    (
        "formatDocument",
        "Format Document",
        NativeAction::FormatDocument,
    ),
    (
        "formatWithLanguageServer",
        "Format with Language Server",
        NativeAction::FormatWithLanguageServer,
    ),
    ("goToLine", "Go to Line...", NativeAction::GoToLine),
    (
        "toggleWordWrap",
        "Toggle Word Wrap",
        NativeAction::ToggleWordWrap,
    ),
    ("zoomIn", "Zoom In", NativeAction::ZoomIn),
    ("zoomOut", "Zoom Out", NativeAction::ZoomOut),
    ("resetZoom", "Reset Zoom", NativeAction::ResetZoom),
];

fn item(
    app: &AppHandle,
    id: &str,
    label: &str,
    binding: Option<&String>,
) -> tauri::Result<MenuItem<tauri::Wry>> {
    let accelerator = binding.map(|binding| binding.replace("Mod+", "CmdOrCtrl+"));
    MenuItem::with_id(
        app,
        format!("span:{id}"),
        label,
        true,
        accelerator.as_deref(),
    )
}

fn build_menu(app: &AppHandle, bindings: &HashMap<String, Vec<String>>) -> tauri::Result<()> {
    let items: HashMap<_, _> = ACTIONS
        .iter()
        .map(|(id, label, _)| {
            item(
                app,
                id,
                label,
                bindings.get(*id).and_then(|keys| keys.first()),
            )
            .map(|item| (*id, item))
        })
        .collect::<tauri::Result<_>>()?;
    let separator = PredefinedMenuItem::separator(app)?;
    // Quit has its own route through the unsaved-buffer review. Close Tab never closes the window.
    let quit = item(app, "quit", "Quit span", Some(&"CmdOrCtrl+Q".to_owned()))?;
    let app_menu =
        Submenu::with_items(app, "span", true, &[&items["settings"], &separator, &quit])?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &items["openFile"],
            &items["openFolder"],
            &items["save"],
            &items["closeTab"],
        ],
    )?;
    // Native text editing preserves normal field and CodeMirror clipboard behavior.
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &items["findInFile"],
            &items["searchWorkspace"],
            &items["formatDocument"],
            &items["formatWithLanguageServer"],
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &items["commandPalette"],
            &items["toggleFiles"],
            &items["focusFiles"],
            &items["splitEditor"],
            &items["toggleProject"],
            &items["toggleAssistant"],
            &items["toggleTerminal"],
            &items["markdownPreview"],
            &items["toggleWordWrap"],
            &items["zoomIn"],
            &items["zoomOut"],
            &items["resetZoom"],
        ],
    )?;
    let go = Submenu::with_items(app, "Go", true, &[&items["quickOpen"], &items["goToLine"]])?;
    app.set_menu(Menu::with_items(
        app,
        &[&app_menu, &file, &edit, &view, &go],
    )?)?;
    Ok(())
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    // Startup binds only Close Tab and Quit. The frontend installs all resolved user shortcuts.
    build_menu(
        app,
        &HashMap::from([("closeTab".to_owned(), vec!["CmdOrCtrl+W".to_owned()])]),
    )?;
    app.on_menu_event(|app, event| {
        let Some(id) = event.id().as_ref().strip_prefix("span:") else {
            return;
        };
        let action = if id == "quit" {
            Some(NativeAction::Quit)
        } else {
            ACTIONS
                .iter()
                .find(|(key, _, _)| *key == id)
                .map(|(_, _, action)| *action)
        };
        if let Some(action) = action {
            crate::events::emit(app, &NativeActionEvent { action });
        }
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn sync_native_menu(
    app: AppHandle,
    bindings: HashMap<String, Vec<String>>,
) -> Result<Vec<String>, String> {
    if bindings
        .keys()
        .any(|id| !ACTIONS.iter().any(|(action, _, _)| action == id))
    {
        return Err("Unknown native menu action".into());
    }
    // Validate using the same settings validator used for persisted keybindings.
    let settings = span_core::Settings {
        keybindings: bindings.clone(),
        ..Default::default()
    };
    settings.validate().map_err(|error| error.to_string())?;
    build_menu(&app, &bindings).map_err(|error| error.to_string())?;
    Ok(ACTIONS
        .iter()
        .filter(|(id, _, _)| bindings.get(*id).is_some_and(|keys| !keys.is_empty()))
        .map(|(id, _, _)| (*id).to_owned())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_menu_actions_match_the_frontend_command_registry() {
        let source = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../ui/src/lib/commands.ts"
        ));
        let definitions = source.split("] as const").next().unwrap();
        let frontend = definitions
            .split("id: \"")
            .skip(1)
            .map(|entry| entry.split('"').next().unwrap())
            .collect::<std::collections::BTreeSet<_>>();
        let native = ACTIONS
            .iter()
            .map(|(id, _, _)| *id)
            .collect::<std::collections::BTreeSet<_>>();
        assert!(!frontend.is_empty());
        assert_eq!(
            native, frontend,
            "Native menu must accept every action sent by nativeMenuBindings"
        );
        span_core::Settings {
            keybindings: ACTIONS
                .iter()
                .map(|(id, _, _)| ((*id).to_owned(), Vec::new()))
                .collect(),
            ..Default::default()
        }
        .validate()
        .unwrap();
        for (id, _, action) in ACTIONS {
            assert_eq!(
                serde_json::to_value(action).unwrap(),
                serde_json::Value::String((*id).into())
            );
        }
    }
}
