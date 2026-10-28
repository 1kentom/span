use super::*;
use serde_json::json;

fn from<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> T {
    serde_json::from_value(value).unwrap()
}

fn rng(l1: u32, c1: u32, l2: u32, c2: u32) -> serde_json::Value {
    json!({"start": {"line": l1, "character": c1}, "end": {"line": l2, "character": c2}})
}

fn range(l1: u32, c1: u32, l2: u32, c2: u32) -> RangeDto {
    from::<lsp::Range>(rng(l1, c1, l2, c2)).into()
}

fn root() -> PathBuf {
    std::env::temp_dir().join("span-nav-root")
}

fn file_uri(path: &Path) -> String {
    tauri::Url::from_file_path(path).unwrap().to_string()
}

#[test]
fn symbol_kinds_mirror_lsp_numbers() {
    assert_eq!(SymbolKindDto::from_number(1), SymbolKindDto::File);
    assert_eq!(SymbolKindDto::from_number(5), SymbolKindDto::Class);
    assert_eq!(SymbolKindDto::from_number(11), SymbolKindDto::Interface);
    assert_eq!(SymbolKindDto::from_number(22), SymbolKindDto::EnumMember);
    assert_eq!(SymbolKindDto::from_number(26), SymbolKindDto::TypeParameter);
    assert_eq!(SymbolKindDto::from_number(99), SymbolKindDto::Variable);
    let kind: lsp::SymbolKind = from(json!(12));
    assert_eq!(SymbolKindDto::from(kind), SymbolKindDto::Function);
    assert_eq!(
        serde_json::to_value(SymbolKindDto::EnumMember).unwrap(),
        json!("enumMember")
    );
}

#[test]
fn locations_are_relative_inside_and_external_outside() {
    let root = root();
    let range: lsp::Range = from(rng(1, 2, 1, 5));
    let inside = locate(&root, &file_uri(&root.join("src/a b.rs")), range);
    assert_eq!(inside.path, "src/a b.rs");
    assert_eq!(inside.display_path, "src/a b.rs");
    assert!(!inside.external);
    assert_eq!(inside.range.start.character, 2);

    let outside_path = std::env::temp_dir().join("elsewhere/lib.d.ts");
    let outside = locate(&root, &file_uri(&outside_path), range);
    assert!(outside.external);
    assert!(Path::new(&outside.path).is_absolute());

    // A sibling directory that merely shares the prefix is not inside the workspace.
    let sibling = std::env::temp_dir().join("span-nav-root-other/a.rs");
    assert!(locate(&root, &file_uri(&sibling), range).external);

    let library = locate(
        &root,
        &file_uri(&root.join("node_modules/@types/node/index.d.ts")),
        range,
    );
    assert!(library.external, "library files are read only");
    assert_eq!(library.path, "node_modules/@types/node/index.d.ts");
}

#[test]
fn non_file_uris_are_kept_and_external() {
    let loc = locate(
        &root(),
        "jdt://contents/java.base/java.lang/String.class?=proj/%5C/opt",
        lsp::Range::default(),
    );
    assert!(loc.external);
    assert!(loc.path.starts_with("jdt://contents/"));
    assert_eq!(loc.display_path, "java.base/java.lang/String.class");
}

const REPORTED_JDT_URI: &str = "jdt://contents/javafx-fxml-21.0.2-mac-aarch64.jar/javafx.fxml/FXMLLoader.java?=todo/%5C/Users%5C/user%5C/.m2%5C/repository%5C/org%5C/openjfx%5C/javafx-fxml%5C/21.0.2%5C/javafx-fxml-21.0.2-mac-aarch64.jar=/maven.pomderived=/true=/=/module=/true=/=/javadoc_location=/jar:file:...";

