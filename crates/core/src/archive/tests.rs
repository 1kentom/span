//! Archive tests. Every archive is generated here; no binary fixtures.
use super::*;
use crate::CoreWorkspace;
use std::fs;
use std::io::Cursor;
use std::path::Path;
use tempfile::TempDir;
use zip::write::SimpleFileOptions;

// Raw ZIP records, so names, flags, modes and declared sizes can be anything.
struct RawEntry<'a> {
    name: &'a [u8],
    data: &'a [u8],
    declared: Option<u32>,
    flags: u16,
    mode: Option<u32>,
}
fn raw(name: &str, data: &'static [u8]) -> RawEntry<'static> {
    RawEntry {
        name: Box::leak(name.as_bytes().to_vec().into_boxed_slice()),
        data,
        declared: None,
        flags: 0x0800,
        mode: None,
    }
}

fn raw_zip(entries: &[RawEntry<'_>]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for entry in entries {
        let offset = out.len() as u32;
        let crc = crc32(entry.data);
        let size = entry.data.len() as u32;
        let declared = entry.declared.unwrap_or(size);
        let put16 = |v: &mut Vec<u8>, x: u16| v.extend_from_slice(&x.to_le_bytes());
        let put32 = |v: &mut Vec<u8>, x: u32| v.extend_from_slice(&x.to_le_bytes());
        put32(&mut out, 0x0403_4b50);
        put16(&mut out, 20);
        put16(&mut out, entry.flags);
        put16(&mut out, 0);
        put16(&mut out, 0x6000); // 12:00
        put16(&mut out, 0x5a21); // 2025-01-01
        put32(&mut out, crc);
        put32(&mut out, size);
        put32(&mut out, declared);
        put16(&mut out, entry.name.len() as u16);
        put16(&mut out, 0);
        out.extend_from_slice(entry.name);
        out.extend_from_slice(entry.data);
        put32(&mut central, 0x0201_4b50);
        put16(&mut central, if entry.mode.is_some() { 0x031e } else { 20 });
        put16(&mut central, 20);
        put16(&mut central, entry.flags);
        put16(&mut central, 0);
        put16(&mut central, 0x6000);
        put16(&mut central, 0x5a21);
        put32(&mut central, crc);
        put32(&mut central, size);
        put32(&mut central, declared);
        put16(&mut central, entry.name.len() as u16);
        put16(&mut central, 0);
        put16(&mut central, 0);
        put16(&mut central, 0);
        put16(&mut central, 0);
        put32(&mut central, entry.mode.map_or(0, |mode| mode << 16));
        put32(&mut central, offset);
        central.extend_from_slice(entry.name);
    }
    let start = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&start.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out
}

/// Incompressible bytes (a fixed LCG), so ratio rules do not trigger.
fn noise(len: usize, seed: u32) -> Vec<u8> {
    let mut state = seed.wrapping_mul(2_654_435_761).wrapping_add(1);
    (0..len)
        .map(|_| {
            state = state.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            b'a' + (state >> 16) as u8 % 26
        })
        .collect()
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}

fn deflated_zip(files: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true);
    for (name, data) in files {
        writer.start_file(*name, options).unwrap();
        writer.write_all(data).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

// Raw tar records: the tar builder refuses unsafe names, these do not.
fn tar_entry(
    out: &mut tar::Builder<Vec<u8>>,
    name: &str,
    kind: tar::EntryType,
    data: &[u8],
    link: &str,
) {
    let mut header = tar::Header::new_gnu();
    let bytes = name.as_bytes();
    header.as_old_mut().name[..bytes.len()].copy_from_slice(bytes);
    header.set_entry_type(kind);
    header.set_size(data.len() as u64);
    header.set_mode(0o644);
    header.set_mtime(1_700_000_000);
    if !link.is_empty() {
        header.set_link_name_literal(link).unwrap();
    }
    header.set_cksum();
    out.append(&header, data).unwrap();
}
fn tar_bytes(build: impl FnOnce(&mut tar::Builder<Vec<u8>>)) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    build(&mut builder);
    builder.into_inner().unwrap()
}
fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

struct Fixture {
    _temp: TempDir,
    outside: PathBuf,
    root: PathBuf,
    workspace: CoreWorkspace,
}
fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    let outside = temp.path().join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    let workspace = CoreWorkspace::open(&root).unwrap();
    let root = workspace.root.clone();
    let outside = outside.canonicalize().unwrap();
    Fixture {
        _temp: temp,
        outside,
        root,
        workspace,
    }
}
impl Fixture {
    fn archive(&self, name: &str, bytes: &[u8]) -> ArchiveSource {
        let path = self.root.join(name);
        fs::write(&path, bytes).unwrap();
        ArchiveSource::open(&path).unwrap()
    }
    fn extract(
        &mut self,
        source: &ArchiveSource,
        options: &ArchiveExtractOptions,
        limits: &ArchiveLimits,
    ) -> ArchiveExtractReport {
        self.extract_into(source, "", "out", ConflictPolicy::KeepBoth, options, limits)
    }
    fn extract_into(
        &mut self,
        source: &ArchiveSource,
        target_dir: &str,
        folder: &str,
        policy: ConflictPolicy,
        options: &ArchiveExtractOptions,
        limits: &ArchiveLimits,
    ) -> ArchiveExtractReport {
        let target = self
            .workspace
            .archive_extract_target(target_dir, folder)
            .unwrap();
        let staged = source
            .extract_to_staging(
                &target,
                options,
                limits,
                &CancellationToken::default(),
                &mut |_| {},
            )
            .unwrap();
        self.workspace
            .publish_archive_extract_with(&target, staged, policy, &mut |_| {
                panic!("no trash in tests")
            })
            .unwrap()
    }
}

