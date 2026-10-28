use super::safety::{classify_path, collisions, folder_name_for, is_hidden_clutter};
use super::*;
use crate::search::CancellationToken;
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use zip::write::SimpleFileOptions;

// ---------- fixtures ----------

fn deflated() -> SimpleFileOptions {
    SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)
}

fn stored() -> SimpleFileOptions {
    SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)
}

fn zip_with(entries: &[(&str, &[u8])], options: SimpleFileOptions) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, data) in entries {
        if name.ends_with('/') {
            writer.add_directory(*name, options).unwrap();
        } else {
            writer.start_file(*name, options).unwrap();
            writer.write_all(data).unwrap();
        }
    }
    writer.finish().unwrap().into_inner()
}

fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
    zip_with(entries, deflated())
}

/// Patch the central and local headers of entry `name`. `f(header, offset, central)`.
fn patch_zip(bytes: &mut [u8], name: &str, f: impl Fn(&mut [u8], usize, bool)) {
    let mut hits = 0;
    for i in 0..bytes.len().saturating_sub(46) {
        if bytes[i..].starts_with(b"PK\x01\x02") {
            let len = u16::from_le_bytes([bytes[i + 28], bytes[i + 29]]) as usize;
            if &bytes[i + 46..i + 46 + len] == name.as_bytes() {
                f(bytes, i, true);
                hits += 1;
            }
        } else if bytes[i..].starts_with(b"PK\x03\x04") {
            let len = u16::from_le_bytes([bytes[i + 26], bytes[i + 27]]) as usize;
            if bytes.len() >= i + 30 + len && &bytes[i + 30..i + 30 + len] == name.as_bytes() {
                f(bytes, i, false);
                hits += 1;
            }
        }
    }
    assert_eq!(hits, 2, "patched both headers of {name}");
}

fn set_u16(bytes: &mut [u8], at: usize, value: u16) {
    bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
}

fn set_u32(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

struct TarItem<'a> {
    name: &'a str,
    kind: tar::EntryType,
    data: &'a [u8],
    link: &'a str,
    mode: u32,
}

fn file<'a>(name: &'a str, data: &'a [u8]) -> TarItem<'a> {
    TarItem {
        name,
        kind: tar::EntryType::Regular,
        data,
        link: "",
        mode: 0o644,
    }
}

fn special<'a>(name: &'a str, kind: tar::EntryType, link: &'a str) -> TarItem<'a> {
    TarItem {
        name,
        kind,
        data: b"",
        link,
        mode: 0o644,
    }
}

/// Raw header names, so hostile paths the tar builder would refuse can be written.
fn tar_of(items: &[TarItem<'_>]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for item in items {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(item.kind);
        header.set_size(item.data.len() as u64);
        header.set_mode(item.mode);
        header.set_mtime(1_700_000_000);
        let old = header.as_old_mut();
        old.name = [0; 100];
        old.name[..item.name.len()].copy_from_slice(item.name.as_bytes());
        old.linkname = [0; 100];
        old.linkname[..item.link.len()].copy_from_slice(item.link.as_bytes());
        header.set_cksum();
        builder.append(&header, item.data).unwrap();
    }
    builder.into_inner().unwrap()
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

fn src(name: &str, bytes: Vec<u8>) -> ArchiveSource {
    ArchiveSource::from_bytes(name, bytes)
}

fn list(name: &str, bytes: Vec<u8>) -> ArchiveListing {
    open_archive(&src(name, bytes)).unwrap()
}

fn reason_of(listing: &ArchiveListing, path: &str) -> Option<UnsafeReason> {
    listing
        .entries
        .iter()
        .find(|e| e.path == path)
        .unwrap_or_else(|| panic!("no entry {path:?} in {:?}", listing.entries))
        .unsafe_reason
}

fn workspace() -> (tempfile::TempDir, ExtractContext) {
    let dir = tempfile::tempdir().unwrap();
    let ws = CoreWorkspace::open(dir.path()).unwrap();
    let ctx = ws.extract_context();
    (dir, ctx)
}

fn options(conflict: ConflictMode) -> ExtractOptions {
    ExtractOptions {
        selection: None,
        destination: String::new(),
        keep_structure: true,
        skip_hidden: false,
        conflict,
        into_new_folder: false,
        decisions: None,
    }
}

fn run(source: &ArchiveSource, options: &ExtractOptions, ctx: &ExtractContext) -> ExtractReport {
    extract(
        source,
        options,
        ctx,
        &ArchiveLimits::default(),
        &CancellationToken::default(),
        &mut |_| {},
    )
    .unwrap()
}

/// Every file under `root`, relative, sorted. Fails the test if a temp file is left.
fn tree(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    fn walk_dir(base: &Path, dir: &Path, out: &mut Vec<String>) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let rel = path
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            assert!(!rel.contains(".archive.span-"), "temp file left: {rel}");
            let ft = entry.file_type().unwrap();
            if ft.is_dir() {
                out.push(format!("{rel}/"));
                walk_dir(base, &path, out);
            } else {
                out.push(rel);
            }
        }
    }
    walk_dir(root, root, &mut out);
    out.sort();
    out
}

// ---------- safety table (pure, every platform) ----------

