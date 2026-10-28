use super::*;

struct Sandbox {
    _dir: tempfile::TempDir,
    base: PathBuf,
    store: TrustStore,
}

fn sandbox() -> Sandbox {
    let dir = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(dir.path()).unwrap();
    let store = TrustStore::new(base.join("profile").join(FILE_NAME));
    Sandbox {
        _dir: dir,
        base,
        store,
    }
}

impl Sandbox {
    fn folder(&self, relative: &str) -> PathBuf {
        let path = relative
            .split('/')
            .fold(self.base.clone(), |p, part| p.join(part));
        fs::create_dir_all(&path).unwrap();
        path
    }
    fn raw(&self) -> serde_json::Value {
        serde_json::from_str(&fs::read_to_string(self.store.path()).unwrap()).unwrap()
    }
    fn resolve(&self, folder: &Path) -> Resolution {
        resolve(&self.store.load(), &key_for(folder))
    }
}

#[test]
fn round_trip_writes_the_documented_format() {
    let s = sandbox();
    let a = s.folder("work/a");
    assert!(s.store.load().is_empty(), "missing file means no decisions");
    assert!(s.store.decide_at(&a, TrustChoice::Trusted, 0).unwrap());
    let raw = s.raw();
    assert_eq!(raw["version"], 1);
    let entry = &raw["folders"][key_for(&a)];
    assert_eq!(entry["decision"], "trusted");
    assert_eq!(entry["decidedAt"], "1970-01-01T00:00:00Z");
    let again = TrustStore::new(s.store.path());
    assert_eq!(
        resolve(&again.load(), &key_for(&a)).choice,
        Some(TrustChoice::Trusted)
    );
    // Idempotent: the same decision changes nothing, including decidedAt.
    assert!(!s.store.decide_at(&a, TrustChoice::Trusted, 99).unwrap());
    assert_eq!(
        s.raw()["folders"][key_for(&a)]["decidedAt"],
        "1970-01-01T00:00:00Z"
    );
    // A different decision replaces it.
    assert!(s.store.decide_at(&a, TrustChoice::Restricted, 99).unwrap());
    assert_eq!(s.resolve(&a).choice, Some(TrustChoice::Restricted));
}

#[test]
fn rfc3339_text_is_utc() {
    assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
    assert_eq!(rfc3339_utc(1_709_210_096), "2024-02-29T12:34:56Z");
    assert_eq!(rfc3339_utc(4_102_444_799), "2099-12-31T23:59:59Z");
}

#[test]
fn a_corrupt_file_is_moved_aside_once_and_a_fresh_store_starts() {
    let s = sandbox();
    let a = s.folder("a");
    fs::create_dir_all(s.store.path().parent().unwrap()).unwrap();
    fs::write(s.store.path(), "{ not json").unwrap();
    assert!(s.store.load().is_empty());
    assert!(!s.store.path().exists(), "the corrupt file was renamed");
    let corrupt: Vec<_> = fs::read_dir(s.store.path().parent().unwrap())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
        .collect();
    assert_eq!(corrupt.len(), 1);
    assert_eq!(fs::read_to_string(corrupt[0].path()).unwrap(), "{ not json");
    // Reading again does not move anything else, and a decision starts a fresh store.
    assert!(s.store.load().is_empty());
    s.store.decide(&a, TrustChoice::Trusted).unwrap();
    assert_eq!(s.resolve(&a).choice, Some(TrustChoice::Trusted));
    // Valid JSON of the wrong shape is corrupt too.
    fs::write(s.store.path(), "[1, 2]").unwrap();
    assert!(s.store.load().is_empty());
}