fn reason<'a>(listing: &'a ArchiveListing, path: &str) -> Option<&'a str> {
    listing
        .entries
        .iter()
        .find(|entry| entry.path == path)
        .unwrap_or_else(|| panic!("{path} is listed"))
        .unsafe_reason
        .as_deref()
}
fn tree(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            out.push(
                path.strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
            if entry.file_type().unwrap().is_dir() {
                walk(base, &path, out);
            }
        }
    }
    walk(root, root, &mut out);
    out.sort();
    out
}

#[test]
fn archive_lists_a_normal_zip_tree_with_metadata() {
    let f = fixture();
    let bytes = raw_zip(&[
        raw("docs/", b""),
        raw("docs/readme.md", b"# hi"),
        raw("logo.png", b"png"),
    ]);
    let source = f.archive("site.zip", &bytes);
    let listing = source.list(&ArchiveLimits::default()).unwrap();
    assert_eq!(listing.format, "ZIP");
    assert_eq!(listing.method.as_deref(), Some("Stored"));
    assert!(!listing.truncated);
    assert_eq!(listing.declared_size, 7);
    assert_eq!(listing.archive_size, bytes.len() as u64);
    let paths: Vec<_> = listing
        .entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry.dir, entry.size))
        .collect();
    assert_eq!(
        paths,
        [
            ("docs/", true, 0),
            ("docs/readme.md", false, 4),
            ("logo.png", false, 3)
        ]
    );
    assert!(listing
        .entries
        .iter()
        .all(|entry| entry.unsafe_reason.is_none()));
    // 2025-01-01 12:00 UTC
    assert_eq!(listing.entries[1].modified, Some(1_735_732_800_000));
    assert_eq!(source.folder_name(), "site");
}

#[test]
fn archive_lists_tar_and_tar_gz_trees() {
    let f = fixture();
    let tar = tar_bytes(|b| {
        tar_entry(b, "pkg/", tar::EntryType::Directory, b"", "");
        tar_entry(
            b,
            "pkg/index.js",
            tar::EntryType::Regular,
            b"module.exports = 1;\n",
            "",
        );
    });
    for (name, bytes, format) in [
        ("pkg.tar", tar.clone(), "TAR"),
        ("pkg.tgz", gzip(&tar), "TAR.GZ"),
    ] {
        let source = f.archive(name, &bytes);
        let listing = source.list(&ArchiveLimits::default()).unwrap();
        assert_eq!(listing.format, format);
        assert_eq!(listing.entries.len(), 2);
        assert!(listing.entries[0].dir);
        assert_eq!(listing.entries[1].size, 20);
        assert_eq!(listing.entries[1].modified, Some(1_700_000_000_000));
        assert_eq!(source.folder_name(), "pkg");
        let preview = source
            .read_entry("pkg/index.js", &ArchiveLimits::default())
            .unwrap();
        assert_eq!(preview.bytes, b"module.exports = 1;\n");
    }
}