#[test]
fn maven_jar_class_uri_keeps_the_raw_uri_and_shows_a_clean_name() {
    let located = locate(&root(), REPORTED_JDT_URI, lsp::Range::default());
    assert!(located.external);
    assert_eq!(located.path, REPORTED_JDT_URI, "the URI is kept verbatim");
    assert_eq!(located.display_path, "javafx.fxml/FXMLLoader.java");
    let t = tree();
    assert_eq!(
        resolve_source(&t.workspace, &loc(REPORTED_JDT_URI, true)).unwrap(),
        ResolvedSource::Jdt(REPORTED_JDT_URI.into()),
        "the server receives exactly the URI it sent"
    );
}

#[test]
fn hierarchical_and_flat_document_symbols_map() {
    let nested: lsp::DocumentSymbolResponse = from(json!([
        {"name": "Outer", "kind": 5, "detail": "class",
         "range": rng(0, 0, 9, 1), "selectionRange": rng(0, 6, 0, 11),
         "children": [{"name": "m", "kind": 6, "range": rng(1, 2, 3, 3),
                       "selectionRange": rng(1, 2, 1, 3)}]}
    ]));
    let symbols = map_document_symbols(Some(nested));
    assert_eq!(symbols[0].kind, SymbolKindDto::Class);
    assert_eq!(symbols[0].children[0].name, "m");
    assert_eq!(symbols[0].children[0].kind, SymbolKindDto::Method);

    let flat: lsp::DocumentSymbolResponse = from(json!([
        {"name": "F", "kind": 12, "containerName": "pkg",
         "location": {"uri": "file:///x.ts", "range": rng(2, 0, 4, 1)}}
    ]));
    let symbols = map_document_symbols(Some(flat));
    assert_eq!(symbols[0].detail.as_deref(), Some("pkg"));
    assert_eq!(symbols[0].range, range(2, 0, 4, 1));
    assert!(symbols[0].children.is_empty());
    assert!(map_document_symbols(None).is_empty());
}

#[test]
fn document_symbol_trees_are_capped() {
    let children: Vec<_> = (0..MAX_DOCUMENT_SYMBOLS + 10)
        .map(|i| {
            json!({"name": format!("s{i}"), "kind": 13,
                   "range": rng(0, 0, 0, 1), "selectionRange": rng(0, 0, 0, 1)})
        })
        .collect();
    let response: lsp::DocumentSymbolResponse = from(json!([
        {"name": "root", "kind": 2, "range": rng(0, 0, 0, 1),
         "selectionRange": rng(0, 0, 0, 1), "children": children}
    ]));
    let symbols = map_document_symbols(Some(response));
    assert_eq!(symbols[0].children.len(), MAX_DOCUMENT_SYMBOLS - 1);
}

fn ws_symbol(name: &str) -> WorkspaceSymbolDto {
    WorkspaceSymbolDto {
        name: name.into(),
        kind: SymbolKindDto::Function,
        container_name: None,
        location: locate(&root(), "file:///x.ts", lsp::Range::default()),
    }
}

#[test]
fn workspace_symbols_map_flat_nested_and_lazy_locations() {
    let nested: lsp::WorkspaceSymbolResponse = from(json!([
        {"name": "a", "kind": 5, "containerName": "m",
         "location": {"uri": "file:///elsewhere/a.d.ts", "range": rng(1, 1, 1, 2)}},
        {"name": "lazy", "kind": 12, "location": {"uri": "file:///elsewhere/b.d.ts"}}
    ]));
    let mapped = map_workspace_symbols(&root(), Some(nested));
    assert_eq!(mapped[0].container_name.as_deref(), Some("m"));
    assert!(mapped[0].location.external);
    assert_eq!(mapped[1].location.range, range(0, 0, 0, 0));

    let flat: lsp::WorkspaceSymbolResponse = from(json!([
        {"name": "f", "kind": 12, "location": {"uri": "file:///x.rs", "range": rng(0, 0, 0, 1)}}
    ]));
    assert_eq!(map_workspace_symbols(&root(), Some(flat)).len(), 1);
}