#[test]
fn a_trusted_parent_covers_subfolders_and_a_restricted_subfolder_wins() {
    let s = sandbox();
    let parent = s.folder("work");
    let child = s.folder("work/app");
    let grandchild = s.folder("work/app/service");
    let sibling = s.folder("other");
    s.store.decide(&parent, TrustChoice::Trusted).unwrap();
    let r = s.resolve(&grandchild);
    assert_eq!(r.choice, Some(TrustChoice::Trusted));
    assert!(r.inherited);
    assert_eq!(r.source.as_deref(), Some(key_for(&parent).as_str()));
    assert!(!s.resolve(&parent).inherited);
    assert_eq!(s.resolve(&sibling).choice, None);
    // A folder whose name merely starts like the parent is not covered.
    let lookalike = s.folder("work2");
    assert_eq!(s.resolve(&lookalike).choice, None);

    s.store.decide(&child, TrustChoice::Restricted).unwrap();
    assert_eq!(s.resolve(&child).choice, Some(TrustChoice::Restricted));
    assert!(!s.resolve(&child).inherited);
    // The restricted entry covers exactly its folder: nested folders fall back to the parent.
    assert_eq!(s.resolve(&grandchild).choice, Some(TrustChoice::Trusted));
    assert_eq!(s.resolve(&parent).choice, Some(TrustChoice::Trusted));
}

#[test]
fn trailing_separators_and_spellings_meet() {
    let s = sandbox();
    let a = s.folder("a");
    s.store.decide(&a, TrustChoice::Trusted).unwrap();
    let with_slash = PathBuf::from(format!("{}{}", a.display(), std::path::MAIN_SEPARATOR));
    assert_eq!(s.resolve(&with_slash).choice, Some(TrustChoice::Trusted));
    assert!(!s.store.decide(&with_slash, TrustChoice::Trusted).unwrap());
    assert_eq!(s.store.load().len(), 1);
    // Verbatim and drive letter spellings normalise to one key and one comparison form.
    for (a, b) in [
        ("\\\\?\\C:\\Work\\app", "c:\\work\\APP"),
        ("C:/Work/app/", "C:\\Work\\app"),
    ] {
        let ka = trim_key(&normalize_path_text(a));
        let kb = trim_key(&normalize_path_text(b));
        assert_eq!(fold(&ka), fold(&kb), "{a} {b}");
    }
    let mut entries = Entries::new();
    entries.insert(
        "C:\\Work".into(),
        TrustEntry::new(TrustChoice::Trusted, "x".into()),
    );
    assert_eq!(
        resolve(&entries, "c:\\work\\App\\Sub").choice,
        Some(TrustChoice::Trusted)
    );
    assert_eq!(resolve(&entries, "C:\\Workshop").choice, None);
}

#[test]
fn migration_imports_the_old_setting_once_and_keeps_later_decisions() {
    let s = sandbox();
    let a = s.folder("legacy/a");
    let b = s.folder("legacy/b");
    let legacy = vec![
        a.to_string_lossy().into_owned(),
        b.to_string_lossy().into_owned(),
        "relative/dir".into(),
        String::new(),
    ];
    assert_eq!(s.store.import_legacy(&legacy).unwrap(), 2);
    assert_eq!(s.resolve(&a).choice, Some(TrustChoice::Trusted));
    let before = fs::read_to_string(s.store.path()).unwrap();
    // Idempotent: nothing is added and the file is not rewritten.
    assert_eq!(s.store.import_legacy(&legacy).unwrap(), 0);
    assert_eq!(fs::read_to_string(s.store.path()).unwrap(), before);
    // A decision made afterwards is not overridden by the stale setting.
    s.store.decide(&a, TrustChoice::Restricted).unwrap();
    assert_eq!(s.store.import_legacy(&legacy).unwrap(), 0);
    assert_eq!(s.resolve(&a).choice, Some(TrustChoice::Restricted));
}