#[test]
fn archive_extracts_a_tree_into_a_new_folder() {
    let mut f = fixture();
    let bytes = deflated_zip(&[
        ("src/main.rs", b"fn main() {}\n".to_vec()),
        ("README", b"hello".to_vec()),
    ]);
    let source = f.archive("app.jar", &bytes);
    let report = f.extract(
        &source,
        &ArchiveExtractOptions::default(),
        &ArchiveLimits::default(),
    );
    assert_eq!(report.error, None);
    assert_eq!(report.created.as_deref(), Some("out"));
    assert_eq!(report.entries, 2);
    assert_eq!(
        fs::read(f.root.join("out/src/main.rs")).unwrap(),
        b"fn main() {}\n"
    );
    assert_eq!(
        tree(&f.root),
        ["app.jar", "out", "out/README", "out/src", "out/src/main.rs"]
    );
}

#[test]
fn archive_refuses_zip_slip_names_and_writes_only_safe_entries() {
    let mut f = fixture();
    let bytes = raw_zip(&[
        raw("../x", b"evil"),
        raw("/abs", b"evil"),
        raw("C:\\x", b"evil"),
        raw("C:/x", b"evil"),
        raw("a/../../b", b"evil"),
        raw("dir\\..\\..\\c", b"evil"),
        raw("nul\u{0}.txt", b"evil"),
        raw("ok.txt", b"ok"),
    ]);
    let source = f.archive("slip.zip", &bytes);
    let listing = source.list(&ArchiveLimits::default()).unwrap();
    assert_eq!(
        reason(&listing, "../x"),
        Some("parent folder component (..)")
    );
    assert_eq!(reason(&listing, "/abs"), Some("absolute path"));
    assert_eq!(reason(&listing, "C:\\x"), Some("backslash in name"));
    assert_eq!(reason(&listing, "C:/x"), Some("drive prefix"));
    assert_eq!(
        reason(&listing, "a/../../b"),
        Some("parent folder component (..)")
    );
    assert_eq!(
        reason(&listing, "dir\\..\\..\\c"),
        Some("backslash in name")
    );
    assert_eq!(
        reason(&listing, "nul\u{0}.txt"),
        Some("NUL character in name")
    );
    assert_eq!(reason(&listing, "ok.txt"), None);
    let report = f.extract(
        &source,
        &ArchiveExtractOptions::default(),
        &ArchiveLimits::default(),
    );
    assert_eq!(report.entries, 1);
    assert_eq!(report.skipped.len(), 7);
    assert_eq!(tree(&f.root), ["out", "out/ok.txt", "slip.zip"]);
    assert!(fs::read_dir(&f.outside).unwrap().next().is_none());
    assert!(!f.root.parent().unwrap().join("x").exists());
    assert!(!f.root.parent().unwrap().join("b").exists());
}

#[test]
fn archive_refuses_deep_and_long_paths() {
    let f = fixture();
    let deep = vec!["d"; MAX_ARCHIVE_DEPTH + 1].join("/");
    let long = "x".repeat(MAX_ARCHIVE_PATH_BYTES + 10);
    let wide = format!("{}.txt", "w".repeat(MAX_ARCHIVE_COMPONENT_BYTES));
    let entries = [raw(&deep, b"1"), raw(&long, b"1"), raw(&wide, b"1")];
    let listing = f
        .archive("deep.zip", &raw_zip(&entries))
        .list(&ArchiveLimits::default())
        .unwrap();
    assert_eq!(
        listing.entries[0].unsafe_reason.as_deref(),
        Some("nested deeper than 64 folders")
    );
    assert_eq!(
        listing.entries[1].path.len(),
        MAX_ARCHIVE_PATH_BYTES,
        "listed names are capped"
    );
    assert_eq!(
        listing.entries[1].unsafe_reason.as_deref(),
        Some("name is longer than 1,024 bytes")
    );
    assert_eq!(
        listing.entries[2].unsafe_reason.as_deref(),
        Some("path component is longer than 255 bytes")
    );
}

#[test]
fn archive_never_extracts_symlink_entries() {
    let mut f = fixture();
    let mut link = raw("link", b"../../outside");
    link.mode = Some(0o120777);
    let zip = raw_zip(&[link, raw("keep.txt", b"k")]);
    let source = f.archive("links.zip", &zip);
    let listing = source.list(&ArchiveLimits::default()).unwrap();
    assert_eq!(listing.entries[0].kind, ArchiveEntryKind::Symlink);
    assert!(reason(&listing, "link")
        .unwrap()
        .starts_with("symbolic link"));
    let report = f.extract(
        &source,
        &ArchiveExtractOptions::default(),
        &ArchiveLimits::default(),
    );
    assert_eq!(report.entries, 1);
    assert!(f.root.join("out/link").symlink_metadata().is_err());
    assert!(source
        .read_entry("link", &ArchiveLimits::default())
        .is_err());
}