#[test]
fn safety_table() {
    use UnsafeReason::*;
    let cases: &[(&str, Result<&str, UnsafeReason>)] = &[
        ("a/b.txt", Ok("a/b.txt")),
        ("./a//b/", Ok("a/b")),
        ("dir\\file.txt", Ok("dir/file.txt")),
        ("données/日本語.txt", Ok("données/日本語.txt")),
        (".gitignore", Ok(".gitignore")),
        ("console.txt", Ok("console.txt")),
        ("com10.txt", Ok("com10.txt")),
        ("", Err(Empty)),
        ("./", Err(Empty)),
        ("/etc/passwd", Err(Absolute)),
        ("\\Windows\\system.ini", Err(Absolute)),
        ("C:\\Windows\\x", Err(DrivePrefix)),
        ("c:x", Err(DrivePrefix)),
        ("Z:/x", Err(DrivePrefix)),
        ("\\\\server\\share\\x", Err(UncPrefix)),
        ("//server/share/x", Err(UncPrefix)),
        ("\\\\?\\C:\\x", Err(UncPrefix)),
        ("../evil", Err(ParentTraversal)),
        ("a/../../evil", Err(ParentTraversal)),
        ("..\\..\\evil.txt", Err(ParentTraversal)),
        ("a\\..\\..\\b", Err(ParentTraversal)),
        ("a/..", Err(ParentTraversal)),
        ("nul\0byte", Err(ControlCharacter)),
        ("tab\tname", Err(ControlCharacter)),
        ("new\nline", Err(ControlCharacter)),
        ("esc\u{1b}[31m", Err(ControlCharacter)),
        ("a:b", Err(DrivePrefix)),
        ("ab:c", Err(InvalidCharacter)),
        ("file.txt:stream", Err(InvalidCharacter)),
        ("what?.txt", Err(InvalidCharacter)),
        ("a/b*", Err(InvalidCharacter)),
        ("trail.", Err(TrailingDotOrSpace)),
        ("dir./x", Err(TrailingDotOrSpace)),
        ("trail ", Err(TrailingDotOrSpace)),
        ("CON", Err(ReservedName)),
        ("con.txt", Err(ReservedName)),
        ("a/aux.tar.gz", Err(ReservedName)),
        ("LPT9", Err(ReservedName)),
        ("com1/x", Err(ReservedName)),
        (".git/config", Err(ProtectedDirectory)),
        ("src/.GIT/hooks/pre-commit", Err(ProtectedDirectory)),
        ("node_modules/x.js", Err(ProtectedDirectory)),
        ("a/.span/settings.jsonc", Err(ProtectedDirectory)),
    ];
    for (raw, expected) in cases {
        let got = classify_path(raw).map(|p| p.joined());
        assert_eq!(got, expected.map(str::to_owned), "classify_path({raw:?})");
    }
    let long_component = "a".repeat(256);
    assert_eq!(classify_path(&long_component), Err(NameTooLong));
    let long_path = "a/".repeat(2049);
    assert_eq!(classify_path(&long_path), Err(NameTooLong));
}

#[test]
fn hidden_clutter_rule() {
    let parts = |s: &str| s.split('/').map(str::to_owned).collect::<Vec<_>>();
    for hidden in [
        ".DS_Store",
        "a/.ds_store",
        "Thumbs.db",
        "__MACOSX/a.txt",
        "x/__macosx/y",
        "a/._b.txt",
    ] {
        assert!(is_hidden_clutter(&parts(hidden)), "{hidden}");
    }
    for visible in [".env", "a/b.txt", "DS_Store", "_a", "x/.hidden"] {
        assert!(!is_hidden_clutter(&parts(visible)), "{visible}");
    }
}

#[test]
fn collision_rule() {
    let p = |s: &str| classify_path(s).unwrap();
    let paths = [
        p("README.md"),
        p("readme.md"),
        p("a/x"),
        p("A/y"),
        p("dir"),
        p("dir/inner"),
        p("dup"),
        p("dup"),
        p("folder"),
        p("FOLDER"),
    ];
    let input: Vec<_> = paths
        .iter()
        .enumerate()
        .map(|(i, path)| (i, path, i >= 8))
        .collect();
    let hit = collisions(&input);
    let expected: HashSet<usize> = [0, 1, 4, 5, 6, 7].into_iter().collect();
    assert_eq!(hit, expected);
}

#[test]
fn new_folder_names() {
    assert_eq!(folder_name_for("bundle.zip"), "bundle");
    assert_eq!(folder_name_for("x/release.TAR.GZ"), "release");
    assert_eq!(folder_name_for("logs.tgz"), "logs");
    assert_eq!(folder_name_for("plain"), "plain");
    assert_eq!(folder_name_for(".zip"), ".zip");
    assert_eq!(folder_name_for("con.zip"), "archive");
    assert_eq!(folder_name_for("..zip"), "archive");
    assert_eq!(folder_name_for("a:b?.zip"), "a_b_");
}

// ---------- listing ----------

#[test]
fn lists_a_normal_zip_tree() {
    let time = zip::DateTime::from_date_and_time(2024, 5, 6, 7, 8, 10).unwrap();
    let opts = deflated().last_modified_time(time);
    let bytes = zip_with(
        &[
            ("src/", b""),
            ("src/main.rs", b"fn main() {}\n"),
            ("src/lib/mod.rs", &[b'x'; 4000]),
            ("README.md", b"# hi\n"),
        ],
        opts,
    );
    let listing = list("t.zip", bytes);
    assert_eq!(listing.format, ArchiveFormat::Zip);
    assert_eq!(listing.compression, "Deflate");
    assert!(!listing.truncated);
    assert_eq!(listing.entries.len(), 4);
    assert!(listing.entries.iter().all(|e| e.unsafe_reason.is_none()));
    assert_eq!(listing.totals.files, 3);
    assert_eq!(listing.totals.folders, 2, "src and src/lib");
    assert_eq!(listing.totals.unpacked_bytes, 13 + 4000 + 5);
    assert!(listing.totals.packed_bytes < listing.totals.unpacked_bytes);
    let main = listing
        .entries
        .iter()
        .find(|e| e.path == "src/main.rs")
        .unwrap();
    assert_eq!(main.modified_ms, Some(1_714_979_290_000));
    assert!(main.packed_size.is_some());
    let dir = listing.entries.iter().find(|e| e.path == "src").unwrap();
    assert!(dir.is_dir);
}

