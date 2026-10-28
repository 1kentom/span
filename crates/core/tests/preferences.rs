use span_core::{
    run_formatter, CoreError, CoreWorkspace, FormatRequest, MarkdownView, SessionGroup,
    SessionPanels, SessionState, SessionStore, Settings, TextEdit,
};
use std::{collections::HashMap, fs};
use tempfile::tempdir;

#[test]
fn expanded_settings_validate_jsonc_roundtrip_and_shortcut_conflicts() {
    let directory = tempdir().unwrap();
    let workspace = CoreWorkspace::open(directory.path())
        .unwrap()
        .with_user_settings(None);
    let settings = Settings::default();
    assert!(settings.markdown_preview_default);
    assert_eq!(settings.ui_font_family, "Inter");
    assert!(!settings.format_on_save);
    let text = "{ // custom preferences\n\"$schema\": \"settings.schema.json\", \"uiFontSize\": 15, \"formatOnSave\": true, \"keybindings\": {\"save\": [\"Mod+Alt+S\"]}, \"formatters\": {\"rust\": [\"rustfmt\", \"--edition\", \"2024\"]}, }";
    let merged = workspace.update_settings_jsonc(text).unwrap();
    assert_eq!(merged.ui_font_size, 15);
    assert!(merged.format_on_save);
    assert_eq!(merged.keybindings["save"], vec!["Mod+Alt+S"]);
    assert_eq!(workspace.get_settings_jsonc().unwrap(), text);
    for shortcut in [
        "Mod+Q",
        "Mod+C",
        "Mod+Shift+Z",
        "P",
        "Shift+F",
        "Alt+😀",
        "Mod+Shift+F",
        "Mod+Mod+S",
        "Mod+FakeKey",
    ] {
        let mut settings = Settings::default();
        settings
            .keybindings
            .insert("save".into(), vec![shortcut.into()]);
        assert!(
            settings.validate().is_err(),
            "accepted invalid shortcut {shortcut}"
        );
    }
    let mut settings = Settings::default();
    settings.keybindings.insert("quickOpen".into(), Vec::new());
    settings
        .keybindings
        .insert("save".into(), vec!["Mod+P".into()]);
    settings.validate().unwrap();
    settings
        .keybindings
        .insert("notAnAction".into(), Vec::new());
    assert!(settings.validate().is_err());
    let mut settings = Settings::default();
    settings.formatters.insert("rust".into(), vec![]);
    assert!(settings.validate().is_err());
    assert_eq!(workspace.get_settings_jsonc().unwrap(), text);
}

#[test]
fn session_reopens_only_existing_rooted_files_without_buffer_autosave() {
    let directory = tempdir().unwrap();
    let profile = tempdir().unwrap();
    fs::write(directory.path().join("saved.md"), "disk content").unwrap();
    fs::write(directory.path().join("removed.txt"), "soon removed").unwrap();
    let store = SessionStore::new(profile.path().join("profile/session.json"));
    assert!(store.load().unwrap().is_none());
    let mut workspace = CoreWorkspace::open(directory.path()).unwrap();
    workspace.open_buffer("saved.md").unwrap();
    workspace
        .edit_buffer_delta(
            "saved.md",
            0,
            vec![TextEdit {
                from: 0,
                to: 0,
                insert: "unsaved ".into(),
            }],
        )
        .unwrap();
    let state = SessionState {
        workspace_root: directory.path().to_string_lossy().into(),
        groups: vec![SessionGroup {
            paths: vec!["saved.md".into(), "removed.txt".into(), "../escape".into()],
            active_path: Some("removed.txt".into()),
        }],
        active_group: 99,
        panels: SessionPanels {
            project_width: 99999,
            ..Default::default()
        },
        markdown_views: HashMap::from([("saved.md".into(), MarkdownView::Both)]),
    };
    store.save(state).unwrap();
    fs::remove_file(directory.path().join("removed.txt")).unwrap();
    let restored = store.load().unwrap().unwrap();
    assert_eq!(restored.groups[0].paths, vec!["saved.md"]);
    assert_eq!(restored.groups[0].active_path.as_deref(), Some("saved.md"));
    assert_eq!(restored.active_group, 0);
    assert_eq!(restored.panels.project_width, 1000);
    assert_eq!(restored.markdown_views["saved.md"], MarkdownView::Both);
    assert_eq!(
        fs::read_to_string(directory.path().join("saved.md")).unwrap(),
        "disk content"
    );
    drop(directory);
    assert!(store.load().unwrap().is_none());
}