#[test]
fn merged_workspace_symbols_interleave_and_cap_at_200() {
    let a: Vec<_> = (0..300).map(|i| ws_symbol(&format!("a{i}"))).collect();
    let b: Vec<_> = (0..300).map(|i| ws_symbol(&format!("b{i}"))).collect();
    let merged = merge_workspace_symbols(vec![a, b]);
    assert_eq!(merged.len(), MAX_WORKSPACE_SYMBOLS);
    assert_eq!(merged[0].name, "a0");
    assert_eq!(merged[1].name, "b0");
    assert_eq!(
        merged.iter().filter(|s| s.name.starts_with('b')).count(),
        100
    );
    assert_eq!(
        merge_workspace_symbols(vec![vec![ws_symbol("x")], vec![]]).len(),
        1
    );
}

#[test]
fn hierarchy_tokens_round_trip_the_server_item() {
    let item: lsp::CallHierarchyItem = from(json!({
        "name": "f", "kind": 12, "uri": "file:///elsewhere/x.ts",
        "range": rng(1, 0, 3, 1), "selectionRange": rng(1, 4, 1, 5),
        "data": {"opaque": [1, {"k": "v"}]}
    }));
    let dto = map_call_item(&root(), ServerId::Vtsls, Path::new("/ws"), item);
    assert!(dto.location.external);
    let decoded = decode_token(&dto.token, CALL_KIND).unwrap();
    assert_eq!(decoded.server, ServerId::Vtsls);
    assert_eq!(decoded.root, PathBuf::from("/ws"));
    assert_eq!(decoded.item["data"]["opaque"][1]["k"], "v");
    // A call hierarchy token is not a type hierarchy token.
    assert!(decode_token(&dto.token, TYPE_KIND).is_err());
}

#[test]
fn forged_or_oversize_tokens_are_refused() {
    for bad in ["", "not base64!!", "e30", "bm90LWpzb24"] {
        assert!(decode_token(bad, CALL_KIND).is_err(), "{bad:?}");
    }
    let huge = "A".repeat(MAX_TOKEN_BYTES + 1);
    assert!(decode_token(&huge, CALL_KIND).is_err());
}

#[test]
fn signature_help_parameters_use_utf16_offsets() {
    // The emoji is a surrogate pair: "f(😀, b)" has `b` at UTF-16 offset 6.
    let help: lsp::SignatureHelp = from(json!({
        "signatures": [{"label": "f(😀, b)", "documentation": {"kind": "markdown", "value": "docs"},
            "parameters": [{"label": [2, 4]}, {"label": "b", "documentation": "the b"}]}],
        "activeSignature": 0, "activeParameter": 1}));
    let dto = map_signature_help(Some(help)).unwrap();
    let sig = &dto.signatures[0];
    assert_eq!(sig.documentation.as_deref(), Some("docs"));
    assert_eq!(sig.parameters[0].label, "😀");
    assert_eq!(
        (sig.parameters[0].label_start, sig.parameters[0].label_end),
        (Some(2), Some(4))
    );
    assert_eq!(
        (sig.parameters[1].label_start, sig.parameters[1].label_end),
        (Some(6), Some(7))
    );
    assert_eq!(sig.parameters[1].documentation.as_deref(), Some("the b"));
    assert_eq!(dto.active_parameter, Some(1));
    assert!(map_signature_help(None).is_none());
    assert!(map_signature_help(Some(from(json!({"signatures": []})))).is_none());
    assert_eq!(utf16_slice("a😀b", 1, 3).as_deref(), Some("😀"));
    assert_eq!(utf16_slice("ab", 1, 9), None);
}