#[test]
fn flags_traversal_absolute_drive_unc_and_backslash_entries_in_zip() {
    let bytes = zip_of(&[
        ("ok.txt", b"1"),
        ("../evil.txt", b"x"),
        ("/etc/passwd", b"x"),
        ("C:\\Windows\\evil.dll", b"x"),
        ("\\\\server\\share\\evil", b"x"),
        ("..\\..\\evil.bat", b"x"),
        ("dir\\nested.txt", b"ok"),
    ]);
    let listing = list("t.zip", bytes);
    assert_eq!(reason_of(&listing, "ok.txt"), None);
    assert_eq!(reason_of(&listing, "dir/nested.txt"), None);
    assert_eq!(
        reason_of(&listing, "../evil.txt"),
        Some(UnsafeReason::ParentTraversal)
    );
    assert_eq!(
        reason_of(&listing, "/etc/passwd"),
        Some(UnsafeReason::Absolute)
    );
    assert_eq!(
        reason_of(&listing, "C:\\Windows\\evil.dll"),
        Some(UnsafeReason::DrivePrefix)
    );
    assert_eq!(
        reason_of(&listing, "\\\\server\\share\\evil"),
        Some(UnsafeReason::UncPrefix)
    );
    assert_eq!(
        reason_of(&listing, "..\\..\\evil.bat"),
        Some(UnsafeReason::ParentTraversal)
    );
    assert_eq!(listing.totals.unsafe_entries, 5);
    assert_eq!(listing.totals.outside_entries, 5);
}

#[test]
fn flags_hostile_tar_entries_and_links() {
    let bytes = tar_of(&[
        file("good/a.txt", b"a"),
        file("../up.txt", b"x"),
        file("/abs.txt", b"x"),
        file("C:/drive.txt", b"x"),
        file("\\\\host\\share\\unc.txt", b"x"),
        special("link", tar::EntryType::Symlink, "/etc/passwd"),
        special("hard", tar::EntryType::Link, "good/a.txt"),
        special("pipe", tar::EntryType::Fifo, ""),
        special("dev", tar::EntryType::Char, ""),
    ]);
    let listing = list("t.tar", bytes);
    assert_eq!(listing.format, ArchiveFormat::Tar);
    assert_eq!(reason_of(&listing, "good/a.txt"), None);
    assert_eq!(
        reason_of(&listing, "../up.txt"),
        Some(UnsafeReason::ParentTraversal)
    );
    assert_eq!(
        reason_of(&listing, "/abs.txt"),
        Some(UnsafeReason::Absolute)
    );
    assert_eq!(
        reason_of(&listing, "C:/drive.txt"),
        Some(UnsafeReason::DrivePrefix)
    );
    assert_eq!(
        reason_of(&listing, "\\\\host\\share\\unc.txt"),
        Some(UnsafeReason::UncPrefix)
    );
    assert_eq!(reason_of(&listing, "link"), Some(UnsafeReason::Symlink));
    assert!(listing
        .entries
        .iter()
        .any(|e| e.path == "link" && e.is_symlink));
    assert_eq!(reason_of(&listing, "hard"), Some(UnsafeReason::Hardlink));
    assert_eq!(reason_of(&listing, "pipe"), Some(UnsafeReason::SpecialFile));
    assert_eq!(reason_of(&listing, "dev"), Some(UnsafeReason::SpecialFile));
    assert_eq!(listing.totals.outside_entries, 6);
    assert_eq!(listing.totals.unsafe_entries, 8);
}

#[test]
fn flags_zip_symlinks() {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    writer.start_file("a.txt", deflated()).unwrap();
    writer.write_all(b"a").unwrap();
    writer
        .add_symlink("escape", "../../etc/passwd", deflated())
        .unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    let listing = list("t.zip", bytes);
    assert_eq!(reason_of(&listing, "escape"), Some(UnsafeReason::Symlink));
    assert_eq!(reason_of(&listing, "a.txt"), None);
}

#[test]
fn flags_case_collisions_duplicates_and_file_folder_clashes() {
    let listing = list(
        "t.zip",
        zip_of(&[
            ("README.md", b"1"),
            ("readme.md", b"2"),
            ("x", b"file"),
            ("x/inner.txt", b"needs x as a folder"),
            ("Docs/", b""),
            ("docs/", b""),
            ("unique.txt", b"ok"),
        ]),
    );
    for path in ["README.md", "readme.md", "x", "x/inner.txt"] {
        assert_eq!(
            reason_of(&listing, path),
            Some(UnsafeReason::Collision),
            "{path}"
        );
    }
    assert_eq!(reason_of(&listing, "Docs"), None, "folders merge");
    assert_eq!(reason_of(&listing, "unique.txt"), None);
    let tar = list("t.tar", tar_of(&[file("same", b"1"), file("same", b"2")]));
    assert!(tar
        .entries
        .iter()
        .all(|e| e.unsafe_reason == Some(UnsafeReason::Collision)));
}

#[test]
fn flags_reserved_names_and_protected_directories() {
    let listing = list(
        "t.zip",
        zip_of(&[
            ("CON.txt", b"x"),
            ("aux", b"x"),
            ("trail.", b"x"),
            ("space ", b"x"),
            ("ab:c", b"x"),
            ("src/.git/config", b"x"),
            ("pkg/node_modules/x.js", b"x"),
            (".span/settings.jsonc", b"x"),
            ("fine.txt", b"x"),
        ]),
    );
    assert_eq!(
        reason_of(&listing, "CON.txt"),
        Some(UnsafeReason::ReservedName)
    );
    assert_eq!(reason_of(&listing, "aux"), Some(UnsafeReason::ReservedName));
    assert_eq!(
        reason_of(&listing, "trail."),
        Some(UnsafeReason::TrailingDotOrSpace)
    );
    assert_eq!(
        reason_of(&listing, "space "),
        Some(UnsafeReason::TrailingDotOrSpace)
    );
    assert_eq!(
        reason_of(&listing, "ab:c"),
        Some(UnsafeReason::InvalidCharacter)
    );
    for p in [
        "src/.git/config",
        "pkg/node_modules/x.js",
        ".span/settings.jsonc",
    ] {
        assert_eq!(
            reason_of(&listing, p),
            Some(UnsafeReason::ProtectedDirectory)
        );
    }
    assert_eq!(reason_of(&listing, "fine.txt"), None);
    assert_eq!(listing.totals.outside_entries, 0);
}

