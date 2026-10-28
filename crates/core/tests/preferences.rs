use span_core::{
    run_formatter, CoreError, CoreWorkspace, FormatRequest, MarkdownView, SessionGroup,
    SessionPanels, SessionState, SessionStore, Settings, TextEdit,
};
use std::{collections::HashMap, fs};
use tempfile::tempdir;

#[test]
fn vscode_aliases_merge_per_scope_and_preserve_unsupported_raw_keys() {
    use span_core::{AutoSaveMode, SettingsScope};
    let directory = tempdir().unwrap();
    let profile = tempdir().unwrap();
    let user = profile.path().join("settings.jsonc");
    fs::write(&user, r#"{ "editor.fontSize": 18, "editor.wordWrap": "on", "files.autoSave": "afterDelay", "window.zoomLevel": 1.5, "extension.unknown": { "enabled": true } }"#).unwrap();
    let workspace = CoreWorkspace::open(directory.path())
        .unwrap()
        .with_user_settings(Some(user.clone()));
    assert_eq!(
        workspace.get_settings().unwrap().auto_save,
        AutoSaveMode::AfterDelay
    );
    assert_eq!(workspace.get_settings().unwrap().auto_save_delay, 1000);
    let raw = "{ // project override\n\"fontSize\": 14, \"files.autoSaveDelay\": 250, \"window.zoomLevel\": -0.5, \"[rust]\": {\"editor.tabSize\": 4}, }";
    let effective = workspace.update_settings_jsonc(raw).unwrap();
    assert_eq!(effective.font_size, 14);
    assert!(effective.word_wrap);
    assert_eq!(effective.auto_save_delay, 250);
    assert_eq!(effective.zoom_level, Some(-0.5));
    assert_eq!(effective.tab_size, 2);
    assert_eq!(
        workspace
            .get_settings_for_scope(SettingsScope::User)
            .unwrap()
            .font_size,
        18
    );
    assert_eq!(workspace.get_settings_jsonc().unwrap(), raw);
    assert!(fs::read_to_string(user)
        .unwrap()
        .contains("extension.unknown"));
}

#[test]
fn scoped_patch_and_reset_preserve_comments_unknowns_and_lower_priority_values() {
    use span_core::SettingsScope;
    let directory = tempdir().unwrap();
    let profile = tempdir().unwrap();
    let user = profile.path().join("nested/settings.jsonc");
    let workspace = CoreWorkspace::open(directory.path())
        .unwrap()
        .with_user_settings(Some(user.clone()));
    workspace
        .update_setting(SettingsScope::User, "editor.fontSize", Some("19"))
        .unwrap();
    let raw = "{ // original 🐱 comment\n\"fontSize\": 15, /* legacy */ \"editor.fontSize\": 16,\n\"extension.keep\": {\"url\": \"https://example.test/a,b\", \"arr\": [1,2]}, // keep me\n\"theme\": \"Light\"\n}\n";
    workspace.update_settings_jsonc(raw).unwrap();
    let patched = workspace
        .update_setting(SettingsScope::Workspace, "fontSize", Some("17"))
        .unwrap();
    assert_eq!(patched.font_size, 17);
    let saved = workspace.get_settings_jsonc().unwrap();
    for retained in [
        "original 🐱 comment",
        "/* legacy */",
        "\"extension.keep\": {\"url\": \"https://example.test/a,b\", \"arr\": [1,2]}",
        "// keep me",
        "\"theme\": \"Light\"",
    ] {
        assert!(saved.contains(retained), "lost {retained}: {saved}");
    }
    let reset = workspace
        .update_setting(SettingsScope::Workspace, "editor.fontSize", None)
        .unwrap();
    assert_eq!(reset.font_size, 19);
    assert!(!workspace
        .get_settings_keys_for_scope(SettingsScope::Workspace)
        .unwrap()
        .contains(&"fontSize".to_owned()));
    let reset = workspace
        .update_setting(SettingsScope::User, "fontSize", None)
        .unwrap();
    assert_eq!(reset.font_size, 13);
    assert!(fs::read_to_string(user).unwrap().contains('{'));
}

#[test]
fn settings_validate_known_values_before_atomic_write_and_keep_unknowns_during_typed_updates() {
    use span_core::SettingsScope;
    let directory = tempdir().unwrap();
    let workspace = CoreWorkspace::open(directory.path())
        .unwrap()
        .with_user_settings(None);
    let raw = "{ // retained\n\"files.autoSave\": \"off\", \"extension.keep\": true, \"editor.fontSize\": 15, }";
    workspace.update_settings_jsonc(raw).unwrap();
    for invalid in [
        r#"{"files.autoSave":"always"}"#,
        r#"{"files.autoSaveDelay":-1}"#,
        r#"{"files.autoSaveDelay":1.5}"#,
        r#"{"editor.wordWrap":"bounded"}"#,
        r#"{"editor.fontSize":"large"}"#,
        r#"{"window.zoomLevel":99}"#,
    ] {
        assert!(
            workspace.update_settings_jsonc(invalid).is_err(),
            "accepted {invalid}"
        );
        assert_eq!(workspace.get_settings_jsonc().unwrap(), raw);
    }
    assert!(workspace
        .update_setting(SettingsScope::Workspace, "extension.keep", Some("false"))
        .is_err());
    let mut settings = workspace.get_settings().unwrap();
    settings.font_size = 20;
    workspace.update_settings(settings).unwrap();
    let saved = workspace.get_settings_jsonc().unwrap();
    assert!(saved.contains("// retained"));
    assert!(saved.contains("\"extension.keep\": true"));
    assert_eq!(workspace.get_settings().unwrap().font_size, 20);
}

#[test]
fn jsonc_patch_handles_last_only_and_nested_settings_with_embedded_comments() {
    use span_core::SettingsScope;
    let directory = tempdir().unwrap();
    let workspace = CoreWorkspace::open(directory.path())
        .unwrap()
        .with_user_settings(None);
    for raw in [
        "{}",
        "{\"fontSize\":15}",
        "{\"extension.keep\":true,\"fontSize\":15}",
        "{\"fontSize\":15,\"extension.keep\":true}",
        "{\"formatters\":{\"rust\":[\"rustfmt\", /* retained comment */ \"--edition\",\"2024\"]}}",
    ] {
        workspace.update_settings_jsonc(raw).unwrap();
        workspace
            .update_setting(SettingsScope::Workspace, "fontSize", Some("18"))
            .unwrap();
        assert_eq!(workspace.get_settings().unwrap().font_size, 18);
        workspace
            .update_setting(SettingsScope::Workspace, "fontSize", None)
            .unwrap();
        assert_eq!(workspace.get_settings().unwrap().font_size, 13);
        if raw.contains("extension.keep") {
            assert!(workspace
                .get_settings_jsonc()
                .unwrap()
                .contains("\"extension.keep\":true"));
        }
        if raw.contains("retained comment") {
            assert!(workspace
                .get_settings_jsonc()
                .unwrap()
                .contains("/* retained comment */"));
        }
    }
    let raw = "{\r\n  \"fontSize\": /* keep this explanation */ 15 // keep this too\r\n}\r\n";
    workspace.update_settings_jsonc(raw).unwrap();
    workspace
        .update_setting(SettingsScope::Workspace, "fontSize", Some("18"))
        .unwrap();
    assert_eq!(
        workspace.get_settings_jsonc().unwrap(),
        raw.replace("15", "18")
    );
}

#[test]
fn trusted_settings_buffers_keep_invalid_drafts_and_save_valid_preferences() {
    use span_core::SettingsScope;
    let directory = tempdir().unwrap();
    let profile = tempdir().unwrap();
    let user = profile.path().join("profile/settings.jsonc");
    let mut workspace = CoreWorkspace::open(directory.path())
        .unwrap()
        .with_user_settings(Some(user.clone()));
    for scope in [SettingsScope::User, SettingsScope::Workspace] {
        let opened = workspace.open_settings_buffer(scope).unwrap();
        assert_eq!(opened.path, scope.buffer_path());
        assert_eq!(opened.language, "jsonc");
        let invalid = "{ invalid draft";
        let changed = workspace
            .edit_settings_buffer(
                scope,
                opened.revision,
                vec![TextEdit {
                    from: 0,
                    to: opened.text.encode_utf16().count() as u32,
                    insert: invalid.into(),
                }],
            )
            .unwrap();
        assert!(workspace
            .save_settings_buffer(scope, changed.revision)
            .is_err());
        let kept = workspace.open_settings_buffer(scope).unwrap();
        assert_eq!(kept.text, invalid);
        assert_eq!(kept.saved_revision, opened.saved_revision);
        assert_ne!(kept.revision, kept.saved_revision);
        let valid =
            "{ // explicit editor Save\n\"editor.fontSize\": 18, \"extension.keep\": true, }\n";
        let changed = workspace
            .edit_settings_buffer(
                scope,
                kept.revision,
                vec![TextEdit {
                    from: 0,
                    to: invalid.len() as u32,
                    insert: valid.into(),
                }],
            )
            .unwrap();
        let saved = workspace
            .save_settings_buffer(scope, changed.revision)
            .unwrap();
        assert_eq!(saved.text, valid);
        assert_eq!(saved.revision, saved.saved_revision);
        assert_eq!(
            workspace.get_settings_jsonc_for_scope(scope).unwrap(),
            valid
        );
        assert_eq!(workspace.get_settings().unwrap().font_size, 18);
    }
    assert!(user.exists());
}

#[test]
fn trusted_settings_buffers_reject_conflicts_stale_edits_and_general_agent_routes() {
    use span_core::SettingsScope;
    let directory = tempdir().unwrap();
    let profile = tempdir().unwrap();
    let user = profile.path().join("settings.jsonc");
    fs::write(&user, "{}").unwrap();
    let mut workspace = CoreWorkspace::open(directory.path())
        .unwrap()
        .with_user_settings(Some(user.clone()));
    let opened = workspace.open_settings_buffer(SettingsScope::User).unwrap();
    workspace
        .edit_settings_buffer(
            SettingsScope::User,
            opened.revision,
            vec![TextEdit {
                from: 1,
                to: 1,
                insert: "\"fontSize\":16".into(),
            }],
        )
        .unwrap();
    fs::write(&user, "{\"fontSize\":20}").unwrap();
    assert!(matches!(
        workspace.save_settings_buffer(SettingsScope::User, 1),
        Err(CoreError::SaveConflict(_))
    ));
    assert_ne!(
        workspace
            .open_settings_buffer(SettingsScope::User)
            .unwrap()
            .text,
        fs::read_to_string(&user).unwrap()
    );
    let reloaded = workspace
        .discard_settings_buffer(SettingsScope::User)
        .unwrap();
    assert_eq!(reloaded.text, "{\"fontSize\":20}");
    assert_eq!(reloaded.saved_revision, reloaded.revision);
    assert!(matches!(
        workspace.edit_settings_buffer(SettingsScope::User, 1, vec![]),
        Err(CoreError::StaleRevision { .. })
    ));
    for path in ["settings://user", "settings://workspace"] {
        assert!(matches!(
            workspace.open_buffer(path),
            Err(CoreError::OutsideWorkspace(_))
        ));
        assert!(matches!(
            workspace.agent_read(path),
            Err(CoreError::OutsideWorkspace(_))
        ));
        assert!(workspace.stage_proposal(path, 0, "{}".into()).is_err());
        assert!(workspace.edit_buffer_delta(path, 0, vec![]).is_err());
        assert!(workspace.take_format_request(path, 0).is_err());
    }
    assert!(matches!(
        workspace.agent_read(&user.to_string_lossy()),
        Err(CoreError::OutsideWorkspace(_))
    ));
    assert!(workspace
        .list_files()
        .unwrap()
        .iter()
        .all(|file| !file.path.starts_with("settings://")));
}

#[test]
fn settings_only_context_supports_user_preferences_without_any_filesystem_escape() {
    use span_core::SettingsScope;
    let profile = tempdir().unwrap();
    let user = profile.path().join("settings.jsonc");
    let mut context = CoreWorkspace::for_user_settings()
        .unwrap()
        .with_user_settings(Some(user.clone()));
    assert!(context.list_files().is_err());
    assert!(context.open_buffer("anything").is_err());
    assert!(context
        .open_settings_buffer(SettingsScope::Workspace)
        .is_err());
    assert!(context
        .get_settings_for_scope(SettingsScope::Workspace)
        .is_err());
    let opened = context.open_settings_buffer(SettingsScope::User).unwrap();
    context
        .edit_settings_buffer(
            SettingsScope::User,
            0,
            vec![TextEdit {
                from: 0,
                to: opened.text.len() as u32,
                insert: "{\"files.autoSave\":\"onFocusChange\"}".into(),
            }],
        )
        .unwrap();
    context
        .save_settings_buffer(SettingsScope::User, 1)
        .unwrap();
    assert_eq!(
        context.get_settings().unwrap().auto_save,
        span_core::AutoSaveMode::OnFocusChange
    );
    assert!(context.agent_read(&user.to_string_lossy()).is_err());
}

#[test]
fn workspace_settings_opened_from_explorer_also_validate_before_saving() {
    let directory = tempdir().unwrap();
    let mut workspace = CoreWorkspace::open(directory.path())
        .unwrap()
        .with_user_settings(None);
    workspace.update_settings_jsonc("{}").unwrap();
    workspace.open_buffer(".span/settings.jsonc").unwrap();
    workspace
        .edit_buffer_delta(
            ".span/settings.jsonc",
            0,
            vec![TextEdit {
                from: 1,
                to: 1,
                insert: "invalid".into(),
            }],
        )
        .unwrap();
    assert!(workspace.save_buffer(".span/settings.jsonc", 1).is_err());
    assert_eq!(workspace.get_settings_jsonc().unwrap(), "{}");
    let kept = workspace.buffer_snapshot(".span/settings.jsonc").unwrap();
    assert_eq!(kept.text, "{invalid}");
    assert_eq!(kept.saved_revision, 0);
}

#[test]
fn expanded_settings_validate_jsonc_roundtrip_and_shortcut_conflicts() {
    let directory = tempdir().unwrap();
    let workspace = CoreWorkspace::open(directory.path())
        .unwrap()
        .with_user_settings(None);
    let settings = Settings::default();
    assert_eq!(settings.auto_save, span_core::AutoSaveMode::Off);
    assert_eq!(settings.auto_save_delay, 1000);
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
fn tab_limit_defaults_aliases_scope_precedence_and_validation_are_consistent() {
    let directory = tempdir().unwrap();
    let profile = tempdir().unwrap();
    let user = profile.path().join("settings.jsonc");
    fs::write(
        &user,
        "{\"workbench.editor.limit.value\": 20, \"workbench.editor.limit.perEditorGroup\": true}",
    )
    .unwrap();
    let workspace = CoreWorkspace::open(directory.path())
        .unwrap()
        .with_user_settings(Some(user));
    let defaults = Settings::default();
    assert!(defaults.tab_limit_enabled);
    assert_eq!(defaults.tab_limit, 10);
    assert!(!defaults.tab_limit_per_group);
    let configured = workspace.update_settings_jsonc("{\"tabLimit\": 15, \"workbench.editor.limit.value\": 12, \"workbench.editor.limit.enabled\": false}").unwrap();
    assert_eq!(configured.tab_limit, 12);
    assert!(!configured.tab_limit_enabled);
    assert!(configured.tab_limit_per_group);
    workspace
        .update_setting(
            span_core::SettingsScope::Workspace,
            "workbench.editor.limit.value",
            Some("7"),
        )
        .unwrap();
    assert_eq!(workspace.get_settings().unwrap().tab_limit, 7);
    for value in [0, 201, u32::MAX] {
        assert!(workspace
            .update_settings(Settings {
                tab_limit: value,
                ..Default::default()
            })
            .is_err());
    }
}

#[test]
fn trusted_settings_dirty_state_clears_when_manual_edits_return_to_saved_text() {
    let directory = tempdir().unwrap();
    let profile = tempdir().unwrap();
    let mut workspace = CoreWorkspace::open(directory.path())
        .unwrap()
        .with_user_settings(Some(profile.path().join("settings.jsonc")));
    for scope in [
        span_core::SettingsScope::User,
        span_core::SettingsScope::Workspace,
    ] {
        let initial = workspace.open_settings_buffer(scope).unwrap();
        let edited = workspace
            .edit_settings_buffer(
                scope,
                initial.revision,
                vec![TextEdit {
                    from: 0,
                    to: 0,
                    insert: " ".into(),
                }],
            )
            .unwrap();
        assert_ne!(edited.revision, edited.saved_revision);
        let restored = workspace
            .edit_settings_buffer(
                scope,
                edited.revision,
                vec![TextEdit {
                    from: 0,
                    to: 1,
                    insert: "".into(),
                }],
            )
            .unwrap();
        assert_eq!(restored.revision, restored.saved_revision);
        assert_eq!(
            workspace.open_settings_buffer(scope).unwrap().text,
            initial.text
        );
    }
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

#[test]
fn unrelated_workspace_writes_pass_beside_user_only_keys_that_stay_ignored() {
    use span_core::SettingsScope::Workspace;
    let directory = tempdir().unwrap();
    let home = tempdir().unwrap();
    let workspace = CoreWorkspace::open(directory.path())
        .unwrap()
        .with_user_settings(Some(home.path().join("settings.jsonc")));
    let file = directory.path().join(".span/settings.jsonc");
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    // A cloned repository ships every kind of user-only key in its workspace file.
    fs::write(
        &file,
        "{\n  // cloned\n  \"agents\": { \"delegation\": { \"enabled\": true } },\n  \"updates\": { \"checkOnLaunch\": true },\n  \"languageServers\": { \"nodePath\": \"/tmp/evil\", \"runProjectCode\": true }\n}\n",
    )
    .unwrap();

    // Unrelated single key writes and whole file writes that keep those keys still work.
    let merged = workspace
        .update_setting(Workspace, "fontSize", Some("15"))
        .unwrap();
    assert_eq!(merged.font_size, 15);
    let text = fs::read_to_string(&file).unwrap();
    let merged = workspace
        .update_settings_jsonc(&text.replace("// cloned", "// cloned, reviewed"))
        .unwrap();
    assert_eq!(merged.font_size, 15);

    // None of the pre-existing keys turns anything on.
    for settings in [merged, workspace.get_settings().unwrap()] {
        assert!(!settings.agents.delegation.enabled);
        assert!(!settings.updates.check_on_launch);
        assert_eq!(settings.language_servers.node_path, None);
        assert!(!settings.language_servers.run_project_code);
    }
    let text = fs::read_to_string(&file).unwrap();
    assert!(
        text.contains("checkOnLaunch") && text.contains("/tmp/evil"),
        "{text}"
    );

    // Changing a language server user-only key in the workspace file is still refused.
    let err = workspace
        .update_setting(Workspace, "languageServers.nodePath", Some("\"/other\""))
        .unwrap_err();
    assert!(err.to_string().contains("user settings only"), "{err}");
}

#[test]
fn agent_run_tools_are_off_by_default_and_honoured_only_from_user_settings() {
    let directory = tempdir().unwrap();
    let home = tempdir().unwrap();
    let user = home.path().join("settings.jsonc");
    let workspace = CoreWorkspace::open(directory.path())
        .unwrap()
        .with_user_settings(Some(user.clone()));

    assert!(!workspace.run_tools_enabled().unwrap());
    workspace
        .update_settings_jsonc(r#"{"agents":{"runTools":{"enabled":true}}}"#)
        .unwrap();
    assert!(!workspace.run_tools_enabled().unwrap());
    fs::write(
        directory.path().join(".span/settings.jsonc"),
        r#"{"agents":{"runTools":{"enabled":true}}}"#,
    )
    .unwrap();
    assert!(!workspace.run_tools_enabled().unwrap());

    assert!(!workspace.get_settings().unwrap().agents.run_tools.enabled);
    workspace.set_run_tools_enabled(true).unwrap();
    assert!(workspace.get_settings().unwrap().agents.run_tools.enabled);
    assert!(workspace.run_tools_enabled().unwrap());
    let user_text = fs::read_to_string(user).unwrap();
    assert!(user_text.contains("\"runTools\""));
    let workspace_text = fs::read_to_string(directory.path().join(".span/settings.jsonc")).unwrap();
    assert_eq!(
        workspace_text,
        r#"{"agents":{"runTools":{"enabled":true}}}"#
    );

    let schema: serde_json::Value =
        serde_json::from_str(include_str!("../settings.schema.json")).unwrap();
    assert_eq!(
        schema["properties"]["agents"]["properties"]["runTools"]["properties"]["enabled"]
            ["default"],
        false
    );
}