#[test]
fn archive_never_extracts_tar_links_or_devices() {
    let mut f = fixture();
    let tar = tar_bytes(|b| {
        tar_entry(b, "sym", tar::EntryType::Symlink, b"", "/etc/passwd");
        tar_entry(b, "hard", tar::EntryType::Link, b"", "../outside/file");
        tar_entry(b, "dev", tar::EntryType::Char, b"", "");
        tar_entry(b, "fifo", tar::EntryType::Fifo, b"", "");
        tar_entry(b, "../up", tar::EntryType::Regular, b"evil", "");
        tar_entry(b, "./fine.txt", tar::EntryType::Regular, b"fine", "");
    });
    let source = f.archive("links.tar", &tar);
    let listing = source.list(&ArchiveLimits::default()).unwrap();
    assert!(reason(&listing, "sym")
        .unwrap()
        .starts_with("symbolic link"));
    assert!(reason(&listing, "hard").unwrap().starts_with("hard link"));
    assert_eq!(reason(&listing, "dev"), Some("device or special file"));
    assert_eq!(reason(&listing, "fifo"), Some("device or special file"));
    assert_eq!(
        reason(&listing, "../up"),
        Some("parent folder component (..)")
    );
    assert_eq!(reason(&listing, "./fine.txt"), None);
    let report = f.extract(
        &source,
        &ArchiveExtractOptions::default(),
        &ArchiveLimits::default(),
    );
    assert_eq!(report.error, None);
    assert_eq!(report.entries, 1);
    assert_eq!(tree(&f.root.join("out")), ["fine.txt"]);
}

#[test]
fn archive_refuses_names_that_collide_after_normalisation_or_case_folding() {
    let mut f = fixture();
    let zip = raw_zip(&[
        raw("README.txt", b"1"),
        raw("readme.TXT", b"2"),
        raw("caf\u{e9}.txt", b"3"),
        raw("cafe\u{301}.txt", b"4"),
        raw("\u{fb01}le", b"5"),
        raw("FILE", b"6"),
        raw("a", b"7"),
        raw("a/b", b"8"),
        raw("Stra\u{df}e", b"9"),
        raw("STRASSE", b"10"),
        raw("unique.txt", b"u"),
    ]);
    let source = f.archive("dupes.zip", &zip);
    let listing = source.list(&ArchiveLimits::default()).unwrap();
    for entry in &listing.entries {
        if entry.path == "unique.txt" {
            assert_eq!(entry.unsafe_reason, None);
        } else {
            assert!(
                entry
                    .unsafe_reason
                    .as_deref()
                    .is_some_and(|reason| reason.starts_with("name collides")),
                "{} should collide",
                entry.path
            );
        }
    }
    let report = f.extract(
        &source,
        &ArchiveExtractOptions::default(),
        &ArchiveLimits::default(),
    );
    assert_eq!(report.entries, 1);
    assert_eq!(tree(&f.root.join("out")), ["unique.txt"]);
}

#[test]
fn archive_flags_zip_bombs_by_ratio_and_declared_size() {
    let mut f = fixture();
    let zeros = vec![0u8; 8 * 1024 * 1024];
    let bomb = deflated_zip(&[("zeros.bin", zeros), ("small.txt", b"s".to_vec())]);
    let source = f.archive("bomb.zip", &bomb);
    let listing = source.list(&ArchiveLimits::default()).unwrap();
    assert_eq!(
        reason(&listing, "zeros.bin"),
        Some("compression ratio above 200:1")
    );
    let report = f.extract(
        &source,
        &ArchiveExtractOptions::default(),
        &ArchiveLimits::default(),
    );
    assert_eq!(report.entries, 1);
    assert!(!f.root.join("out/zeros.bin").exists());

    // A huge declared size is reported, never trusted, and refused.
    let mut huge = raw("huge.bin", b"tiny");
    huge.declared = Some(u32::MAX);
    let source = f.archive("huge.zip", &raw_zip(&[huge, raw("ok", b"ok")]));
    let listing = source.list(&ArchiveLimits::default()).unwrap();
    assert_eq!(listing.declared_size, u64::from(u32::MAX) + 2);
    assert_eq!(
        reason(&listing, "huge.bin"),
        Some("larger than 512 MiB, the per file limit")
    );
}