#[test]
fn highlights_and_prepare_rename_map() {
    let hl = map_highlights(Some(from(json!([
        {"range": rng(0, 0, 0, 1), "kind": 2},
        {"range": rng(1, 0, 1, 1), "kind": 3},
        {"range": rng(2, 0, 2, 1)},
    ]))));
    assert_eq!(hl[0].kind, DocumentHighlightKindDto::Read);
    assert_eq!(hl[1].kind, DocumentHighlightKindDto::Write);
    assert_eq!(hl[2].kind, DocumentHighlightKindDto::Text);

    let p = map_prepare_rename(Some(from(
        json!({"range": rng(0, 0, 0, 3), "placeholder": "old"}),
    )));
    assert_eq!(p.unwrap().placeholder.as_deref(), Some("old"));
    let p = map_prepare_rename(Some(from(json!({"defaultBehavior": true})))).unwrap();
    assert!(p.default_behavior && p.range.is_none());
    assert!(map_prepare_rename(None).is_none());
}

#[test]
fn workspace_edits_map_per_file_and_count_resource_operations() {
    let root = root();
    let inside = file_uri(&root.join("src/a.ts"));
    let outside = file_uri(&std::env::temp_dir().join("elsewhere/b.ts"));
    let edit = |l: u32, text: &str| json!({"range": rng(l, 0, l, 1), "newText": text});
    let changes: lsp::WorkspaceEdit = from(json!({
        "changes": {inside.clone(): [edit(3, "late"), edit(1, "early")], outside.clone(): [edit(0, "x")]}
    }));
    let dto = map_workspace_edit(&root, Some(changes));
    assert_eq!(dto.files.len(), 2);
    let a = dto.files.iter().find(|f| f.path == "src/a.ts").unwrap();
    assert!(!a.external);
    assert_eq!(a.edits[0].new_text, "early", "edits are sorted by position");
    assert!(dto.files.iter().find(|f| f.external).is_some());
    assert_eq!(dto.skipped_operations, 0);

    let doc: lsp::WorkspaceEdit = from(json!({"documentChanges": [
        {"textDocument": {"uri": inside, "version": 3},
         "edits": [edit(0, "a"), {"range": rng(2, 0, 2, 1), "newText": "b", "annotationId": "x"}]},
        {"kind": "rename", "oldUri": "file:///a.ts", "newUri": "file:///b.ts"},
        {"kind": "delete", "uri": "file:///c.ts"},
    ]}));
    let dto = map_workspace_edit(&root, Some(doc));
    assert_eq!(dto.files.len(), 1);
    assert_eq!(dto.files[0].edits.len(), 2);
    assert_eq!(dto.skipped_operations, 2);
    assert!(map_workspace_edit(&root, None).files.is_empty());
}

#[test]
fn snippets_clamp_context_and_total_lines() {
    let text: String = (0..3000).map(|i| format!("line {i}\n")).collect();
    let (start, body, highlight) = snippet(&text, range(1000, 2, 1001, 4), 5).unwrap();
    assert_eq!(start, 995);
    assert_eq!(body.lines().count(), 5 + 2 + 5);
    assert_eq!(body.lines().next(), Some("line 995"));
    assert_eq!(highlight, range(1000, 2, 1001, 4));

    // Context beyond the cap is clamped to 400 lines on each side.
    let (start, body, _) = snippet(&text, range(1000, 0, 1000, 1), u32::MAX).unwrap();
    assert_eq!(start, 1000 - MAX_CONTEXT_LINES);
    assert_eq!(body.lines().count() as u32, 2 * MAX_CONTEXT_LINES + 1);

    // A huge range is cut to the snippet cap and the highlight follows.
    let (start, body, highlight) = snippet(&text, range(0, 0, 2500, 3), 0).unwrap();
    assert_eq!(start, 0);
    assert_eq!(body.lines().count(), MAX_SNIPPET_LINES);
    assert_eq!(highlight.end.line, MAX_SNIPPET_LINES as u32 - 1);

    // Near the start and end of the file nothing underflows or overruns.
    let (start, _, _) = snippet(&text, range(2, 0, 2, 1), 400).unwrap();
    assert_eq!(start, 0);
    let (_, body, _) = snippet("a\r\nb\r\n", range(0, 0, 0, 1), 10).unwrap();
    assert_eq!(body, "a\nb\n");

    assert!(snippet("one line", range(5, 0, 5, 1), 0).is_err());
    assert!(snippet("one line", range(0, 0, 0, 1), 0).is_ok());
    assert!(snippet("abc", range(1, 0, 0, 0), 0).is_err());
}