#[test]
fn control_characters_are_shown_replaced() {
    let listing = list("t.tar", tar_of(&[file("bad\u{1b}name", b"x")]));
    assert_eq!(listing.entries[0].path, "bad\u{FFFD}name");
    assert_eq!(
        listing.entries[0].unsafe_reason,
        Some(UnsafeReason::ControlCharacter)
    );
}

#[test]
fn ratio_bomb_is_flagged_by_header_and_skipped() {
    // 8 MiB of zeros deflates to a few KiB: far beyond the 250:1 cap.
    let zeros = vec![0u8; 8 * 1024 * 1024];
    let bytes = zip_of(&[("bomb.bin", &zeros), ("ok.txt", b"fine")]);
    assert!(bytes.len() < 64 * 1024);
    let source = src("bomb.zip", bytes);
    let listing = open_archive(&source).unwrap();
    assert_eq!(
        reason_of(&listing, "bomb.bin"),
        Some(UnsafeReason::CompressionRatio)
    );
    let (dir, ctx) = workspace();
    let report = run(&source, &options(ConflictMode::Skip), &ctx);
    assert_eq!(tree(dir.path()), vec!["ok.txt"]);
    assert!(report.skipped.iter().any(|s| s.entry == "bomb.bin"
        && s.reason
            == SkipReason::Unsafe {
                reason: UnsafeReason::CompressionRatio
            }));
}

#[test]
fn lying_header_trips_the_streaming_guard() {
    // The headers claim 1000 bytes, so the header check passes; the stream holds 8 MiB.
    let zeros = vec![0u8; 8 * 1024 * 1024];
    let mut bytes = zip_of(&[("liar.bin", &zeros), ("after.txt", b"ok")]);
    patch_zip(&mut bytes, "liar.bin", |b, at, central| {
        set_u32(b, at + if central { 24 } else { 22 }, 1000);
    });
    let source = src("liar.zip", bytes);
    let listing = open_archive(&source).unwrap();
    assert_eq!(reason_of(&listing, "liar.bin"), None);
    let mut peak = 0u64;
    let (dir, ctx) = workspace();
    let report = extract(
        &source,
        &options(ConflictMode::Skip),
        &ctx,
        &ArchiveLimits::default(),
        &CancellationToken::default(),
        &mut |p| peak = peak.max(p.bytes_done),
    )
    .unwrap();
    assert!(
        report.errors.iter().any(|e| e.entry == "liar.bin"),
        "{report:?}"
    );
    assert!(
        peak < 1024 * 1024,
        "stopped within the first chunks: {peak}"
    );
    assert_eq!(tree(dir.path()), vec!["after.txt"]);
}

#[test]
fn entry_count_cap_truncates_listing_and_refuses_extraction() {
    let names: Vec<String> = (0..12).map(|i| format!("f{i}.txt")).collect();
    let entries: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), &b""[..])).collect();
    let source = src("many.zip", zip_with(&entries, stored()));
    let limits = ArchiveLimits {
        max_entries: 10,
        ..ArchiveLimits::default()
    };
    let listing = list_archive(&source, &limits).unwrap();
    assert!(listing.truncated);
    assert_eq!(listing.entries.len(), 10);
    let (_dir, ctx) = workspace();
    let error = plan_extract(&source, &options(ConflictMode::Skip), &ctx, &limits).unwrap_err();
    assert_eq!(error.kind, ArchiveErrorKind::TooLarge);
    let tar_source = src(
        "many.tar",
        tar_of(&names.iter().map(|n| file(n, b"")).collect::<Vec<_>>()),
    );
    assert!(list_archive(&tar_source, &limits).unwrap().truncated);
}

#[test]
fn default_entry_cap_is_fifty_thousand() {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for i in 0..50_001 {
        writer.start_file(format!("{i}"), stored()).unwrap();
    }
    let source = src("huge.zip", writer.finish().unwrap().into_inner());
    let listing = open_archive(&source).unwrap();
    assert!(listing.truncated);
    assert_eq!(listing.entries.len(), 50_000);
}

#[test]
fn listing_byte_cap_truncates() {
    let names: Vec<String> = (0..20).map(|i| format!("{i:0>50}")).collect();
    let entries: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), &b""[..])).collect();
    let limits = ArchiveLimits {
        max_listing_bytes: 500,
        ..ArchiveLimits::default()
    };
    let listing = list_archive(&src("t.zip", zip_with(&entries, stored())), &limits).unwrap();
    assert!(listing.truncated);
    assert_eq!(listing.entries.len(), 10);
}

#[test]
fn encrypted_entries_are_reported_never_decrypted() {
    let mut bytes = zip_of(&[("secret.txt", b"hidden"), ("open.txt", b"plain")]);
    patch_zip(&mut bytes, "secret.txt", |b, at, central| {
        let flags = at + if central { 8 } else { 6 };
        let value = u16::from_le_bytes([b[flags], b[flags + 1]]) | 1;
        set_u16(b, flags, value);
    });
    let source = src("locked.zip", bytes);
    let listing = open_archive(&source).unwrap();
    assert_eq!(
        reason_of(&listing, "secret.txt"),
        Some(UnsafeReason::Encrypted)
    );
    assert_eq!(reason_of(&listing, "open.txt"), None);
    let error =
        read_archive_entry(&source, "secret.txt", 0, 10, &ArchiveLimits::default()).unwrap_err();
    assert_eq!(error.kind, ArchiveErrorKind::PasswordProtected);
    let (dir, ctx) = workspace();
    run(&source, &options(ConflictMode::Skip), &ctx);
    assert_eq!(tree(dir.path()), vec!["open.txt"]);
}