#[tokio::test]
async fn json_formatter_preserves_key_order_large_numbers_and_stale_user_edits() {
    let directory = tempdir().unwrap();
    let original = "{\"z\":123456789012345678901234567890,\"a\":[1,true]}";
    fs::write(directory.path().join("file.json"), original).unwrap();
    let mut workspace = CoreWorkspace::open(directory.path())
        .unwrap()
        .with_user_settings(None);
    workspace.open_buffer("file.json").unwrap();
    let request = workspace.take_format_request("file.json", 0).unwrap();
    let formatted = run_formatter(request).await.unwrap();
    assert!(formatted.text.find("\"z\"").unwrap() < formatted.text.find("\"a\"").unwrap());
    assert!(formatted.text.contains("123456789012345678901234567890"));
    assert!(formatted.text.ends_with('\n'));
    workspace
        .edit_buffer_delta(
            "file.json",
            0,
            vec![TextEdit {
                from: 1,
                to: 1,
                insert: " ".into(),
            }],
        )
        .unwrap();
    assert!(matches!(
        workspace.apply_format_result(formatted),
        Err(CoreError::StaleRevision { .. })
    ));
    assert_eq!(
        workspace.agent_read("file.json").unwrap().text,
        original.replacen('{', "{ ", 1)
    );
    assert_eq!(
        fs::read_to_string(directory.path().join("file.json")).unwrap(),
        original
    );
    let request = workspace.take_format_request("file.json", 1).unwrap();
    let formatted = run_formatter(request).await.unwrap();
    let applied = workspace.apply_format_result(formatted).unwrap();
    assert_eq!(applied.revision, 2);
    assert_ne!(applied.revision, applied.saved_revision);
}