#[test]
fn archive_selection_over_the_total_limit_is_refused_before_writing() {
    let f = fixture();
    let zip = deflated_zip(&[("a.txt", vec![b'a'; 4096]), ("b.txt", vec![b'b'; 4096])]);
    let source = f.archive("big.zip", &zip);
    let limits = ArchiveLimits::with_total_bytes(6000);
    let target = f.workspace.archive_extract_target("", "out").unwrap();
    let error = source
        .extract_to_staging(
            &target,
            &ArchiveExtractOptions::default(),
            &limits,
            &CancellationToken::default(),
            &mut |_| {},
        )
        .unwrap_err();
    assert!(error.to_string().contains("extraction limit"), "{error}");
    assert_eq!(tree(&f.root), ["big.zip"]);
}

#[test]
fn archive_stops_a_tar_gz_bomb_while_listing() {
    let f = fixture();
    let tar = tar_bytes(|b| {
        tar_entry(
            b,
            "zeros",
            tar::EntryType::Regular,
            &vec![0u8; 4 * 1024 * 1024],
            "",
        )
    });
    let source = f.archive("bomb.tgz", &gzip(&tar));
    let limits = ArchiveLimits {
        ratio_floor: 64 * 1024,
        ..ArchiveLimits::default()
    };
    let error = source.list(&limits).unwrap_err();
    assert!(
        error.to_string().contains("compression ratio above 200:1"),
        "{error}"
    );
}

#[test]
fn archive_lists_nested_archives_as_entries_without_opening_them() {
    let mut f = fixture();
    let inner = deflated_zip(&[("deep.txt", b"deep".to_vec())]);
    let middle = deflated_zip(&[("inner.zip", inner)]);
    let outer = deflated_zip(&[("middle.zip", middle.clone())]);
    let source = f.archive("outer.zip", &outer);
    let listing = source.list(&ArchiveLimits::default()).unwrap();
    assert_eq!(listing.entries.len(), 1);
    assert_eq!(listing.entries[0].path, "middle.zip");
    let error = source
        .read_entry("middle.zip", &ArchiveLimits::default())
        .unwrap_err();
    assert!(error.to_string().contains("Nested archives"), "{error}");
    let report = f.extract(
        &source,
        &ArchiveExtractOptions::default(),
        &ArchiveLimits::default(),
    );
    assert_eq!(report.entries, 1);
    assert_eq!(tree(&f.root.join("out")), ["middle.zip"]);
    assert_eq!(fs::read(f.root.join("out/middle.zip")).unwrap(), middle);
}

#[test]
fn archive_with_too_many_entries_is_truncated_and_not_extractable() {
    assert_eq!(MAX_ARCHIVE_ENTRIES, 50_000);
    let f = fixture();
    let names: Vec<String> = (0..6).map(|i| format!("f{i}")).collect();
    let entries: Vec<_> = names.iter().map(|name| raw(name, b"x")).collect();
    let source = f.archive("many.zip", &raw_zip(&entries));
    let limits = ArchiveLimits {
        max_entries: 5,
        ..ArchiveLimits::default()
    };
    let listing = source.list(&limits).unwrap();
    assert!(listing.truncated);
    assert_eq!(listing.entries.len(), 5);
    let target = f.workspace.archive_extract_target("", "out").unwrap();
    let error = source
        .extract_to_staging(
            &target,
            &ArchiveExtractOptions::default(),
            &limits,
            &CancellationToken::default(),
            &mut |_| {},
        )
        .unwrap_err();
    assert!(error.to_string().contains("more than 5 entries"), "{error}");
    let tar = tar_bytes(|b| {
        for name in &names {
            tar_entry(b, name, tar::EntryType::Regular, b"x", "");
        }
    });
    assert!(f.archive("many.tar", &tar).list(&limits).unwrap().truncated);
}

#[test]
fn archive_flags_encrypted_entries_and_never_reads_them() {
    let mut f = fixture();
    let mut secret = raw(
        "secret.txt",
        b"\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0cdata",
    );
    secret.flags |= 1;
    let source = f.archive("locked.zip", &raw_zip(&[secret, raw("open.txt", b"open")]));
    let listing = source.list(&ArchiveLimits::default()).unwrap();
    assert!(listing.entries[0].encrypted);
    assert_eq!(reason(&listing, "secret.txt"), Some("encrypted"));
    assert!(source
        .read_entry("secret.txt", &ArchiveLimits::default())
        .is_err());
    let report = f.extract(
        &source,
        &ArchiveExtractOptions::default(),
        &ArchiveLimits::default(),
    );
    assert_eq!(report.entries, 1);
    assert_eq!(report.skipped[0].reason, "encrypted");
}