fn loc(path: &str, external: bool) -> LocationDto {
    LocationDto {
        path: path.into(),
        range: range(0, 0, 0, 1),
        external,
        display_path: path.into(),
    }
}

struct Tree {
    _dir: tempfile::TempDir,
    workspace: PathBuf,
    lib: PathBuf,
}

fn tree() -> Tree {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let workspace = base.join("project");
    let lib = base.join("lib");
    std::fs::create_dir_all(workspace.join("src")).unwrap();
    std::fs::create_dir_all(workspace.join("node_modules/pkg")).unwrap();
    std::fs::create_dir_all(lib.join(".ssh")).unwrap();
    std::fs::write(workspace.join("src/a.ts"), "export const a = 1;\n").unwrap();
    std::fs::write(
        workspace.join("node_modules/pkg/index.d.ts"),
        "declare const p: 1;\n",
    )
    .unwrap();
    std::fs::write(lib.join("types.d.ts"), "declare const t: 1;\n").unwrap();
    std::fs::write(lib.join("secret.pem"), "-----BEGIN-----\n").unwrap();
    std::fs::write(lib.join(".ssh/config.txt"), "Host x\n").unwrap();
    Tree {
        _dir: dir,
        workspace,
        lib,
    }
}

#[test]
fn workspace_sources_resolve_and_traversal_is_refused() {
    let t = tree();
    let ok = resolve_source(&t.workspace, &loc("src/a.ts", false)).unwrap();
    assert_eq!(
        ok,
        ResolvedSource::File {
            path: t.workspace.join("src/a.ts"),
            external: false
        }
    );
    for bad in [
        "../lib/types.d.ts",
        "src/../../lib/types.d.ts",
        "src/../../../etc/passwd",
        "",
        "src/\0a.ts",
        "missing.ts",
    ] {
        assert!(
            resolve_source(&t.workspace, &loc(bad, false)).is_err(),
            "{bad:?} must be refused"
        );
    }
    // An absolute path outside the workspace is not allowed unless marked external.
    let abs = t.lib.join("types.d.ts").to_string_lossy().into_owned();
    assert!(resolve_source(&t.workspace, &loc(&abs, false)).is_err());
}

#[test]
fn external_sources_are_absolute_known_types_outside_credential_dirs() {
    let t = tree();
    let abs = |p: &str| t.lib.join(p).to_string_lossy().into_owned();
    let ok = resolve_source(&t.workspace, &loc(&abs("types.d.ts"), true)).unwrap();
    assert!(matches!(ok, ResolvedSource::File { external: true, .. }));
    // Relative external paths cannot reach outside.
    assert!(resolve_source(&t.workspace, &loc("../lib/types.d.ts", true)).is_err());
    // Unknown file types and credential directories are refused.
    assert!(resolve_source(&t.workspace, &loc(&abs("secret.pem"), true)).is_err());
    assert!(resolve_source(&t.workspace, &loc(&abs(".ssh/config.txt"), true)).is_err());
    // A path that climbs out and back still resolves to the same checked file.
    let climbing = format!("{}/../lib/types.d.ts", t.workspace.display());
    let resolved = resolve_source(&t.workspace, &loc(&climbing, true)).unwrap();
    assert_eq!(
        resolved,
        ResolvedSource::File {
            path: t.lib.join("types.d.ts"),
            external: true
        }
    );
    let climbing_secret = format!("{}/../lib/secret.pem", t.workspace.display());
    assert!(resolve_source(&t.workspace, &loc(&climbing_secret, true)).is_err());
}