#[test]
fn the_store_keeps_at_most_500_entries_dropping_the_oldest() {
    let s = sandbox();
    let mut file = StoreFile {
        version: 1,
        folders: Entries::new(),
        extra: BTreeMap::new(),
    };
    for i in 0..MAX_ENTRIES {
        file.folders.insert(
            format!("/w/{i:04}"),
            TrustEntry::new(TrustChoice::Trusted, rfc3339_utc(1_000 + i as u64)),
        );
    }
    fs::create_dir_all(s.store.path().parent().unwrap()).unwrap();
    s.store.write(&file).unwrap();
    assert_eq!(s.store.load().len(), MAX_ENTRIES);
    let fresh = s.folder("fresh");
    s.store
        .decide_at(&fresh, TrustChoice::Trusted, 9_999)
        .unwrap();
    let entries = s.store.load();
    assert_eq!(entries.len(), MAX_ENTRIES);
    assert!(!entries.contains_key("/w/0000"), "the oldest was dropped");
    assert!(entries.contains_key("/w/0001"));
    assert!(entries.contains_key(&key_for(&fresh)));
}

#[test]
fn unknown_fields_and_decisions_from_a_newer_build_survive_a_rewrite() {
    let s = sandbox();
    let a = s.folder("a");
    fs::create_dir_all(s.store.path().parent().unwrap()).unwrap();
    let text = serde_json::json!({
        "version": 2,
        "future": { "x": 1 },
        "folders": {
            "/elsewhere": { "decision": "ask", "decidedAt": "2030-01-01T00:00:00Z", "note": "n" }
        }
    });
    fs::write(s.store.path(), text.to_string()).unwrap();
    s.store.decide(&a, TrustChoice::Trusted).unwrap();
    let raw = s.raw();
    assert_eq!(raw["version"], 1);
    assert_eq!(raw["future"], serde_json::json!({ "x": 1 }));
    assert_eq!(raw["folders"]["/elsewhere"]["decision"], "ask");
    assert_eq!(raw["folders"]["/elsewhere"]["note"], "n");
    // An unknown decision never trusts anything.
    assert_eq!(
        resolve(&s.store.load(), "/elsewhere/sub").choice,
        None,
        "unknown decisions are read as undecided"
    );
}

#[cfg(unix)]
#[test]
fn a_failed_atomic_write_leaves_the_old_file_intact() {
    use std::os::unix::fs::PermissionsExt;
    let s = sandbox();
    let a = s.folder("a");
    let b = s.folder("b");
    s.store.decide(&a, TrustChoice::Trusted).unwrap();
    let before = fs::read(s.store.path()).unwrap();
    let profile = s.store.path().parent().unwrap().to_path_buf();
    // The lock file exists already; forbid creating the temp file.
    fs::set_permissions(&profile, fs::Permissions::from_mode(0o555)).unwrap();
    let result = s.store.decide(&b, TrustChoice::Trusted);
    fs::set_permissions(&profile, fs::Permissions::from_mode(0o755)).unwrap();
    if std::env::var("USER").is_ok_and(|u| u == "root") {
        return; // root ignores directory permissions
    }
    assert!(result.is_err());
    assert_eq!(fs::read(s.store.path()).unwrap(), before);
    let stray = fs::read_dir(&profile)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".span-"))
        .count();
    assert_eq!(stray, 0, "no temp file left behind");
}

#[test]
fn parent_scope_refuses_roots_home_and_shallow_parents() {
    let s = sandbox();
    let home = s.folder("home/me");
    let project = s.folder("home/me/proj");
    let nested = s.folder("home/me/code/proj");
    // The parent is the home directory itself.
    assert!(parent_for(&project, Some(&home)).is_err());
    // A deeper parent is fine.
    assert_eq!(
        key_for(&parent_for(&nested, Some(&home)).unwrap()),
        key_for(&home.join("code"))
    );
    // A filesystem root and a single component parent are refused.
    let root = Path::new(&key_for(&project))
        .ancestors()
        .last()
        .unwrap()
        .to_path_buf();
    assert!(parent_for(&root, None).is_err());
    let top = root.join("onlyone");
    assert!(parent_for(&top.join("proj"), None).is_err());
    assert!(parent_for(&top, None).is_err());
}