#[test]
fn archive_reports_truncated_or_corrupt_archives_cleanly() {
    let f = fixture();
    let zip = deflated_zip(&[("a.txt", vec![b'a'; 10_000])]);
    let source = f.archive("cut.zip", &zip[..zip.len() / 2]);
    let error = source.list(&ArchiveLimits::default()).unwrap_err();
    assert!(
        error.to_string().contains("damaged or incomplete"),
        "{error}"
    );

    let garbage = f.root.join("noise.zip");
    fs::write(&garbage, b"PK\x03\x04 this is not a zip").unwrap();
    assert!(ArchiveSource::open(&garbage)
        .unwrap()
        .list(&ArchiveLimits::default())
        .is_err());
    let plain = f.root.join("notes.txt");
    fs::write(&plain, b"hello").unwrap();
    assert!(ArchiveSource::open(&plain).is_err());

    // A tar cut inside an entry's data lists its header but cannot be extracted.
    let tar = tar_bytes(|b| tar_entry(b, "big", tar::EntryType::Regular, &vec![7u8; 100_000], ""));
    let source = f.archive("cut.tar", &tar[..50_000]);
    let target = f.workspace.archive_extract_target("", "out").unwrap();
    match source.extract_to_staging(
        &target,
        &ArchiveExtractOptions::default(),
        &ArchiveLimits::default(),
        &CancellationToken::default(),
        &mut |_| {},
    ) {
        Ok(staged) => assert!(staged.error.is_some(), "a cut tar never extracts"),
        Err(error) => assert!(
            error.to_string().contains("damaged or incomplete"),
            "{error}"
        ),
    }
    assert_eq!(
        tree(&f.root),
        ["cut.tar", "cut.zip", "noise.zip", "notes.txt"]
    );
}

#[test]
fn archive_cancel_leaves_no_partial_files() {
    let mut f = fixture();
    let files: Vec<(String, Vec<u8>)> = (0..4)
        .map(|i| (format!("part{i}.bin"), noise(3 * 1024 * 1024, i)))
        .collect();
    let files: Vec<(&str, Vec<u8>)> = files
        .iter()
        .map(|(name, data)| (name.as_str(), data.clone()))
        .collect();
    for (name, bytes) in [
        ("parts.zip", deflated_zip(&files)),
        (
            "parts.tar",
            tar_bytes(|b| {
                for (name, data) in &files {
                    tar_entry(b, name, tar::EntryType::Regular, data, "");
                }
            }),
        ),
    ] {
        let source = f.archive(name, &bytes);
        let target = f.workspace.archive_extract_target("", "out").unwrap();
        let token = CancellationToken::default();
        let mut events = 0;
        let staged = source
            .extract_to_staging(
                &target,
                &ArchiveExtractOptions::default(),
                &ArchiveLimits::default(),
                &token,
                &mut |progress| {
                    events += 1;
                    if progress.bytes > 4 * 1024 * 1024 {
                        token.cancel();
                    }
                },
            )
            .unwrap();
        assert!(events > 1);
        assert!(staged.cancelled);
        assert_eq!(staged.error, None);
        let report = f
            .workspace
            .publish_archive_extract_with(
                &target,
                staged,
                ConflictPolicy::KeepBoth,
                &mut |_| unreachable!(),
            )
            .unwrap();
        assert!(report.cancelled);
        assert_eq!(report.created, None);
        let mut names = tree(&f.root);
        names.retain(|path| !path.ends_with(".zip") && !path.ends_with(".tar"));
        assert!(names.is_empty(), "nothing stays behind: {names:?}");
    }
}

#[cfg(unix)]
#[test]
fn archive_strips_setuid_and_executable_bits_unless_kept() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = fixture();
    let mut tool = raw("bin/tool", b"#!/bin/sh\n");
    tool.mode = Some(0o104755);
    let mut data = raw("data.txt", b"d");
    data.mode = Some(0o100666);
    let zip = raw_zip(&[tool, data]);
    let source = f.archive("tools.zip", &zip);
    assert!(source.list(&ArchiveLimits::default()).unwrap().entries[0].executable);
    let mode = |path: &str| fs::metadata(path).unwrap().permissions().mode() & 0o7777;
    f.extract(
        &source,
        &ArchiveExtractOptions::default(),
        &ArchiveLimits::default(),
    );
    assert_eq!(mode(&f.root.join("out/bin/tool").to_string_lossy()), 0o644);
    assert_eq!(mode(&f.root.join("out/data.txt").to_string_lossy()), 0o644);
    let keep = ArchiveExtractOptions {
        keep_executable: true,
        ..ArchiveExtractOptions::default()
    };
    let report = f.extract_into(
        &source,
        "",
        "kept",
        ConflictPolicy::KeepBoth,
        &keep,
        &ArchiveLimits::default(),
    );
    assert_eq!(report.created.as_deref(), Some("kept"));
    assert_eq!(mode(&f.root.join("kept/bin/tool").to_string_lossy()), 0o755);
    assert_eq!(mode(&f.root.join("kept/data.txt").to_string_lossy()), 0o644);
}