#[test]
fn unsupported_method_is_reported() {
    let mut bytes = zip_of(&[("lzma.bin", b"data"), ("ok.txt", b"ok")]);
    patch_zip(&mut bytes, "lzma.bin", |b, at, central| {
        set_u16(b, at + if central { 10 } else { 8 }, 14);
    });
    let source = src("m.zip", bytes);
    let listing = open_archive(&source).unwrap();
    assert_eq!(
        reason_of(&listing, "lzma.bin"),
        Some(UnsafeReason::UnsupportedMethod)
    );
    let error =
        read_archive_entry(&source, "lzma.bin", 0, 4, &ArchiveLimits::default()).unwrap_err();
    assert_eq!(error.kind, ArchiveErrorKind::UnsupportedMethod);
}

#[test]
fn corrupt_central_directory_is_damaged() {
    let mut bytes = zip_of(&[("a.txt", b"hello"), ("b.txt", b"world")]);
    let at = bytes.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
    bytes[at..at + 4].copy_from_slice(b"JUNK");
    let error = open_archive(&src("bad.zip", bytes)).unwrap_err();
    assert_eq!(error.kind, ArchiveErrorKind::Damaged, "{error}");
}

#[test]
fn zip_without_end_record_is_damaged() {
    let bytes = zip_of(&[("a.txt", b"hello")]);
    let cut = bytes.len() - 30;
    let error = open_archive(&src("cut.zip", bytes[..cut].to_vec())).unwrap_err();
    assert_eq!(error.kind, ArchiveErrorKind::Damaged, "{error}");
}

#[test]
fn truncated_tar_and_tgz_are_damaged() {
    let data = vec![b'x'; 4096];
    let full = tar_of(&[file("a.bin", &data), file("b.bin", &data)]);
    let cut = full[..512 + 2048].to_vec();
    let error = open_archive(&src("cut.tar", cut.clone())).unwrap_err();
    assert_eq!(error.kind, ArchiveErrorKind::Damaged, "{error}");
    let gz = gzip(&full);
    let error = open_archive(&src("cut.tgz", gz[..gz.len() / 2].to_vec())).unwrap_err();
    assert_eq!(error.kind, ArchiveErrorKind::Damaged, "{error:?}");
    let mut bad = full.clone();
    bad[148..156].copy_from_slice(b"0000000\0");
    let error = open_archive(&src("badsum.tar", bad)).unwrap_err();
    assert_eq!(error.kind, ArchiveErrorKind::Damaged, "{error:?}");
}

#[test]
fn tgz_lists_and_extracts() {
    let bytes = gzip(&tar_of(&[
        special("pkg/", tar::EntryType::Directory, ""),
        file("pkg/a.txt", b"alpha"),
        file("pkg/b/c.txt", b"gamma"),
    ]));
    let source = src("pkg.tar.gz", bytes);
    let listing = open_archive(&source).unwrap();
    assert_eq!(listing.format, ArchiveFormat::TarGz);
    assert_eq!(listing.compression, "Gzip");
    assert_eq!(listing.totals.files, 2);
    let (dir, ctx) = workspace();
    let report = run(&source, &options(ConflictMode::Skip), &ctx);
    assert_eq!(report.written.len(), 2);
    assert_eq!(
        tree(dir.path()),
        vec!["pkg/", "pkg/a.txt", "pkg/b/", "pkg/b/c.txt"]
    );
    assert_eq!(fs::read(dir.path().join("pkg/b/c.txt")).unwrap(), b"gamma");
}

#[test]
fn gzip_bomb_stops_while_listing() {
    // 64 MiB of zeros in a tar inside gzip; the whole-stream ratio cap trips early.
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    let mut header = tar::Header::new_gnu();
    header.set_path("zeros.bin").unwrap();
    header.set_size(64 * 1024 * 1024);
    header.set_cksum();
    encoder.write_all(header.as_bytes()).unwrap();
    let chunk = vec![0u8; 1024 * 1024];
    for _ in 0..64 {
        encoder.write_all(&chunk).unwrap();
    }
    let bytes = encoder.finish().unwrap();
    let error = open_archive(&src("bomb.tgz", bytes)).unwrap_err();
    assert_eq!(error.kind, ArchiveErrorKind::TooLarge, "{error}");
}

#[test]
fn empty_archives_and_non_archives() {
    let empty_zip = zip_of(&[]);
    let listing = list("e.zip", empty_zip);
    assert!(listing.entries.is_empty());
    assert_eq!(listing.totals.files, 0);
    let listing = list("e.tar", vec![0u8; 1024]);
    assert_eq!(listing.format, ArchiveFormat::Tar);
    assert!(listing.entries.is_empty());
    for (name, bytes) in [
        ("zero.zip", Vec::new()),
        ("notes.txt", b"just text, not an archive".to_vec()),
        ("fake.zip", b"hello world".to_vec()),
    ] {
        let error = open_archive(&src(name, bytes)).unwrap_err();
        assert_eq!(error.kind, ArchiveErrorKind::NotAnArchive, "{name}");
    }
}

#[test]
fn unicode_names_round_trip() {
    let source = src(
        "u.zip",
        zip_of(&[
            ("données/日本語.txt", "héllo".as_bytes()),
            ("emoji 🎉.md", b"x"),
        ]),
    );
    let listing = open_archive(&source).unwrap();
    assert_eq!(reason_of(&listing, "données/日本語.txt"), None);
    let (dir, ctx) = workspace();
    run(&source, &options(ConflictMode::Skip), &ctx);
    assert_eq!(
        fs::read_to_string(dir.path().join("données/日本語.txt")).unwrap(),
        "héllo"
    );
    assert!(dir.path().join("emoji 🎉.md").is_file());
}