#[test]
fn library_files_inside_the_workspace_are_external() {
    let t = tree();
    let resolved =
        resolve_source(&t.workspace, &loc("node_modules/pkg/index.d.ts", false)).unwrap();
    assert!(matches!(
        resolved,
        ResolvedSource::File { external: true, .. }
    ));
}

#[cfg(unix)]
#[test]
fn symlinks_cannot_escape_the_workspace() {
    let t = tree();
    std::os::unix::fs::symlink(t.lib.join("types.d.ts"), t.workspace.join("src/link.ts")).unwrap();
    assert!(resolve_source(&t.workspace, &loc("src/link.ts", false)).is_err());
    std::os::unix::fs::symlink(&t.lib, t.workspace.join("linked")).unwrap();
    assert!(resolve_source(&t.workspace, &loc("linked/types.d.ts", false)).is_err());
    // Marked external, the link target is judged by its real path and file type.
    let secret = t.workspace.join("src/pem.ts");
    std::os::unix::fs::symlink(t.lib.join("secret.pem"), &secret).unwrap();
    assert!(resolve_source(&t.workspace, &loc(&secret.to_string_lossy(), true)).is_err());
}

#[test]
fn uri_schemes_are_limited_to_jdt_and_file() {
    let t = tree();
    let jdt = "jdt://contents/java.base/java.lang/String.class?=p";
    assert_eq!(
        resolve_source(&t.workspace, &loc(jdt, true)).unwrap(),
        ResolvedSource::Jdt(jdt.into())
    );
    for bad in [
        "http://example.com/a.ts",
        "https://example.com/a.ts",
        "ftp://x/a.ts",
        "javascript://a",
        "jar:file:///x.jar!/A.class",
    ] {
        assert!(
            resolve_source(&t.workspace, &loc(bad, true)).is_err(),
            "{bad}"
        );
    }
    let uri = file_uri(&t.lib.join("types.d.ts"));
    assert!(resolve_source(&t.workspace, &loc(&uri, true)).is_ok());
    assert!(resolve_source(&t.workspace, &loc(&uri, false)).is_err());
    let long = format!("jdt://{}", "a".repeat(MAX_URI_BYTES));
    assert!(resolve_source(&t.workspace, &loc(&long, true)).is_err());
}

#[test]
fn text_reads_refuse_oversize_binary_and_non_files() {
    let t = tree();
    let dir = &t.lib;
    std::fs::write(dir.join("ok.txt"), "héllo\n").unwrap();
    assert_eq!(read_text_file(&dir.join("ok.txt")).unwrap(), "héllo\n");

    let at_cap = vec![b'a'; MAX_SOURCE_BYTES as usize];
    std::fs::write(dir.join("cap.txt"), &at_cap).unwrap();
    assert_eq!(
        read_text_file(&dir.join("cap.txt")).unwrap().len(),
        at_cap.len()
    );

    std::fs::write(
        dir.join("big.txt"),
        vec![b'a'; MAX_SOURCE_BYTES as usize + 1],
    )
    .unwrap();
    assert!(read_text_file(&dir.join("big.txt")).is_err());
    std::fs::write(dir.join("bin.txt"), b"abc\0def").unwrap();
    assert!(read_text_file(&dir.join("bin.txt")).is_err());
    std::fs::write(dir.join("latin.txt"), [0xff, 0xfe, b'a']).unwrap();
    assert!(read_text_file(&dir.join("latin.txt")).is_err());
    assert!(read_text_file(dir).is_err(), "directories are refused");
    assert!(read_text_file(&dir.join("nope.txt")).is_err());

    assert!(check_text(vec![b'a'; MAX_SOURCE_BYTES as usize + 1]).is_err());
    assert!(check_text(b"a\0".to_vec()).is_err());
    assert!(check_text(b"fine".to_vec()).is_ok());
}
