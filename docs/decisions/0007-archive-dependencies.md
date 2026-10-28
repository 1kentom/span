# 0007: Archive reading and extraction dependencies

Status: accepted. Backend for the Archive viewer (list, read one entry,
extract into the workspace).

## Context

The Archive viewer lists ZIP, TAR and gzip-compressed TAR files, previews
single entries and extracts them into the workspace. Parsing these formats
by hand is a large attack surface (ZIP64, data descriptors, GNU and PAX long
names), so the formats come from maintained crates while every safety rule
(path normalisation, links, caps, conflicts, atomic writes) stays in
`crates/core/src/archive/`, where it is tested without the crates' own
extraction helpers. Those helpers (`ZipArchive::extract`, `tar::Entry::unpack`)
are never called: they restore permissions and create links, which this
design forbids.

The workspace already locks all three crates: `span-lsp` uses `zip`, `tar`
and `flate2` to unpack language servers, and `flate2` also arrives through
Tauri's PNG and icon tooling.

## Decision

Add to `crates/core/Cargo.toml` only, pinned to the exact versions already
in `Cargo.lock`:

| Crate | Version | Licence | Features |
| --- | --- | --- | --- |
| `zip` | `=2.6.1` | MIT | `default-features = false`, `deflate-flate2`, `flate2` |
| `tar` | `=0.4.46` | MIT OR Apache-2.0 | `default-features = false` (no `xattr`) |
| `flate2` | `=1.1.10` | MIT OR Apache-2.0 | `default-features = false`, `rust_backend` |

No encryption (`aes-crypto`), time (`time`, `chrono`, `jiff`), `bzip2`,
`zstd`, `lzma`, `xz`, `deflate64` or `zopfli` features are enabled for
`span-core`. ZIP entries using other methods are listed as
`unsupportedMethod`; encrypted entries are listed as `encrypted` and never
decrypted. ZIP DOS times are converted in core without a time crate.

`zip`'s `deflate-flate2` feature does not by itself enable its optional
`flate2` dependency in 2.6.1, so the `flate2` feature is named explicitly;
without it `span-core` would only compile inside the workspace, through
feature unification with `span-lsp`.

`flate2` uses the pure Rust `miniz_oxide` backend, the backend the lock
already resolves. No C zlib is built.

## Licences and new crates

Licences were read with `cargo metadata`. Every crate added to the
`span-core` graph is permissive; none is GPL or AGPL.

New crates in `cargo tree -p span-core -e normal` (8):

| Crate | Version | Licence | Build script |
| --- | --- | --- | --- |
| `zip` | 2.6.1 | MIT | yes: prints a deprecation warning for the `deflate-miniz` feature only |
| `tar` | 0.4.46 | MIT OR Apache-2.0 | no |
| `flate2` | 1.1.10 | MIT OR Apache-2.0 | no |
| `miniz_oxide` | 0.9.1 | MIT OR Zlib OR Apache-2.0 | no |
| `adler2` | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | no |
| `simd-adler32` | 0.3.10 | MIT | no |
| `crc32fast` | 1.5.3 | MIT OR Apache-2.0 | yes: reads the rustc version to enable stable SIMD intrinsics |
| `filetime` | 0.2.29 | MIT OR Apache-2.0 | no |

Neither build script compiles native code or touches the network; both only
emit `cfg` flags or a warning. `libc` and `cfg-if` were already in the graph.

New crates in `Cargo.lock` for the whole workspace: 0. The lock diff only
adds the three names to `span-core`'s dependency list.

`cargo tree -p span-core | wc -l`: 123 lines before, 139 after.

## Consequences

- Security fixes in these crates now matter to `span-core` as well as
  `span-lsp`. Exact pins mean upgrades are deliberate and happen for both
  crates together.
- The rules that keep extraction safe do not depend on crate behaviour:
  names are judged as strings, links and devices are never created, sizes
  and ratios are counted while streaming, and files are published with
  create-new or atomic rename semantics.
- Adding a compression method later (for example `zstd`) is a feature flag
  change here plus an ADR update, and it must not bring native code.
- Windows behaviour (drive and UNC names, reserved device names, rename
  replacing an open file) is covered by string-level tests on every
  platform, but native Windows extraction is verified only in CI.