#[test]
fn reads_bounded_entry_chunks() {
    let data: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
    let source = src(
        "r.zip",
        zip_of(&[("dir/data.bin", &data), ("../evil", b"e")]),
    );
    let limits = ArchiveLimits::default();
    let chunk = read_archive_entry(&source, "dir/data.bin", 100, 50, &limits).unwrap();
    assert_eq!(chunk.data, &data[100..150]);
    assert_eq!(chunk.entry_size, 10_000);
    assert!(!chunk.eof);
    let tail = read_archive_entry(&source, "dir/data.bin", 9_990, 100, &limits).unwrap();
    assert_eq!(tail.data, &data[9_990..]);
    assert!(tail.eof);
    // Unsafe entries can be previewed (never written).
    let evil = read_archive_entry(&source, "../evil", 0, 10, &limits).unwrap();
    assert_eq!(evil.data, b"e");
    let too_long = read_archive_entry(&source, "dir/data.bin", 0, limits.max_read_len + 1, &limits);
    assert_eq!(too_long.unwrap_err().kind, ArchiveErrorKind::TooLarge);
    let missing = read_archive_entry(&source, "nope", 0, 1, &limits);
    assert_eq!(missing.unwrap_err().kind, ArchiveErrorKind::EntryNotFound);
    let tar = src("r.tar", tar_of(&[file("t.txt", b"tar data")]));
    assert_eq!(
        read_archive_entry(&tar, "t.txt", 4, 100, &limits)
            .unwrap()
            .data,
        b"data"
    );
}

// ---------- extraction ----------

fn sample() -> ArchiveSource {
    src(
        "bundle.zip",
        zip_of(&[
            ("docs/", b""),
            ("docs/guide.md", b"guide"),
            ("src/a.txt", b"alpha"),
            ("src/deep/a.txt", b"deep alpha"),
            ("../escape.txt", b"no"),
            (".DS_Store", b"junk"),
            ("__MACOSX/src/._a.txt", b"junk"),
        ]),
    )
}

#[test]
fn keep_structure_on_writes_the_tree_and_reports_accurately() {
    let (dir, ctx) = workspace();
    let report = run(&sample(), &options(ConflictMode::Skip), &ctx);
    assert_eq!(
        tree(dir.path()),
        vec![
            ".DS_Store",
            "__MACOSX/",
            "__MACOSX/src/",
            "__MACOSX/src/._a.txt",
            "docs/",
            "docs/guide.md",
            "src/",
            "src/a.txt",
            "src/deep/",
            "src/deep/a.txt",
        ]
    );
    let written: Vec<_> = report.written.iter().map(|w| w.path.as_str()).collect();
    assert_eq!(
        written,
        vec![
            "docs/guide.md",
            "src/a.txt",
            "src/deep/a.txt",
            ".DS_Store",
            "__MACOSX/src/._a.txt"
        ]
    );
    assert_eq!(report.skipped.len(), 1);
    assert_eq!(report.skipped[0].entry, "../escape.txt");
    assert!(report.errors.is_empty() && report.conflicts.is_empty());
    assert!(!report.cancelled && !report.needs_decision);
    assert_eq!(report.folders_created, 5);
    assert!(!dir.path().parent().unwrap().join("escape.txt").exists());
}

#[test]
fn keep_structure_off_flattens_and_handles_duplicate_names() {
    let (dir, ctx) = workspace();
    let mut opts = options(ConflictMode::Skip);
    opts.keep_structure = false;
    opts.skip_hidden = true;
    let report = run(&sample(), &opts, &ctx);
    assert_eq!(tree(dir.path()), vec!["a.txt", "guide.md"]);
    assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"alpha");
    assert!(report
        .skipped
        .iter()
        .any(|s| s.entry == "src/deep/a.txt" && s.reason == SkipReason::DuplicateTarget));

    let (dir, ctx) = workspace();
    opts.conflict = ConflictMode::Rename;
    let report = run(&sample(), &opts, &ctx);
    assert_eq!(tree(dir.path()), vec!["a (1).txt", "a.txt", "guide.md"]);
    assert_eq!(
        fs::read(dir.path().join("a (1).txt")).unwrap(),
        b"deep alpha"
    );
    assert_eq!(report.written.len(), 3);
}

#[test]
fn skip_hidden_drops_os_clutter() {
    let (dir, ctx) = workspace();
    let mut opts = options(ConflictMode::Skip);
    opts.skip_hidden = true;
    let report = run(&sample(), &opts, &ctx);
    assert!(!dir.path().join(".DS_Store").exists());
    assert!(!dir.path().join("__MACOSX").exists());
    let hidden: Vec<_> = report
        .skipped
        .iter()
        .filter(|s| s.reason == SkipReason::Hidden)
        .map(|s| s.entry.as_str())
        .collect();
    assert_eq!(hidden, vec![".DS_Store", "__MACOSX/src/._a.txt"]);
}

#[test]
fn selection_extracts_only_the_chosen_entries() {
    let (dir, ctx) = workspace();
    let mut opts = options(ConflictMode::Skip);
    opts.selection = Some(vec!["src/".into(), "docs/guide.md".into()]);
    run(&sample(), &opts, &ctx);
    assert_eq!(
        tree(dir.path()),
        vec![
            "docs/",
            "docs/guide.md",
            "src/",
            "src/a.txt",
            "src/deep/",
            "src/deep/a.txt"
        ]
    );
}

fn conflict_source() -> ArchiveSource {
    src(
        "c.zip",
        zip_of(&[
            ("a.txt", b"new a"),
            ("b.txt", b"new b"),
            ("c.txt", b"new c"),
        ]),
    )
}

fn seed(dir: &Path) {
    fs::write(dir.join("a.txt"), b"old a").unwrap();
    fs::create_dir(dir.join("b.txt")).unwrap();
}

#[test]
fn conflict_skip_never_overwrites() {
    let (dir, ctx) = workspace();
    seed(dir.path());
    let report = run(&conflict_source(), &options(ConflictMode::Skip), &ctx);
    assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"old a");
    assert!(dir.path().join("b.txt").is_dir());
    assert_eq!(fs::read(dir.path().join("c.txt")).unwrap(), b"new c");
    assert_eq!(report.written.len(), 1);
    assert_eq!(report.conflicts.len(), 2);
    assert_eq!(
        report
            .skipped
            .iter()
            .filter(|s| s.reason == SkipReason::Exists)
            .count(),
        2
    );
}