#[tokio::test]
async fn malformed_or_duplicate_json_never_mutates_document() {
    let directory = tempdir().unwrap();
    for (name, text) in [
        ("invalid.json", "{broken"),
        ("duplicate.json", "{\"a\":1,\"a\":2}"),
    ] {
        fs::write(directory.path().join(name), text).unwrap();
        let mut workspace = CoreWorkspace::open(directory.path())
            .unwrap()
            .with_user_settings(None);
        workspace.open_buffer(name).unwrap();
        let request = workspace.take_format_request(name, 0).unwrap();
        assert!(run_formatter(request).await.is_err());
        assert_eq!(workspace.agent_read(name).unwrap().text, text);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn configured_formatter_uses_stdin_and_never_interprets_argument_shell_syntax() {
    let directory = tempdir().unwrap();
    let request = FormatRequest {
        path: "a.txt".into(),
        revision: 7,
        text: "stdin 😀 content".into(),
        language: "text".into(),
        workspace_root: directory.path().to_string_lossy().into(),
        tab_size: 2,
        argv: Some(vec!["/bin/cat".into()]),
    };
    let result = run_formatter(request).await.unwrap();
    assert_eq!(result.text, "stdin 😀 content");
    assert_eq!(result.revision, 7);
    let marker = directory.path().join("must-not-exist");
    let literal = format!("$(touch {})", marker.display());
    let request = FormatRequest {
        path: "a.txt".into(),
        revision: 0,
        text: String::new(),
        language: "text".into(),
        workspace_root: directory.path().to_string_lossy().into(),
        tab_size: 2,
        argv: Some(vec!["/usr/bin/printf".into(), "%s".into(), literal.clone()]),
    };
    assert_eq!(run_formatter(request).await.unwrap().text, literal);
    assert!(!marker.exists());
}

#[test]
fn dotenv_and_markdown_aliases_are_classified_consistently() {
    let directory = tempdir().unwrap();
    let mut workspace = CoreWorkspace::open(directory.path()).unwrap();
    for name in [".env", ".env.local", ".env.example"] {
        assert_eq!(workspace.open_buffer(name).unwrap().language, "dotenv");
    }
    for name in [
        "readme.md",
        "readme.markdown",
        "readme.mdown",
        "readme.mkd",
        "readme.mdx",
        "README.MD",
    ] {
        assert_eq!(workspace.open_buffer(name).unwrap().language, "markdown");
    }
}

#[test]
fn local_images_are_raster_only_rooted_and_limited() {
    let directory = tempdir().unwrap();
    fs::write(
        directory.path().join("small.png"),
        [
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
            8, 2, 0, 0, 0, 144, 119, 83, 222, 0, 0, 0, 12, 73, 68, 65, 84, 120, 218, 99, 96, 96,
            96, 0, 0, 0, 4, 0, 1, 200, 234, 235, 249, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
        ],
    )
    .unwrap();
    fs::write(
        directory.path().join("unsafe.svg"),
        b"<svg><script>bad()</script></svg>",
    )
    .unwrap();
    let workspace = CoreWorkspace::open(directory.path()).unwrap();
    assert_eq!(
        workspace.read_image("small.png", 100).unwrap().mime,
        "image/png"
    );
    assert!(workspace.read_image("small.png", 2).is_err());
    assert!(workspace.read_image("unsafe.svg", 100).is_err());
    assert!(matches!(
        workspace.read_image("../small.png", 100),
        Err(CoreError::OutsideWorkspace(_))
    ));
}

#[tokio::test]
async fn unavailable_formatter_returns_clear_error_without_mutation() {
    let directory = tempdir().unwrap();
    let request = FormatRequest {
        path: "a.txt".into(),
        revision: 0,
        text: "unchanged".into(),
        language: "dotenv".into(),
        workspace_root: directory.path().to_string_lossy().into(),
        tab_size: 2,
        argv: None,
    };
    assert!(run_formatter(request)
        .await
        .unwrap_err()
        .to_string()
        .contains("No formatter"));
    let request = FormatRequest {
        path: "a.txt".into(),
        revision: 0,
        text: "unchanged".into(),
        language: "text".into(),
        workspace_root: directory.path().to_string_lossy().into(),
        tab_size: 2,
        argv: Some(vec![directory
            .path()
            .join("missing-formatter")
            .to_string_lossy()
            .into()]),
    };
    assert!(run_formatter(request)
        .await
        .unwrap_err()
        .to_string()
        .contains("unavailable"));
}

#[tokio::test]
async fn available_rustfmt_receives_unsaved_buffer_text_on_stdin() {
    if span_core::resolve_program("rustfmt").is_none() {
        return;
    }
    let directory = tempdir().unwrap();
    fs::write(directory.path().join("main.rs"), "fn main(){}").unwrap();
    let mut workspace = CoreWorkspace::open(directory.path())
        .unwrap()
        .with_user_settings(None);
    workspace.open_buffer("main.rs").unwrap();
    workspace
        .edit_buffer_delta(
            "main.rs",
            0,
            vec![TextEdit {
                from: 0,
                to: 11,
                insert: "fn main(){let value=42;}".into(),
            }],
        )
        .unwrap();
    let result = run_formatter(workspace.take_format_request("main.rs", 1).unwrap())
        .await
        .unwrap();
    assert_eq!(result.formatter, "rustfmt");
    assert!(result.text.contains("let value = 42;"));
    assert!(result.text.ends_with('\n'));
    assert_eq!(
        fs::read_to_string(directory.path().join("main.rs")).unwrap(),
        "fn main(){}"
    );
}

#[test]
fn agent_delegation_is_off_by_default_and_honoured_only_from_user_settings() {
    let directory = tempdir().unwrap();
    let home = tempdir().unwrap();
    let user = home.path().join("settings.jsonc");
    let workspace = CoreWorkspace::open(directory.path())
        .unwrap()
        .with_user_settings(Some(user.clone()));
    assert!(!Settings::default().agents.delegation.enabled);
    assert!(!workspace.get_settings().unwrap().agents.delegation.enabled);

    // A workspace file (it comes with a cloned repository) cannot switch it on.
    let merged = workspace
        .update_settings_jsonc("{ \"agents\": { \"delegation\": { \"enabled\": true } } }")
        .unwrap();
    assert!(!merged.agents.delegation.enabled);
    assert!(!workspace.get_settings().unwrap().agents.delegation.enabled);
    fs::write(
        directory.path().join(".span/settings.jsonc"),
        "{ \"agents\": { \"delegation\": { \"enabled\": true } }, \"fontSize\": 15 }",
    )
    .unwrap();
    let read = workspace.get_settings().unwrap();
    assert!(!read.agents.delegation.enabled);
    assert_eq!(read.font_size, 15);

    // The user's own settings file can, and a workspace false does not override it.
    fs::write(
        &user,
        "{ \"agents\": { \"delegation\": { \"enabled\": true } } }",
    )
    .unwrap();
    assert!(workspace.get_settings().unwrap().agents.delegation.enabled);
    fs::write(
        directory.path().join(".span/settings.jsonc"),
        "{ \"agents\": { \"delegation\": { \"enabled\": false } } }",
    )
    .unwrap();
    assert!(workspace.get_settings().unwrap().agents.delegation.enabled);

    // Typed saves go to the workspace file and leave the user-only key out.
    let mut typed = workspace.get_settings().unwrap();
    typed.agents.delegation.enabled = false;
    assert!(
        workspace
            .update_settings(typed)
            .unwrap()
            .agents
            .delegation
            .enabled
    );
    let written = fs::read_to_string(directory.path().join(".span/settings.jsonc")).unwrap();
    assert!(!written.contains("\"enabled\""), "{written}");

    // Unknown keys next to it are still rejected.
    assert!(workspace
        .update_settings_jsonc("{ \"agents\": { \"delegation\": { \"on\": true } } }")
        .is_err());
    // A settings object without `agents` (older UI literals) keeps the default.
    let legacy: Settings = serde_json::from_value(serde_json::json!({ "fontSize": 14 })).unwrap();
    assert!(!legacy.agents.delegation.enabled);
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("../settings.schema.json")).unwrap();
    assert_eq!(
        schema["properties"]["agents"]["properties"]["delegation"]["properties"]["enabled"]
            ["default"],
        false
    );
}

#[test]
fn update_check_on_launch_is_off_by_default_and_honoured_only_from_user_settings() {
    let directory = tempdir().unwrap();
    let home = tempdir().unwrap();
    let user = home.path().join("settings.jsonc");
    let workspace = CoreWorkspace::open(directory.path())
        .unwrap()
        .with_user_settings(Some(user.clone()));
    assert!(!Settings::default().updates.check_on_launch);
    assert!(!workspace.get_settings().unwrap().updates.check_on_launch);

    // A workspace file cannot switch it on, through JSONC or a hand edit.
    let merged = workspace
        .update_settings_jsonc("{ \"updates\": { \"checkOnLaunch\": true } }")
        .unwrap();
    assert!(!merged.updates.check_on_launch);
    fs::write(
        directory.path().join(".span/settings.jsonc"),
        "{ \"updates\": { \"checkOnLaunch\": true }, \"fontSize\": 15 }",
    )
    .unwrap();
    let read = workspace.get_settings().unwrap();
    assert!(!read.updates.check_on_launch);
    assert_eq!(read.font_size, 15);

    // The user's own file can, and a workspace false does not override it.
    fs::write(&user, "{ \"updates\": { \"checkOnLaunch\": true } }").unwrap();
    assert!(workspace.get_settings().unwrap().updates.check_on_launch);
    fs::write(
        directory.path().join(".span/settings.jsonc"),
        "{ \"updates\": { \"checkOnLaunch\": false } }",
    )
    .unwrap();
    assert!(workspace.get_settings().unwrap().updates.check_on_launch);

    // Typed saves leave the user-only key out of the workspace file.
    let typed = workspace.get_settings().unwrap();
    workspace.update_settings(typed).unwrap();
    let written = fs::read_to_string(directory.path().join(".span/settings.jsonc")).unwrap();
    assert!(!written.contains("checkOnLaunch"), "{written}");

    // Unknown sibling keys are still rejected and an older literal keeps the default.
    assert!(workspace
        .update_settings_jsonc("{ \"updates\": { \"auto\": true } }")
        .is_err());
    let legacy: Settings = serde_json::from_value(serde_json::json!({ "fontSize": 14 })).unwrap();
    assert!(!legacy.updates.check_on_launch);
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("../settings.schema.json")).unwrap();
    let key = &schema["properties"]["updates"]["properties"]["checkOnLaunch"];
    assert_eq!(key["default"], false);
    assert!(key["description"]
        .as_str()
        .unwrap()
        .contains("user settings"));
}
