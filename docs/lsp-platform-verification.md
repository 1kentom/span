# Real language server platform verification

Issue: [#44](https://github.com/1kentom/span/issues/44).

The real-server CI matrix exercises the pinned server downloads, runtime resolution,
initialization, requests, diagnostics and owned-process shutdown through both the
LSP manager and the desktop service. Compilation alone does not establish those
behaviors. No server is replaced by a mock or silently skipped when a runtime is
missing.

| Platform | Standard runner | Runtime setup |
| --- | --- | --- |
| Linux x86_64 | `ubuntu-24.04` | Node 22, Temurin JDK 25 |
| Linux aarch64 | `ubuntu-24.04-arm` | Node 22, Temurin JDK 25 |
| macOS aarch64 | `macos-15` | Node 22, Temurin JDK 25 |
| macOS x86_64 | `macos-15-intel` | Node 22, Temurin JDK 25 |
| Windows x86_64 | `windows-2025` | Node 22, Temurin JDK 25 |

Runner labels and architectures follow the [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
JDK setup follows [setup-java v4](https://github.com/actions/setup-java/blob/v4/README.md).
Use its platform-specific `JAVA_HOME`, rather than assuming an x86_64 preinstalled
JDK variable is available on ARM runners. Download caches include OS and architecture
to prevent reusing a server binary for the wrong platform.

Every matrix member retains its own protocol trace artifact. The existing bounded
one-time diagnostic retry is retained, and its initial failure remains in the same
output log. A second attempt passing does not erase the first attempt's evidence.
The final CI gate depends on the complete matrix, with fail-fast disabled so one
platform's failure does not hide results on the others.

This extends actual process verification, not interactive native UI verification.
It does not claim support for arbitrary older Node/JDK versions, project imports,
every language feature, or unsigned archive provenance beyond the installer's
pinned SHA-256 checks. Record exact workflow results before closing #44.

## First Windows run

[Run 40828891476](https://github.com/1kentom/span/actions/runs/40828891476)
passed both Linux architectures and both macOS architectures. Windows initially
failed four smoke tests on both attempts. Its retained protocol traces show that
the servers delivered diagnostics, but the fixture compared raw URI strings:
the client sent `file:///C:/...`, while servers returned `file:///c:/...` or
`file:///c%3A/...`. The desktop service already decodes file URIs and normalizes
Windows drive letters when matching diagnostics to open documents.

The smoke fixture now applies the same filesystem identity when collecting and
looking up diagnostics. Regression cases retain different filenames, filename
case, directories, drives and non-file URI identities. Diagnostic contents,
UTF-16 ranges, error predicates and time limits are unchanged. The initial
failure is evidence of a fixture matching defect, not absent server diagnostics;
the corrected matrix must still pass before this verification is complete.