#[cfg(unix)]
#[test]
fn archive_refuses_to_extract_through_a_symlink_in_the_destination() {
    let mut f = fixture();
    let source = f.archive("pkg.zip", &raw_zip(&[raw("a.txt", b"a")]));
    std::os::unix::fs::symlink(&f.outside, f.root.join("escape")).unwrap();
    // The destination folder itself is a link out of the workspace.
    assert!(f.workspace.archive_extract_target("escape", "pkg").is_err());
    // A folder below a link that leaves the workspace.
    fs::create_dir(f.outside.join("sub")).unwrap();
    assert!(f
        .workspace
        .archive_extract_target("escape/sub", "pkg")
        .is_err());
    // The new folder's name is taken by a link: Keep both never writes through it.
    std::os::unix::fs::symlink(&f.outside, f.root.join("pkg")).unwrap();
    let report = f.extract_into(
        &source,
        "",
        "pkg",
        ConflictPolicy::KeepBoth,
        &ArchiveExtractOptions::default(),
        &ArchiveLimits::default(),
    );
    assert_eq!(report.created.as_deref(), Some("pkg copy"));
    assert!(f.root.join("pkg copy/a.txt").exists());
    // Replace refuses to touch the link and leaves nothing behind.
    let target = f.workspace.archive_extract_target("", "pkg").unwrap();
    let staged = source
        .extract_to_staging(
            &target,
            &ArchiveExtractOptions::default(),
            &ArchiveLimits::default(),
            &CancellationToken::default(),
            &mut |_| {},
        )
        .unwrap();
    let error = f
        .workspace
        .publish_archive_extract_with(&target, staged, ConflictPolicy::Replace, &mut |_| {
            panic!("the link is never trashed")
        })
        .unwrap_err();
    assert!(
        error.to_string().contains("outside the workspace"),
        "{error}"
    );
    assert_eq!(tree(&f.outside), ["sub"]);
    assert!(!tree(&f.root)
        .iter()
        .any(|path| path.contains(".span-extract")));
}

#[test]
fn archive_keeps_both_on_a_clash_and_skip_leaves_the_existing_folder() {
    let mut f = fixture();
    let source = f.archive("pkg.zip", &raw_zip(&[raw("a.txt", b"new")]));
    fs::create_dir(f.root.join("pkg")).unwrap();
    fs::write(f.root.join("pkg/a.txt"), b"old").unwrap();
    let target = f.workspace.archive_extract_target("", "pkg").unwrap();
    let plan = source
        .plan(
            &target,
            &ArchiveExtractOptions::default(),
            &ArchiveLimits::default(),
        )
        .unwrap();
    assert_eq!(plan.conflicts, ["pkg"]);
    assert_eq!(plan.destination, "pkg");
    let report = f.extract_into(
        &source,
        "",
        "pkg",
        ConflictPolicy::KeepBoth,
        &ArchiveExtractOptions::default(),
        &ArchiveLimits::default(),
    );
    assert_eq!(report.created.as_deref(), Some("pkg copy"));
    let report = f.extract_into(
        &source,
        "",
        "pkg",
        ConflictPolicy::Skip,
        &ArchiveExtractOptions::default(),
        &ArchiveLimits::default(),
    );
    assert!(report.skipped_existing);
    assert_eq!(fs::read(f.root.join("pkg/a.txt")).unwrap(), b"old");
    assert!(!tree(&f.root)
        .iter()
        .any(|path| path.contains(".span-extract")));
}

