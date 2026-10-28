use super::*;

#[test]
fn trust_reasons_follow_the_build_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    assert!(trust_reason(ServerId::Jdtls, root).is_none());
    assert!(trust_reason(ServerId::RustAnalyzer, root).is_none());
    std::fs::write(root.join("build.gradle.kts"), "").unwrap();
    assert!(trust_reason(ServerId::Jdtls, root)
        .unwrap()
        .contains("Gradle"));
    std::fs::write(root.join("pom.xml"), "").unwrap();
    assert!(trust_reason(ServerId::Jdtls, root)
        .unwrap()
        .contains("Maven"));
    assert!(trust_reason(ServerId::Json, root).is_none());

    // A Cargo manifest without dependencies or build scripts does not need trust.
    std::fs::write(
        root.join("Cargo.toml"),
        "[package]\nname = \"x\"\n\n[dependencies]\n# none\n",
    )
    .unwrap();
    assert!(trust_reason(ServerId::RustAnalyzer, root).is_none());
    std::fs::write(
        root.join("Cargo.toml"),
        "[package]\nname = \"x\"\n[dependencies]\nserde = \"1\"\n",
    )
    .unwrap();
    assert!(trust_reason(ServerId::RustAnalyzer, root)
        .unwrap()
        .contains("Cargo"));
    std::fs::write(root.join("Cargo.toml"), "[package]\nname = \"x\"\n").unwrap();
    std::fs::write(root.join("build.rs"), "fn main() {}").unwrap();
    assert!(trust_reason(ServerId::RustAnalyzer, root).is_some());
}

#[test]
fn build_files_are_listed_by_the_one_detection() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    assert!(workspace_build_files(root).is_empty());
    assert!(workspace_trust_reason(root).is_none());
    std::fs::write(root.join("pom.xml"), "").unwrap();
    std::fs::write(root.join("build.gradle"), "").unwrap();
    std::fs::write(
        root.join("Cargo.toml"),
        "[package]\nname = \"x\"\n[dependencies]\nserde = \"1\"\n",
    )
    .unwrap();
    std::fs::write(root.join("build.rs"), "fn main() {}").unwrap();
    assert_eq!(
        workspace_build_files(root),
        vec!["pom.xml", "build.gradle", "Cargo.toml", "build.rs"]
    );
    assert!(workspace_trust_reason(root).unwrap().contains("Maven"));
}

#[test]
fn work_reports_are_throttled_but_begin_and_end_always_pass() {
    let mut w = WorkTracker::default();
    let root = Path::new("/w");
    let report = |kind, token: &str, title: Option<&str>, pct| WorkProgress {
        token: token.into(),
        kind,
        title: title.map(str::to_owned),
        message: None,
        percentage: pct,
    };
    let call = |w: &mut WorkTracker, kind, pct| {
        w.apply(
            ServerId::Jdtls,
            root,
            report(kind, "t", Some("Importing"), pct),
        )
    };
    assert!(call(&mut w, WorkProgressKind::Begin, Some(0)).is_some());
    let passed = (1..=50)
        .filter(|i| call(&mut w, WorkProgressKind::Report, Some(*i)).is_some())
        .count();
    assert!(passed <= 1, "{passed}");
    assert_eq!(w.activity(ServerId::Jdtls, root)[0].percentage, Some(50));
    // Another token is throttled on its own.
    assert!(w
        .apply(
            ServerId::Jdtls,
            root,
            report(WorkProgressKind::Begin, "u", None, None)
        )
        .is_some());
    assert_eq!(w.activity(ServerId::Jdtls, root).len(), 2);
    let end = call(&mut w, WorkProgressKind::End, None).unwrap();
    assert_eq!(end.kind, WorkProgressKindDto::End);
    assert_eq!(w.activity(ServerId::Jdtls, root).len(), 1);
    w.clear(ServerId::Jdtls, root);
    assert!(w.activity(ServerId::Jdtls, root).is_empty());
}

#[test]
fn failures_get_plain_language_and_keep_the_technical_error() {
    let (plain, details) = failure(&LanguageServerStateDto::StartFailed {
        reason: "spawn ENOENT".into(),
    })
    .unwrap();
    assert!(!plain.contains("ENOENT") && details == "spawn ENOENT");
    let (plain, _) = failure(&LanguageServerStateDto::RuntimeMissing {
        runtime: "java".into(),
        required_version: 25,
        found: vec!["21".into()],
    })
    .unwrap();
    assert!(plain.contains("JDK") && plain.contains("25") && plain.contains("21"));
    assert!(failure(&LanguageServerStateDto::Ready).is_none());
}

#[test]
fn directory_sizes_add_up_without_following_links() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("a/b")).unwrap();
    std::fs::write(dir.path().join("a/x"), vec![0u8; 100]).unwrap();
    std::fs::write(dir.path().join("a/b/y"), vec![0u8; 20]).unwrap();
    assert_eq!(dir_size(dir.path()), 120);
    assert_eq!(dir_size(&dir.path().join("missing")), 0);
}
