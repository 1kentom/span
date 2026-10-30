use span_core::{CoreWorkspace, SearchQuery};
use std::{fs, path::Path};
use tempfile::TempDir;

fn write(root: &Path, path: &str, text: &str) {
    let file = root.join(path);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, text).unwrap();
}

fn workspace(root: &Path) -> CoreWorkspace {
    CoreWorkspace::open(root).unwrap().with_user_settings(None)
}

fn paths(entries: Vec<span_core::FileEntry>) -> Vec<String> {
    entries.into_iter().map(|entry| entry.path).collect()
}

#[test]
fn hidden_preferences_apply_to_listing_and_text_search_without_hiding_examples_by_default() {
    let root = TempDir::new().unwrap();
    write(root.path(), ".env.example", "visibility marker");
    write(root.path(), ".config/tool.txt", "visibility marker");
    write(root.path(), "src/visible.rs", "visibility marker");
    let workspace = workspace(root.path());
    assert!(paths(workspace.list_directory(".").unwrap()).contains(&".env.example".to_owned()));
    write(
        root.path(),
        ".span/settings.jsonc",
        r#"{"explorer":{"showHiddenFiles":false}}"#,
    );
    let listed = paths(workspace.list_directory(".").unwrap());
    assert!(
        !listed.contains(&".env.example".to_owned()),
        "Hidden dotfiles must disappear after the setting changes: {listed:?}"
    );
    assert!(!listed.contains(&".config".to_owned()));
    assert!(
        workspace.list_directory(".config").unwrap().is_empty(),
        "A stale expanded hidden ancestor must not bypass the policy"
    );
    let all = paths(workspace.list_files().unwrap());
    assert_eq!(all, ["src/visible.rs"]);
    let found = workspace
        .search(SearchQuery {
            text: "visibility marker".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        found
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>(),
        ["src/visible.rs"]
    );
}

#[test]
fn ignored_opt_in_reveals_lazy_rows_and_ordinary_sources_but_keeps_known_outputs_out_of_background_scans(
) {
    let root = TempDir::new().unwrap();
    write(
        root.path(),
        ".gitignore",
        "ignored/\nnode_modules/\ntarget/\ndist/\n",
    );
    write(root.path(), "Cargo.toml", "[package]\nname='fixture'\n");
    write(root.path(), "package.json", "{}");
    for path in [
        "ignored/source.rs",
        "node_modules/dependency/index.js",
        "target/debug/generated.rs",
        "dist/bundle.js",
        "build/source.rs",
    ] {
        write(root.path(), path, "visibility marker");
    }
    let workspace = workspace(root.path());
    assert!(!paths(workspace.list_directory(".").unwrap()).contains(&"ignored".to_owned()));
    write(
        root.path(),
        ".span/settings.jsonc",
        r#"{"explorer":{"showIgnoredFiles":true}}"#,
    );
    let listed = paths(workspace.list_directory(".").unwrap());
    for name in ["ignored", "node_modules", "target", "dist", "build"] {
        assert!(
            listed.contains(&name.to_owned()),
            "Opt-in should expose an expandable {name} row: {listed:?}"
        );
    }
    assert_eq!(
        paths(workspace.list_directory("node_modules").unwrap()),
        ["node_modules/dependency"]
    );
    let rows = workspace.list_directory("node_modules/dependency").unwrap();
    assert!(rows
        .iter()
        .all(|entry| entry.ignored && entry.background_excluded));
    assert!(workspace
        .list_directory("ignored")
        .unwrap()
        .iter()
        .all(|entry| entry.ignored));
    let all = paths(workspace.list_files().unwrap());
    assert!(all.contains(&"ignored/source.rs".to_owned()));
    assert!(
        all.contains(&"build/source.rs".to_owned()),
        "A source directory named build is not automatically an output directory"
    );
    assert!(
        !all.iter().any(|path| path.starts_with("node_modules/")
            || path.starts_with("target/")
            || path.starts_with("dist/")),
        "Background traversal must not enter known outputs: {all:?}"
    );
    let found = workspace
        .search(SearchQuery {
            text: "visibility marker".into(),
            ..Default::default()
        })
        .unwrap();
    let found = found
        .iter()
        .map(|entry| entry.path.as_str())
        .collect::<Vec<_>>();
    assert!(found.contains(&"ignored/source.rs"));
    assert!(found.contains(&"build/source.rs"));
    assert_eq!(found.len(), 2);
}

#[test]
fn ignore_negation_metadata_and_invalid_preferences_retain_safe_discovery() {
    let root = TempDir::new().unwrap();
    write(root.path(), ".gitignore", "private/*\n!private/keep.rs\n");
    write(root.path(), "private/keep.rs", "keep");
    write(root.path(), "private/hide.rs", "hide");
    write(root.path(), ".git/config", "metadata");
    write(root.path(), ".env.example", "example");
    let workspace = workspace(root.path());
    let entries = paths(workspace.list_directory("private").unwrap());
    assert_eq!(entries, ["private/keep.rs"]);
    assert!(workspace.list_directory(".git").unwrap().is_empty());
    write(
        root.path(),
        ".span/settings.jsonc",
        r#"{"explorer":{"showHiddenFiles":"invalid"}}"#,
    );
    let entries = paths(workspace.list_directory(".").unwrap());
    assert!(
        entries.contains(&".env.example".into()),
        "Malformed settings should preserve basic listing availability with defaults"
    );
    assert!(!paths(workspace.list_files().unwrap()).contains(&"private/hide.rs".into()));
}

#[test]
fn immutable_search_snapshot_keeps_the_effective_user_visibility_policy() {
    let root = TempDir::new().unwrap();
    let profile = TempDir::new().unwrap();
    let user = profile.path().join("settings.jsonc");
    write(root.path(), ".env.example", "snapshot marker");
    write(root.path(), "source.rs", "snapshot marker");
    fs::write(&user, r#"{"explorer":{"showHiddenFiles":false}}"#).unwrap();
    let workspace = CoreWorkspace::open(root.path())
        .unwrap()
        .with_user_settings(Some(user.clone()));
    let snapshot = workspace.search_snapshot();
    fs::write(&user, r#"{"explorer":{"showHiddenFiles":true}}"#).unwrap();
    let query = SearchQuery {
        text: "snapshot marker".into(),
        ..Default::default()
    };
    assert_eq!(
        snapshot
            .search(query.clone())
            .unwrap()
            .iter()
            .map(|found| found.path.as_str())
            .collect::<Vec<_>>(),
        ["source.rs"]
    );
    assert_eq!(workspace.search(query).unwrap().len(), 2);
}