#[test]
fn archive_extracts_a_selection_flat_or_structured() {
    let mut f = fixture();
    let zip = raw_zip(&[
        raw("a/one.txt", b"1"),
        raw("a/b/two.txt", b"2"),
        raw("c/three.txt", b"3"),
        raw(".hidden", b"h"),
    ]);
    let source = f.archive("sel.zip", &zip);
    let options = ArchiveExtractOptions {
        paths: Some(vec!["a".into()]),
        ..ArchiveExtractOptions::default()
    };
    f.extract(&source, &options, &ArchiveLimits::default());
    assert_eq!(
        tree(&f.root.join("out")),
        ["a", "a/b", "a/b/two.txt", "a/one.txt"]
    );
    let flat = ArchiveExtractOptions {
        paths: None,
        keep_structure: false,
        skip_hidden: true,
        keep_executable: false,
    };
    let report = f.extract_into(
        &source,
        "",
        "flat",
        ConflictPolicy::KeepBoth,
        &flat,
        &ArchiveLimits::default(),
    );
    assert_eq!(
        report.skipped,
        [ArchiveSkip {
            path: ".hidden".into(),
            reason: "hidden file".into()
        }]
    );
    assert_eq!(
        tree(&f.root.join("flat")),
        ["one.txt", "three.txt", "two.txt"]
    );
    let missing = ArchiveExtractOptions {
        paths: Some(vec!["nope".into()]),
        ..ArchiveExtractOptions::default()
    };
    let target = f.workspace.archive_extract_target("", "x").unwrap();
    assert!(source
        .plan(&target, &missing, &ArchiveLimits::default())
        .is_err());
}

#[test]
fn archive_previews_only_bounded_text_and_images() {
    let f = fixture();
    let big = noise((MAX_ARCHIVE_PREVIEW_BYTES + 10) as usize, 7);
    let zip = deflated_zip(&[
        ("notes.md", b"# notes".to_vec()),
        ("big.log", big),
        ("pic.png", b"\x89PNG\r\n\x1a\nfake".to_vec()),
        ("blob.bin", vec![0, 1, 2, 3]),
        ("dir/x.txt", b"x".to_vec()),
    ]);
    let source = f.archive("mix.zip", &zip);
    let limits = ArchiveLimits::default();
    let text = source.read_entry("notes.md", &limits).unwrap();
    assert_eq!(
        (text.kind, text.truncated, text.bytes.as_slice()),
        (ArchivePreviewKind::Text, false, &b"# notes"[..])
    );
    let big = source.read_entry("big.log", &limits).unwrap();
    assert!(big.truncated);
    assert_eq!(big.bytes.len() as u64, MAX_ARCHIVE_PREVIEW_BYTES);
    assert_eq!(
        source.read_entry("pic.png", &limits).unwrap().kind,
        ArchivePreviewKind::Image
    );
    assert!(source
        .read_entry("blob.bin", &limits)
        .unwrap_err()
        .to_string()
        .contains("Only text and images"));
    assert!(source
        .read_entry("missing", &limits)
        .unwrap_err()
        .to_string()
        .contains("not in this archive"));
}

#[test]
fn archive_target_rules_reuse_the_import_containment() {
    let f = fixture();
    assert!(f
        .workspace
        .archive_extract_target("../outside", "x")
        .is_err());
    assert!(f
        .workspace
        .archive_extract_target(&f.outside.to_string_lossy(), "x")
        .is_err());
    for bad in ["", "a/b", "..", ".hidden", "con", "x:y"] {
        assert!(
            f.workspace.archive_extract_target("", bad).is_err(),
            "{bad}"
        );
    }
    fs::create_dir(f.root.join(".git")).unwrap();
    assert!(f.workspace.archive_extract_target(".git", "x").is_err());
}

#[test]
fn archive_default_folder_names() {
    assert_eq!(default_folder_name("build.tar.gz"), "build");
    assert_eq!(default_folder_name("App.JAR"), "App");
    assert_eq!(default_folder_name("pkg.tgz"), "pkg");
    assert_eq!(default_folder_name(".zip"), "extracted");
    assert_eq!(default_folder_name("weird..zip"), "weird");
}

#[test]
fn archive_extract_limit_setting_is_user_only_and_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("p");
    fs::create_dir_all(project.join(".span")).unwrap();
    fs::write(
        project.join(".span/settings.jsonc"),
        r#"{ "archiveExtractLimitMb": 16000 }"#,
    )
    .unwrap();
    let user = dir.path().join("user.jsonc");
    let ws = CoreWorkspace::open(&project)
        .unwrap()
        .with_user_settings(Some(user.clone()));
    assert_eq!(
        ws.get_settings().unwrap().archive_extract_limit_mb,
        1024,
        "a cloned project cannot raise the cap"
    );
    fs::write(&user, r#"{ "archiveExtractLimitMb": 2048 }"#).unwrap();
    assert_eq!(ws.get_settings().unwrap().archive_extract_limit_mb, 2048);
    fs::write(&user, r#"{ "archiveExtractLimitMb": 0 }"#).unwrap();
    assert!(ws.get_settings().is_err());
}