#[test]
fn conflict_replace_replaces_files_but_never_folders() {
    let (dir, ctx) = workspace();
    seed(dir.path());
    let report = run(&conflict_source(), &options(ConflictMode::Replace), &ctx);
    assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"new a");
    assert!(dir.path().join("b.txt").is_dir(), "folder kept");
    assert!(report
        .written
        .iter()
        .any(|w| w.path == "a.txt" && w.replaced));
    assert!(report.errors.iter().any(|e| e.entry == "b.txt"));
    // A file where a folder is needed is not replaced either.
    let (dir, ctx) = workspace();
    fs::write(dir.path().join("src"), b"i am a file").unwrap();
    let report = run(
        &src("s.zip", zip_of(&[("src/x.txt", b"x")])),
        &options(ConflictMode::Replace),
        &ctx,
    );
    assert_eq!(fs::read(dir.path().join("src")).unwrap(), b"i am a file");
    assert_eq!(report.errors.len(), 1);
    assert!(report.written.is_empty());
}

#[test]
fn conflict_rename_numbers_new_files() {
    let (dir, ctx) = workspace();
    seed(dir.path());
    let report = run(&conflict_source(), &options(ConflictMode::Rename), &ctx);
    assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"old a");
    assert_eq!(fs::read(dir.path().join("a (1).txt")).unwrap(), b"new a");
    assert_eq!(fs::read(dir.path().join("b (1).txt")).unwrap(), b"new b");
    assert!(report.written.iter().filter(|w| w.renamed).count() == 2);
}

#[test]
fn conflict_ask_is_two_phase() {
    let (dir, ctx) = workspace();
    seed(dir.path());
    let source = conflict_source();
    let opts = options(ConflictMode::Ask);
    let plan = plan_extract(&source, &opts, &ctx, &ArchiveLimits::default()).unwrap();
    assert!(plan.needs_decision);
    assert_eq!(plan.files, 3);
    let targets: Vec<_> = plan
        .conflicts
        .iter()
        .map(|c| (c.target.as_str(), c.existing))
        .collect();
    assert_eq!(
        targets,
        vec![
            ("a.txt", ExistingKind::File),
            ("b.txt", ExistingKind::Folder)
        ]
    );
    // Without decisions nothing at all is written, not even the free c.txt.
    let report = run(&source, &opts, &ctx);
    assert!(report.needs_decision);
    assert!(report.written.is_empty());
    assert!(!dir.path().join("c.txt").exists());
    // With decisions the extraction proceeds.
    let mut decided = opts.clone();
    decided.decisions = Some(vec![
        ConflictDecision {
            target: "a.txt".into(),
            action: ConflictAction::Replace,
        },
        ConflictDecision {
            target: "b.txt".into(),
            action: ConflictAction::Rename,
        },
    ]);
    let plan = plan_extract(&source, &decided, &ctx, &ArchiveLimits::default()).unwrap();
    assert!(!plan.needs_decision);
    let report = run(&source, &decided, &ctx);
    assert!(!report.needs_decision);
    assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"new a");
    assert_eq!(fs::read(dir.path().join("b (1).txt")).unwrap(), b"new b");
    assert_eq!(fs::read(dir.path().join("c.txt")).unwrap(), b"new c");
}

#[test]
fn open_buffer_counts_as_taken() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = CoreWorkspace::open(dir.path()).unwrap();
    ws.open_buffer("a.txt").unwrap();
    let ctx = ws.extract_context();
    let report = run(&conflict_source(), &options(ConflictMode::Rename), &ctx);
    assert!(!dir.path().join("a.txt").exists());
    assert!(report.written.iter().any(|w| w.path == "a (1).txt"));
}

#[test]
fn into_new_folder_is_named_after_the_archive_and_numbered() {
    let (dir, ctx) = workspace();
    fs::create_dir(dir.path().join("out")).unwrap();
    fs::create_dir(dir.path().join("out/bundle")).unwrap();
    let mut opts = options(ConflictMode::Ask);
    opts.destination = "out".into();
    opts.into_new_folder = true;
    let plan = plan_extract(&sample(), &opts, &ctx, &ArchiveLimits::default()).unwrap();
    assert_eq!(plan.destination, "out/bundle (1)");
    let report = run(&sample(), &opts, &ctx);
    assert_eq!(report.destination, "out/bundle (1)");
    assert!(dir.path().join("out/bundle (1)/src/a.txt").is_file());
    assert!(report
        .written
        .iter()
        .all(|w| w.path.starts_with("out/bundle (1)/")));
}

#[test]
fn destination_is_validated() {
    let (dir, ctx) = workspace();
    for bad in ["../x", "/abs", ".git", "a/node_modules", "C:\\x", "a/../b"] {
        let mut opts = options(ConflictMode::Skip);
        opts.destination = bad.into();
        let error = plan_extract(&sample(), &opts, &ctx, &ArchiveLimits::default()).unwrap_err();
        assert_eq!(error.kind, ArchiveErrorKind::InvalidPath, "{bad}");
    }
    assert!(tree(dir.path()).is_empty());
}

#[test]
fn progress_is_monotonic_and_complete() {
    let big = vec![7u8; 3 * 1024 * 1024];
    let source = src(
        "p.zip",
        zip_with(
            &[("one.bin", &big), ("two.txt", b"two"), ("three/x", b"3")],
            stored(),
        ),
    );
    let (_dir, ctx) = workspace();
    let mut events: Vec<ExtractProgress> = Vec::new();
    let report = extract(
        &source,
        &options(ConflictMode::Skip),
        &ctx,
        &ArchiveLimits::default(),
        &CancellationToken::default(),
        &mut |p| events.push(p.clone()),
    )
    .unwrap();
    assert_eq!(report.written.len(), 3);
    assert!(events.len() > 4);
    for pair in events.windows(2) {
        assert!(pair[1].bytes_done >= pair[0].bytes_done);
        assert!(pair[1].files_done >= pair[0].files_done);
    }
    let last = events.last().unwrap();
    assert_eq!(last.files_done, 3);
    assert_eq!(last.files_total, 3);
    assert_eq!(last.bytes_done, last.bytes_total);
    assert_eq!(last.bytes_total, big.len() as u64 + 4);
    assert!(events
        .iter()
        .any(|e| e.current.as_deref() == Some("one.bin")));
}

#[test]
fn cancel_midway_leaves_no_partial_files() {
    let big = vec![9u8; 4 * 1024 * 1024];
    let source = src(
        "c.zip",
        zip_with(
            &[
                ("first.txt", b"done"),
                ("big.bin", &big),
                ("last.txt", b"never"),
            ],
            stored(),
        ),
    );
    let (dir, ctx) = workspace();
    let cancel = CancellationToken::default();
    let trigger = cancel.clone();
    let report = extract(
        &source,
        &options(ConflictMode::Skip),
        &ctx,
        &ArchiveLimits::default(),
        &cancel,
        &mut |p| {
            if p.current.as_deref() == Some("big.bin") && p.bytes_done > 1024 * 1024 {
                trigger.cancel();
            }
        },
    )
    .unwrap();
    assert!(report.cancelled);
    let written: Vec<_> = report.written.iter().map(|w| w.path.as_str()).collect();
    assert_eq!(written, vec!["first.txt"]);
    assert_eq!(tree(dir.path()), vec!["first.txt"]);
}

#[test]
fn total_cap_refuses_an_oversized_selection() {
    let data = vec![1u8; 300 * 1024];
    let source = src(
        "t.tar",
        tar_of(&[
            file("a.bin", &data),
            file("b.bin", &data),
            file("c.bin", &data),
        ]),
    );
    let (_dir, ctx) = workspace();
    // Header sizes over the total cap are refused before anything is written. The same
    // cap is counted again while streaming as a backstop.
    let limits = ArchiveLimits {
        max_total_bytes: 500 * 1024,
        ..ArchiveLimits::default()
    };
    let error = plan_extract(&source, &options(ConflictMode::Skip), &ctx, &limits).unwrap_err();
    assert_eq!(error.kind, ArchiveErrorKind::TooLarge);
}

#[test]
fn permissions_are_never_taken_from_the_archive() {
    let source = src(
        "x.tar",
        tar_of(&[TarItem {
            name: "run.sh",
            kind: tar::EntryType::Regular,
            data: b"#!/bin/sh\n",
            link: "",
            mode: 0o6777,
        }]),
    );
    let (dir, ctx) = workspace();
    run(&source, &options(ConflictMode::Skip), &ctx);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(dir.path().join("run.sh"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o7111,
            0,
            "no exec, setuid, setgid or sticky bits: {mode:o}"
        );
    }
    assert!(dir.path().join("run.sh").is_file());
}

#[test]
fn links_are_never_created() {
    let source = src(
        "l.tar",
        tar_of(&[
            special("ln", tar::EntryType::Symlink, "/etc/passwd"),
            special("hard", tar::EntryType::Link, "/etc/passwd"),
            file("ok.txt", b"ok"),
        ]),
    );
    let (dir, ctx) = workspace();
    let report = run(&source, &options(ConflictMode::Skip), &ctx);
    assert_eq!(tree(dir.path()), vec!["ok.txt"]);
    assert_eq!(report.skipped.len(), 2);
}

#[cfg(unix)]
#[test]
fn symlinked_folder_in_workspace_cannot_redirect_writes() {
    let (dir, ctx) = workspace();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("out")).unwrap();
    let source = src(
        "s.zip",
        zip_of(&[("out/pwned.txt", b"x"), ("safe.txt", b"ok")]),
    );
    let report = run(&source, &options(ConflictMode::Replace), &ctx);
    assert!(report.skipped.iter().any(|s| s.entry == "out/pwned.txt"
        && s.reason
            == SkipReason::Unsafe {
                reason: UnsafeReason::EscapesDestination
            }));
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    assert!(dir.path().join("safe.txt").is_file());
    // The symlinked folder as the destination itself is refused.
    let mut opts = options(ConflictMode::Skip);
    opts.destination = "out".into();
    let error = extract(
        &source,
        &opts,
        &ctx,
        &ArchiveLimits::default(),
        &CancellationToken::default(),
        &mut |_| {},
    )
    .unwrap_err();
    assert_eq!(error.kind, ArchiveErrorKind::InvalidPath);
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn replace_never_follows_a_symlinked_file() {
    let (dir, ctx) = workspace();
    let outside = tempfile::tempdir().unwrap();
    let victim = outside.path().join("victim.txt");
    fs::write(&victim, b"keep").unwrap();
    std::os::unix::fs::symlink(&victim, dir.path().join("a.txt")).unwrap();
    let report = run(&conflict_source(), &options(ConflictMode::Replace), &ctx);
    assert_eq!(fs::read(&victim).unwrap(), b"keep");
    assert!(report.errors.iter().any(|e| e.entry == "a.txt"));
}

#[cfg(unix)]
#[test]
fn write_failure_in_read_only_folder_is_atomic() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, ctx) = workspace();
    let locked = dir.path().join("locked");
    fs::create_dir(&locked).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
    let source = src(
        "ro.zip",
        zip_of(&[("locked/a.txt", b"x"), ("free.txt", b"ok")]),
    );
    let report = run(&source, &options(ConflictMode::Skip), &ctx);
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        report.errors.iter().any(|e| e.entry == "locked/a.txt"),
        "{report:?}"
    );
    assert_eq!(tree(dir.path()), vec!["free.txt", "locked/"]);
}

#[test]
fn workspace_archive_source_refuses_paths_outside() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.zip"), zip_of(&[("x", b"1")])).unwrap();
    let ws = CoreWorkspace::open(dir.path()).unwrap();
    let source = ws.archive_source("a.zip").unwrap();
    assert_eq!(open_archive(&source).unwrap().entries.len(), 1);
    let absolute = dir.path().join("a.zip").display().to_string();
    for bad in [
        "",
        "../a.zip",
        "/etc/passwd",
        absolute.as_str(),
        "missing.zip",
    ] {
        assert!(ws.archive_source(bad).is_err(), "{bad}");
    }
}
