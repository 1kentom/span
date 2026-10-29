//! Pinned catalog of supported language servers.
//!
//! Every version, URL and SHA-256 below was resolved on 2026-10-28 and pinned
//! to the newest stable release that was at least two weeks old (published on
//! or before 2026-10-14). Each SHA-256 was computed locally with
//! `shasum -a 256` over the downloaded file, never copied blindly.
//!
//! # Install layout contract (consumed by `install.rs`)
//!
//! - `NpmTarball` artifacts are placed at `node_modules/<package name>/` in a
//!   flat layout, so every plan lists a complete, de-duplicated dependency
//!   closure. The first artifact is the server's own package and its `entry`
//!   is the executable script; dependency artifacts use
//!   `node_modules/<name>/package.json` as `entry`.
//! - Optional npm dependencies (for example `fsevents`) are intentionally not
//!   installed, because the installer never runs lifecycle scripts.
//! - `TarGz` and `Zip` artifacts extract into the version directory root, and
//!   `Gz` artifacts decompress to the path in `entry`.
//!
//! # Sources
//!
//! - vtsls: <https://github.com/yioneko/vtsls> (npm `@vtsls/language-server`
//!   0.3.0, <https://www.npmjs.com/package/@vtsls/language-server>). It depends
//!   on `@vtsls/language-service` 0.3.0 which pins `typescript` 5.9.3 exactly;
//!   that bundled TypeScript is what vtsls uses by default (see the "TypeScript
//!   version" section of the vtsls README). TypeScript 7.x (native port) is
//!   deliberately not used because vtsls drives the JavaScript `tsserver`.
//! - HTML, CSS, JSON: npm `vscode-langservers-extracted` 4.10.0
//!   (<https://github.com/hrsh7th/vscode-langservers-extracted>). Microsoft
//!   publishes the language service libraries (`vscode-html-languageservice`,
//!   `vscode-css-languageservice`, `vscode-json-languageservice`) but not the
//!   LSP server executables, whose source lives in the VS Code repository under
//!   `extensions/{html,css,json}-language-features/server`. This package is the
//!   maintained build of exactly that VS Code server source, and it is the only
//!   npm distribution that ships runnable `vscode-{html,css,json}-language-server`
//!   binaries, so it is chosen over assembling servers from the `@vscode/*`
//!   libraries ourselves. Its markdown/eslint servers are not exposed.
//! - rust-analyzer: release `2026-10-12`
//!   (<https://github.com/rust-lang/rust-analyzer/releases/tag/2026-10-12>).
//!   The SHA-256 values match the digests GitHub publishes for those assets.
//! - basedpyright: npm `basedpyright` 1.40.2
//!   (<https://docs.basedpyright.com/latest/installation/ides/>, which launches
//!   `basedpyright-langserver --stdio`; the npm `bin` entry maps it to
//!   `langserver.index.js`).
//! - Eclipse JDT Language Server: milestone 1.62.0 build 202610131109
//!   (<https://download.eclipse.org/jdtls/milestones/1.62.0/>). The SHA-256 equals
//!   the `.sha256` file Eclipse publishes next to the archive. The Java
//!   launch flags come from the README at tag `v1.62.0`
//!   (<https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.62.0/README.md>)
//!   and the `bin/jdtls.py` wrapper shipped in the archive. The Java
//!   requirement is 25, measured from the archive (see `spec`), not the stale
//!   "Java 21" in that README.

use super::spec::{
    Artifact, ArtifactKind, InstallPlan, LaunchSpec, Runtime, RuntimeRequirement, ServerId,
    ServerSpec,
};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

/// Operating systems the catalog ships artifacts for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Os {
    MacOs,
    Linux,
    Windows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Arch {
    Aarch64,
    X86_64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Platform {
    pub os: Os,
    pub arch: Arch,
}

impl Platform {
    pub const fn new(os: Os, arch: Arch) -> Self {
        Self { os, arch }
    }

    /// The platform this binary was compiled for, if it is supported.
    pub fn current() -> Option<Self> {
        let os = if cfg!(target_os = "macos") {
            Os::MacOs
        } else if cfg!(target_os = "linux") {
            Os::Linux
        } else if cfg!(target_os = "windows") {
            Os::Windows
        } else {
            return None;
        };
        let arch = if cfg!(target_arch = "aarch64") {
            Arch::Aarch64
        } else if cfg!(target_arch = "x86_64") {
            Arch::X86_64
        } else {
            return None;
        };
        Some(Self { os, arch })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CatalogError {
    #[error("{server:?} has no pinned artifact for {platform:?}")]
    UnsupportedPlatform {
        server: ServerId,
        platform: Platform,
    },
    #[error("no Equinox launcher jar (org.eclipse.equinox.launcher_*.jar) in {0}")]
    MissingLauncher(PathBuf),
    #[error("{server:?} launch needs {what}")]
    MissingLaunchInput {
        server: ServerId,
        what: &'static str,
    },
    #[error("cannot read {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
}

/// Everything needed to build a [`LaunchSpec`]. Paths are passed through
/// verbatim as separate arguments; nothing is shell-interpolated.
#[derive(Debug, Clone)]
pub struct LaunchContext {
    /// The installed version directory (where the artifacts were extracted).
    pub install_dir: PathBuf,
    pub platform: Platform,
    /// Node or Java executable found by `runtime::detect_*`. Defaults to
    /// `node` / `java` from `PATH` when `None`.
    pub runtime_program: Option<PathBuf>,
    /// Major version of the Java runtime, used for the JDK 24+ XML limits that
    /// the JDTLS wrapper script adds.
    pub java_major: Option<u32>,
    /// JDTLS `-data` directory. Must be unique per workspace.
    pub workspace_dir: Option<PathBuf>,
    /// JDTLS `-configuration` directory. Must be writable and per user.
    pub config_dir: Option<PathBuf>,
}

impl LaunchContext {
    pub fn new(install_dir: impl Into<PathBuf>, platform: Platform) -> Self {
        Self {
            install_dir: install_dir.into(),
            platform,
            runtime_program: None,
            java_major: None,
            workspace_dir: None,
            config_dir: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

pub const ALL_SERVERS: [ServerId; 8] = [
    ServerId::Vtsls,
    ServerId::Html,
    ServerId::Css,
    ServerId::Json,
    ServerId::RustAnalyzer,
    ServerId::Basedpyright,
    ServerId::Jdtls,
    ServerId::Svelte,
];

/// Static description of one server.
pub fn spec(id: ServerId) -> ServerSpec {
    match id {
        ServerId::Vtsls => ServerSpec {
            id,
            display_name: "TypeScript (vtsls)",
            language_ids: &[
                "typescript",
                "typescriptreact",
                "javascript",
                "javascriptreact",
            ],
            extensions: &["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
            root_markers: &["tsconfig.json", "jsconfig.json", "package.json"],
            // `engines.node` of @vtsls/language-server 0.3.0 is ">=18".
            runtime: RuntimeRequirement {
                runtime: Runtime::Node,
                min_major: 18,
            },
            // vtsls reads its settings (`vtsls.*`, `typescript.*`) through
            // workspace/configuration and needs no initialization options
            // (https://github.com/yioneko/vtsls#readme).
            initialization_options: json!({}),
        },
        ServerId::Html => ServerSpec {
            id,
            display_name: "HTML",
            language_ids: &["html"],
            extensions: &["html", "htm"],
            root_markers: &["package.json", ".git"],
            runtime: vscode_ls_runtime(),
            // Keys read by htmlServer.js: `provideFormatter` enables the
            // formatting capabilities and `embeddedLanguages` enables the
            // embedded CSS and JavaScript modes. VS Code's client passes the
            // same shape:
            // https://github.com/microsoft/vscode/blob/main/extensions/html-language-features/client/src/htmlClient.ts
            initialization_options: json!({
                "provideFormatter": true,
                "embeddedLanguages": { "css": true, "javascript": true },
            }),
        },
        ServerId::Css => ServerSpec {
            id,
            display_name: "CSS, SCSS and Less",
            language_ids: &["css", "scss", "less"],
            extensions: &["css", "scss", "less"],
            root_markers: &["package.json", ".git"],
            runtime: vscode_ls_runtime(),
            // https://github.com/microsoft/vscode/blob/main/extensions/css-language-features/client/src/cssClient.ts
            initialization_options: json!({ "provideFormatter": true }),
        },
        ServerId::Json => ServerSpec {
            id,
            display_name: "JSON",
            language_ids: &["json", "jsonc"],
            extensions: &["json", "jsonc"],
            root_markers: &["package.json", ".git"],
            runtime: vscode_ls_runtime(),
            // `handledSchemaProtocols` tells the server it may only load
            // file-URI schemas itself, as in
            // https://github.com/microsoft/vscode/blob/main/extensions/json-language-features/client/src/jsonClient.ts
            initialization_options: json!({
                "provideFormatter": true,
                "handledSchemaProtocols": ["file"],
            }),
        },
        ServerId::RustAnalyzer => ServerSpec {
            id,
            display_name: "Rust (rust-analyzer)",
            language_ids: &["rust"],
            extensions: &["rs"],
            root_markers: &["Cargo.toml", "rust-project.json"],
            runtime: RuntimeRequirement {
                runtime: Runtime::None,
                min_major: 0,
            },
            // rust-analyzer takes its configuration as initializationOptions
            // (https://rust-analyzer.github.io/book/configuration.html). The
            // spec carries the permissive options; the manager asks
            // `initialization_options` for the ones to send.
            initialization_options: initialization_options(id, true),
        },
        ServerId::Basedpyright => ServerSpec {
            id,
            display_name: "Python (basedpyright)",
            language_ids: &["python"],
            extensions: &["py", "pyi"],
            root_markers: &[
                "pyrightconfig.json",
                "pyproject.toml",
                "setup.py",
                "setup.cfg",
                "requirements.txt",
            ],
            // `engines.node` of basedpyright 1.40.2 is ">=14.0.0".
            runtime: RuntimeRequirement {
                runtime: Runtime::Node,
                min_major: 14,
            },
            // The editor setup guide launches `basedpyright-langserver --stdio`
            // with no initialization options
            // (https://docs.basedpyright.com/latest/installation/ides/).
            initialization_options: json!({}),
        },
        ServerId::Svelte => ServerSpec {
            id,
            display_name: "Svelte",
            language_ids: &["svelte"],
            extensions: &["svelte"],
            root_markers: &[
                "svelte.config.js",
                "svelte.config.ts",
                "svelte.config.cjs",
                "svelte.config.mjs",
                "package.json",
            ],
            // `engines.node` of svelte-language-server 0.18.4 is ">= 18.0.0".
            runtime: RuntimeRequirement {
                runtime: Runtime::Node,
                min_major: 18,
            },
            // Started as `svelteserver --stdio`. It loads the project's own
            // `typescript` when there is one and otherwise the pinned copy.
            initialization_options: json!({}),
        },
        ServerId::Jdtls => ServerSpec {
            id,
            display_name: "Java (Eclipse JDT LS)",
            language_ids: &["java"],
            extensions: &["java"],
            root_markers: &[
                "pom.xml",
                "build.gradle",
                "build.gradle.kts",
                "settings.gradle",
                "settings.gradle.kts",
                ".project",
            ],
            // The README at tag v1.62.0 says "Java 21 (at a minimum)", but that
            // is stale for this build: the archive's
            // plugins/org.eclipse.core.filesystem_1.12.0.v20260927-0940.jar has
            // `Bundle-RequiredExecutionEnvironment: JavaSE-25`, and launching
            // with the catalog arguments on OpenJDK 21.0.13 fails with
            // `Unresolved requirement: osgi.ee ... (version=25)` and
            // "Application org.eclipse.jdt.ls.core.id1 could not be found".
            // The same arguments initialize successfully on OpenJDK 27.0.1.
            // JDK 25 itself was not available to test; 25 is the manifest value.
            runtime: RuntimeRequirement {
                runtime: Runtime::Java,
                min_major: 25,
            },
            // Documented shape of the initialize options:
            // https://github.com/eclipse-jdtls/eclipse.jdt.ls/wiki/Running-the-JAVA-LS-server-from-the-command-line#initialize-request
            // (`bundles`, `workspaceFolders`, `settings`). Workspace folders
            // are supplied by the client per project.
            initialization_options: initialization_options(id, true),
        },
    }
}

/// Options sent in `initialize`. rust-analyzer and JDT LS execute the project's own
/// build code as soon as they load it (build scripts, proc macros, `cargo check` on
/// save, the Gradle wrapper, Maven import), so unless `run_project_code` is true they
/// start in a restricted mode. Other servers ignore the flag.
///
/// rust-analyzer names: https://rust-analyzer.github.io/book/configuration.html
/// (`cargo.buildScripts.enable`, `cargo.buildScripts.rebuildOnSave`, `procMacro.enable`,
/// `checkOnSave`). JDT LS names: https://github.com/redhat-developer/vscode-java#readme
/// (`java.import.gradle.enabled`, `java.import.gradle.wrapper.enabled`,
/// `java.import.maven.enabled`, `java.autobuild.enabled`,
/// `java.configuration.updateBuildConfiguration`).
pub fn initialization_options(id: ServerId, run_project_code: bool) -> serde_json::Value {
    match id {
        ServerId::RustAnalyzer if !run_project_code => json!({
            "cargo": { "buildScripts": { "enable": false, "rebuildOnSave": false } },
            "procMacro": { "enable": false },
            "checkOnSave": false,
        }),
        ServerId::RustAnalyzer => json!({}),
        // Documented shape of the initialize options:
        // https://github.com/eclipse-jdtls/eclipse.jdt.ls/wiki/Running-the-JAVA-LS-server-from-the-command-line#initialize-request
        // (`bundles`, `workspaceFolders`, `settings`). Workspace folders are
        // supplied by the client per project.
        // `classFileContentsSupport` makes JDT LS answer definitions inside libraries with
        // `jdt://` URIs that `java/classFileContents` can read, instead of opening files.
        ServerId::Jdtls if !run_project_code => json!({
            "bundles": [],
            "extendedClientCapabilities": { "classFileContentsSupport": true },
            "settings": { "java": {
                // Off by default in JDT LS even though signatureHelpProvider is advertised.
                "signatureHelp": { "enabled": true },
                "import": {
                    "gradle": { "enabled": false, "wrapper": { "enabled": false } },
                    "maven": { "enabled": false },
                },
                "autobuild": { "enabled": false },
                "configuration": { "updateBuildConfiguration": "disabled" },
            } },
        }),
        ServerId::Jdtls => json!({
            "bundles": [],
            "extendedClientCapabilities": { "classFileContentsSupport": true },
            "settings": { "java": { "signatureHelp": { "enabled": true } } },
        }),
        // Servers whose spec options do not depend on the flag.
        _ => spec(id).initialization_options,
    }
}

/// `vscode-langservers-extracted` declares no `engines`; its loaded
/// dependencies require at least Node 14 (`vscode-jsonrpc`). Node 18 is the
/// conservative floor, shared with vtsls. Only verified on Node 22.
fn vscode_ls_runtime() -> RuntimeRequirement {
    RuntimeRequirement {
        runtime: Runtime::Node,
        min_major: 18,
    }
}

pub fn all_specs() -> Vec<ServerSpec> {
    ALL_SERVERS.iter().map(|id| spec(*id)).collect()
}

// ---------------------------------------------------------------------------
// File lookup
// ---------------------------------------------------------------------------

/// Maps a lowercase extension (no dot) to the owning server and LSP language id.
fn lookup_extension(ext: &str) -> Option<(ServerId, &'static str)> {
    Some(match ext {
        "ts" | "mts" | "cts" => (ServerId::Vtsls, "typescript"),
        "tsx" => (ServerId::Vtsls, "typescriptreact"),
        "js" | "mjs" | "cjs" => (ServerId::Vtsls, "javascript"),
        "jsx" => (ServerId::Vtsls, "javascriptreact"),
        "html" | "htm" => (ServerId::Html, "html"),
        "css" => (ServerId::Css, "css"),
        "scss" => (ServerId::Css, "scss"),
        "less" => (ServerId::Css, "less"),
        "json" => (ServerId::Json, "json"),
        "jsonc" => (ServerId::Json, "jsonc"),
        "rs" => (ServerId::RustAnalyzer, "rust"),
        "py" | "pyi" => (ServerId::Basedpyright, "python"),
        "java" => (ServerId::Jdtls, "java"),
        "svelte" => (ServerId::Svelte, "svelte"),
        _ => return None,
    })
}

/// Server and LSP language id for a file path, by case-insensitive extension.
pub fn lookup_path(path: &Path) -> Option<(ServerId, &'static str)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    lookup_extension(&ext)
}

pub fn server_for_path(path: &Path) -> Option<ServerId> {
    lookup_path(path).map(|(id, _)| id)
}

pub fn language_id_for_path(path: &Path) -> Option<&'static str> {
    lookup_path(path).map(|(_, lang)| lang)
}

// ---------------------------------------------------------------------------
// Install plans
// ---------------------------------------------------------------------------

struct NpmPackage {
    name: &'static str,
    version: &'static str,
    sha256: &'static str,
    /// Installs under `node_modules/<parent>/node_modules/` when npm could not flatten this copy.
    parent: Option<&'static str>,
}

impl NpmPackage {
    fn url(&self) -> String {
        let base = self.name.rsplit('/').next().unwrap_or(self.name);
        format!(
            "https://registry.npmjs.org/{}/-/{}-{}.tgz",
            self.name, base, self.version
        )
    }
}

/// Complete flat closure of `@vtsls/language-server@0.3.0`, resolved with
/// `npm install --package-lock-only --before=2026-10-14`. The
/// `vscode-languageserver*` packages are pinned to the 9.0.1 generation
/// (jsonrpc 8.2.0, protocol and types 3.17.5) so a single flat copy satisfies
/// both vtsls and `@vtsls/language-service`.
#[rustfmt::skip]
const VTSLS_PACKAGES: &[NpmPackage] = &[
    NpmPackage { name: "@vscode/l10n", version: "0.0.18", sha256: "f1c2dc897488595f6bb42121869f525c6c6a5f7c8dca550754199c3251ed7c5c", parent: None },
    NpmPackage { name: "@vtsls/language-server", version: "0.3.0", sha256: "f065ff01476d71395caad2647fb56539bb80131f37081767b2aeee8586cbc0c9", parent: None },
    NpmPackage { name: "@vtsls/language-service", version: "0.3.0", sha256: "08a4e8db21dc3c9be7080952cd5226932f578512e71b0bf2fd81c7f8af9401c5", parent: None },
    NpmPackage { name: "@vtsls/vscode-fuzzy", version: "0.1.0", sha256: "3a04faaa2b0df05b4ece5bc3ff4d2316023d661b028ab15d4aa3f2f13b2a7d8a", parent: None },
    NpmPackage { name: "jsonc-parser", version: "3.3.1", sha256: "4a0315b8671e7463bae7af7c142cdf19e9aa7ba39eb36dc2df383b8648e3cbc9", parent: None },
    NpmPackage { name: "lru-cache", version: "6.0.0", sha256: "5ce40deb031cf6968f3832502a68f8d26be09764dc4f8fc07957a2fd7e8cdf5e", parent: None },
    NpmPackage { name: "semver", version: "7.5.2", sha256: "32f78290c12246206449f9a18cf3f7fab44828f06c17448b7e8954ff54ce0a9a", parent: None },
    NpmPackage { name: "typescript", version: "5.9.3", sha256: "10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3", parent: None },
    NpmPackage { name: "vscode-jsonrpc", version: "8.2.0", sha256: "3da44531c398f1545074cb728e359a822f35b9f8ac7171c847f42f0728b9c7cb", parent: None },
    NpmPackage { name: "vscode-languageserver", version: "9.0.1", sha256: "6cd7f463ae7872e588a4dd5ed5149475fe32e53517509a81e715eb0540602412", parent: None },
    NpmPackage { name: "vscode-languageserver-protocol", version: "3.17.5", sha256: "7473eb2d2163f3f8bea09644f9d803789a195e596b65d3946c4157e583e3ccc8", parent: None },
    NpmPackage { name: "vscode-languageserver-textdocument", version: "1.0.15", sha256: "2a133b20d5c5b1ff6d8627c628807c28d771b8741c8c6fca2aef3dd77cac669c", parent: None },
    NpmPackage { name: "vscode-languageserver-types", version: "3.17.5", sha256: "d673f9e7f8bbe51351be51c58f32d4dcfa97a670ebb86bc633368394c609cac0", parent: None },
    NpmPackage { name: "vscode-uri", version: "3.2.0", sha256: "12fa4a47728ca404c3a679e351eda6c54030c8ed3dd9bc6762ab0be1bf04014b", parent: None },
    NpmPackage { name: "yallist", version: "4.0.0", sha256: "a80c78aa276536615891ef66efbc17d3bd07c8cb14e3bd5298eed3006bfa4d49", parent: None },
];

/// Complete flat closure of `vscode-langservers-extracted@4.10.0`, resolved with
/// `--before=2026-10-14`. npm nests a second `vscode-languageserver-types`
/// 3.17.5 under `vscode-css-languageservice`; the flat installer cannot express
/// that, so 3.18.4 (required by `vscode-languageserver-protocol` 3.18.4) serves
/// everyone. A completion request against the CSS server was verified to work
/// in that layout. `typescript` 4.9.5 is required at load time by the HTML
/// server's embedded JavaScript mode.
#[rustfmt::skip]
const VSCODE_LS_PACKAGES: &[NpmPackage] = &[
    NpmPackage { name: "@vscode/l10n", version: "0.0.18", sha256: "f1c2dc897488595f6bb42121869f525c6c6a5f7c8dca550754199c3251ed7c5c", parent: None },
    NpmPackage { name: "boolbase", version: "1.0.0", sha256: "69628ff8092c5ff940ea4a0f29da98d520615bae138755c9e059033606c6caa8", parent: None },
    NpmPackage { name: "core-js", version: "3.50.0", sha256: "fc99658f513a6ff0292e5680a48c01fc86d709b316dc96cffef4697ff8fe38c5", parent: None },
    NpmPackage { name: "css-select", version: "5.2.2", sha256: "ab3c2a9c47abc354e4bb539f66746da87c80ed9e9623f4b0940147d0a1b2ae75", parent: None },
    NpmPackage { name: "css-what", version: "6.2.2", sha256: "275ef51d6c04b5f6e2441d73fa3503c5ac525cd82ef4ca55f022eeacaf227ab0", parent: None },
    NpmPackage { name: "dom-serializer", version: "2.0.0", sha256: "e34511f144fc6b34ce536bd60fb1ed27dd965f07a7c317407e79dd6be9e8f399", parent: None },
    NpmPackage { name: "domelementtype", version: "2.3.0", sha256: "c67164b4a994eaeaecbd968c2e5e5415407ae6fb4486bbb470594154e25feb45", parent: None },
    NpmPackage { name: "domhandler", version: "5.0.3", sha256: "f3952abb7e2635d8e942822d68cfb1fdaba61148d17a1a5692bdd163d6ca4784", parent: None },
    NpmPackage { name: "domutils", version: "3.2.2", sha256: "272918a13e7e093ddc983666954164e098fb2443f06f476f34bf47005e12c140", parent: None },
    NpmPackage { name: "entities", version: "4.5.0", sha256: "6b0c60f7351a0b65bb1fc8dbb9299f09e7ecf6d89103d0651bf369e6f463a632", parent: None },
    NpmPackage { name: "he", version: "1.2.0", sha256: "777a7c030c1b6c0bbe8638136dcc5cedbb36b1082f821b06648de5d7d11c1b68", parent: None },
    NpmPackage { name: "jsonc-parser", version: "3.3.1", sha256: "4a0315b8671e7463bae7af7c142cdf19e9aa7ba39eb36dc2df383b8648e3cbc9", parent: None },
    NpmPackage { name: "node-html-parser", version: "6.1.13", sha256: "333e55a8f4ebdaf60126f796295dca085cd088899282180782dd38a4ea9295b7", parent: None },
    NpmPackage { name: "nth-check", version: "2.1.1", sha256: "45dc0a2bc34205656c0fbe8374c725c04b71b40e739b74c9fc763480c8063642", parent: None },
    NpmPackage { name: "picomatch", version: "2.3.2", sha256: "4c843ba015bec815ac52116162559ab7b4b4efbd3b86f7fcf38f3d770decace6", parent: None },
    NpmPackage { name: "regenerator-runtime", version: "0.13.11", sha256: "96a0a849ceb83d2cd717d775dc60ddb7c2384564f76a75d0d1e6849af04c2b8c", parent: None },
    NpmPackage { name: "request-light", version: "0.7.0", sha256: "15d60d0da12c1e9eff0bc8f0f00417e760b672165fe9a77b64639de29285ace5", parent: None },
    NpmPackage { name: "semver", version: "7.8.5", sha256: "d85045d4300d7d57c891336b95df532e73f34c22ffcd222452b6d08b9d127d5d", parent: None },
    NpmPackage { name: "typescript", version: "4.9.5", sha256: "6e2faae079c9047aa921e8a307f0cec0da4dc4853e20bb31d18acc678f5bf505", parent: None },
    NpmPackage { name: "vscode-css-languageservice", version: "6.3.10", sha256: "75dfff4a7b2a9b8df08c17d5444a8224a3701e29fc30c2539db12a7a9ffc9448", parent: None },
    NpmPackage { name: "vscode-html-languageservice", version: "5.6.2", sha256: "a519e4029da8cf4d7d4cf6d882307038635f203c505862a4ef68f18fa194322a", parent: None },
    NpmPackage { name: "vscode-json-languageservice", version: "5.7.2", sha256: "18dc41edc48bdcab2da866a5b5f53956ee722b66fffe9d89740d04ba7f505459", parent: None },
    NpmPackage { name: "vscode-jsonrpc", version: "9.0.3", sha256: "282d3d574a565ab9bea0af6518eadac91221dfd0cd55cfd308662b816a7920a7", parent: None },
    NpmPackage { name: "vscode-langservers-extracted", version: "4.10.0", sha256: "d6e2d090d09c4b91daa74e9e7462a3d3f244efb96aa5111004cfffa49d6dc9ef", parent: None },
    NpmPackage { name: "vscode-languageserver", version: "10.1.2", sha256: "991c66235ffb604630599a611bbd888768468f4707a6fb8691a977cf72bb286b", parent: None },
    NpmPackage { name: "vscode-languageserver-protocol", version: "3.18.4", sha256: "76ff8f83f7f1bac53e351cd30740ff75610277b65b4043141d359660d88f0dcd", parent: None },
    NpmPackage { name: "vscode-languageserver-textdocument", version: "1.0.15", sha256: "2a133b20d5c5b1ff6d8627c628807c28d771b8741c8c6fca2aef3dd77cac669c", parent: None },
    NpmPackage { name: "vscode-languageserver-types", version: "3.18.4", sha256: "83c119b73d1895194087e9376d0916161b5550c210e9e892b65a3e04a43ea68e", parent: None },
    NpmPackage { name: "vscode-markdown-languageservice", version: "0.5.0", sha256: "68301a155c1fffe17ec4ae97a62d6e600aa6e536d4acfbf059547af06a24a55c", parent: None },
    NpmPackage { name: "vscode-nls", version: "5.2.0", sha256: "441f95396ae52a4eff2f69770219a522ed13dc0ba69deb982ac9456eda9ca779", parent: None },
    NpmPackage { name: "vscode-uri", version: "3.2.0", sha256: "12fa4a47728ca404c3a679e351eda6c54030c8ed3dd9bc6762ab0be1bf04014b", parent: None },
];

const BASEDPYRIGHT_PACKAGES: &[NpmPackage] = &[NpmPackage {
    name: "basedpyright",
    version: "1.40.2",
    sha256: "5d1073a0e61a1adc6b40b2bed4489017aa5c1336aa8e6fdcb7157b9bf26f3fab",
    parent: None,
}];

/// Complete closure of `svelte-language-server@0.18.4`, resolved with
/// `npm install --package-lock-only --before=2026-10-14 --omit=optional`, plus
/// `typescript` 5.9.3 for its peer dependency. npm nests `estree-walker` 3.0.3
/// under `code-red`, `periscopic` and `svelte` (the server itself needs 2.0.2)
/// and `vscode-uri` 2.1.2 under `@vscode/emmet-helper`, so those carry a parent.
#[rustfmt::skip]
const SVELTE_PACKAGES: &[NpmPackage] = &[
    NpmPackage { name: "@ampproject/remapping", version: "2.3.0", sha256: "f8bf712008656c5abc83dd859463cba3193c76f4cd1fe8ad3637f7ae18bfd368", parent: None },
    NpmPackage { name: "@emmetio/abbreviation", version: "2.3.3", sha256: "04bf8598f3667f6391dd71e785d7d236406f9483266aad82d3078425aedd76b8", parent: None },
    NpmPackage { name: "@emmetio/css-abbreviation", version: "2.1.8", sha256: "ebdf10502278bc7455e64829670a21872f52c7fbdfcf8b4c5e3a3df55815223b", parent: None },
    NpmPackage { name: "@emmetio/scanner", version: "1.0.4", sha256: "1e9aab50b22abc1e8cca5fc535fcace154e0d8852fd68d05f6e0bbdf0899acc9", parent: None },
    NpmPackage { name: "@jridgewell/gen-mapping", version: "0.3.13", sha256: "bc16f658c1f6d63e0c8738ab881d03f49f1955d8f853cdcb8f7d315cf62f0082", parent: None },
    NpmPackage { name: "@jridgewell/resolve-uri", version: "3.1.2", sha256: "db52f9f62558baab13353dd39e3200750fc33e6a129a575b46226f493776e230", parent: None },
    NpmPackage { name: "@jridgewell/sourcemap-codec", version: "1.6.0", sha256: "f30a35f6af8c347d01b8ff2f8662272f7d986cf21b916704d86c249a90b97e25", parent: None },
    NpmPackage { name: "@jridgewell/trace-mapping", version: "0.3.31", sha256: "c64c71a119630d5abe8246889edf334b2ca9ddad094e20d623332956b1453ccf", parent: None },
    NpmPackage { name: "@sveltejs/load-config", version: "0.2.3", sha256: "9ac0d7d00e3464f83e963be24fbd841fa76d18f3da526416c4e45d1f0d7072c9", parent: None },
    NpmPackage { name: "@types/estree", version: "1.0.9", sha256: "ec8f3c0dfb21497db5a3480c45a6cf6f9b18d3b337b2ea4d03e3ef2a9c2bb358", parent: None },
    NpmPackage { name: "@vscode/emmet-helper", version: "2.8.4", sha256: "e6bca0a373217610c5f9e14be9e2d4f7ae8446d3263046e86458f6884e7aed25", parent: None },
    NpmPackage { name: "@vscode/l10n", version: "0.0.18", sha256: "f1c2dc897488595f6bb42121869f525c6c6a5f7c8dca550754199c3251ed7c5c", parent: None },
    NpmPackage { name: "acorn", version: "8.19.0", sha256: "c6fad21ffa1f2ba20338bf1dde1de911c2093c1aaf7b3af17c477661bd3bfaaf", parent: None },
    NpmPackage { name: "aria-query", version: "5.3.2", sha256: "62691953222d8acef97db2daa0e84adedc8eb6b074c33ec02367291a32e4ad37", parent: None },
    NpmPackage { name: "axobject-query", version: "4.1.0", sha256: "040d97829212e5e9f48fb4069ca38d2d23b34d4e65b7c7cab2a55ae3546c8d02", parent: None },
    NpmPackage { name: "chokidar", version: "4.0.3", sha256: "61a29da9d314c2cd33a7be7327014814c4620673e3d4be41b120aa8544868389", parent: None },
    NpmPackage { name: "code-red", version: "1.0.4", sha256: "ecc9372e40cdf07ce5290ad39147868fa1e9dd40fa1cd5ae3681afe6be0b1e2c", parent: None },
    NpmPackage { name: "css-tree", version: "2.3.1", sha256: "097d010f1a3c9d61950656509b0b9e3eba27bf34f3ec2faeb3fee8967789deac", parent: None },
    NpmPackage { name: "dedent-js", version: "1.0.1", sha256: "9327b727b36079843be7ddab1330ca9a5e5b3ed334ef7d199b5c4ab638aa9dd5", parent: None },
    NpmPackage { name: "defu", version: "6.1.7", sha256: "c9a6777f6837633e4eba91ed78dbd0be2d27ab0d9c53948dac6b927c819fbcd3", parent: None },
    NpmPackage { name: "emmet", version: "2.4.11", sha256: "11867ac4d973092529c5e37e40d7a85b5f39de36e485885e73f5a88302780f20", parent: None },
    NpmPackage { name: "estree-walker", version: "2.0.2", sha256: "302931e539a9c5568d56634119290c4df9a7bde64a2f2dbc646d6013e3b03c58", parent: None },
    NpmPackage { name: "estree-walker", version: "3.0.3", sha256: "bbbdfdc16cd9ef099e474f55a4aa344103c01853727136a76ee165fa9d1c72b3", parent: Some("code-red") },
    NpmPackage { name: "estree-walker", version: "3.0.3", sha256: "bbbdfdc16cd9ef099e474f55a4aa344103c01853727136a76ee165fa9d1c72b3", parent: Some("periscopic") },
    NpmPackage { name: "estree-walker", version: "3.0.3", sha256: "bbbdfdc16cd9ef099e474f55a4aa344103c01853727136a76ee165fa9d1c72b3", parent: Some("svelte") },
    NpmPackage { name: "fdir", version: "6.5.0", sha256: "241ddcd9f31e2a1fca405326017dbb8333ce174198e887f0f96387c29f0d365e", parent: None },
    NpmPackage { name: "globrex", version: "0.1.2", sha256: "cb8c2f6bc5d54fcd7a6a39f6efb964eba510768e61ca34e079062ca69ff56160", parent: None },
    NpmPackage { name: "is-reference", version: "3.0.3", sha256: "ca4b7634e99eb3e05df043785e554fd6c0bd28197dd9722445c4193a660f33f0", parent: None },
    NpmPackage { name: "jsonc-parser", version: "2.3.1", sha256: "b0a8126281d0bfca3a647661f6aacf9630d658adfc15b196fff58c81e3f1ab8c", parent: None },
    NpmPackage { name: "locate-character", version: "3.0.0", sha256: "a7925696d7983216a5d4f0383fbcf87b63a9bb36bca205d40fc4ccba1db12585", parent: None },
    NpmPackage { name: "magic-string", version: "0.30.21", sha256: "fa49762567dca44e8ccf327f365d250e04c482bf7a4ed0ae7d03659b09ac656f", parent: None },
    NpmPackage { name: "mdn-data", version: "2.0.30", sha256: "27e3f501292aad8191b471c5c63363463bc38b50314f1db7364a714384c3b118", parent: None },
    NpmPackage { name: "periscopic", version: "3.1.0", sha256: "3c0a7f89d0ddd0112c2f69c906b0017a115c85534feb269ed7c0900045887474", parent: None },
    NpmPackage { name: "prettier", version: "3.3.3", sha256: "2f1ecb0ab57a588e0d4d40d3d45239e71ebd8f0190199d0d3f87fe2283639f46", parent: None },
    NpmPackage { name: "prettier-plugin-svelte", version: "3.5.2", sha256: "bcda479679243902710d35e72b47598cb43f717b6cd5962dcef82ed1a18a8196", parent: None },
    NpmPackage { name: "readdirp", version: "4.1.2", sha256: "766ea2ba6314aefe6b939c9bbe3999cc473286578aeb1c3805338c2dbd655f5a", parent: None },
    NpmPackage { name: "scule", version: "1.3.0", sha256: "900aa1856e902a53de587ba5e302e188b060ddc854691610045e3c2a8b01f8d7", parent: None },
    NpmPackage { name: "semver", version: "7.8.5", sha256: "d85045d4300d7d57c891336b95df532e73f34c22ffcd222452b6d08b9d127d5d", parent: None },
    NpmPackage { name: "source-map-js", version: "1.2.2", sha256: "05c8cf8e7c3a6b56cada7668fe9342b10f4b625efc92aba9ba05b9e8fe4d71a3", parent: None },
    NpmPackage { name: "svelte", version: "4.2.20", sha256: "17297670baa34da702204e0620d073359ec085450acb3791e42699b46fff48de", parent: None },
    NpmPackage { name: "svelte-language-server", version: "0.18.4", sha256: "3700f0d4af450fd898efd90b29ab7f0c9f5a5c7e8967f5c2cebf528a18341757", parent: None },
    NpmPackage { name: "svelte2tsx", version: "0.7.61", sha256: "a0d9c83b60cd0c88a722893c153c2b7fcf290e043dda983f679e4093bf77a173", parent: None },
    NpmPackage { name: "typescript", version: "5.9.3", sha256: "10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3", parent: None },
    NpmPackage { name: "typescript-auto-import-cache", version: "0.3.6", sha256: "4c4544e27c84b86f816145f192ccc66f5654c10c964c558fcecdefb067b6a17e", parent: None },
    NpmPackage { name: "vscode-css-languageservice", version: "6.3.10", sha256: "75dfff4a7b2a9b8df08c17d5444a8224a3701e29fc30c2539db12a7a9ffc9448", parent: None },
    NpmPackage { name: "vscode-html-languageservice", version: "5.4.0", sha256: "20d043ab542818ba75dfe81d93a02e8073177cc4354aa04de7ccca8cdfe408e0", parent: None },
    NpmPackage { name: "vscode-jsonrpc", version: "8.2.0", sha256: "3da44531c398f1545074cb728e359a822f35b9f8ac7171c847f42f0728b9c7cb", parent: None },
    NpmPackage { name: "vscode-languageserver", version: "9.0.1", sha256: "6cd7f463ae7872e588a4dd5ed5149475fe32e53517509a81e715eb0540602412", parent: None },
    NpmPackage { name: "vscode-languageserver-protocol", version: "3.17.5", sha256: "7473eb2d2163f3f8bea09644f9d803789a195e596b65d3946c4157e583e3ccc8", parent: None },
    NpmPackage { name: "vscode-languageserver-textdocument", version: "1.0.15", sha256: "2a133b20d5c5b1ff6d8627c628807c28d771b8741c8c6fca2aef3dd77cac669c", parent: None },
    NpmPackage { name: "vscode-languageserver-types", version: "3.17.5", sha256: "d673f9e7f8bbe51351be51c58f32d4dcfa97a670ebb86bc633368394c609cac0", parent: None },
    NpmPackage { name: "vscode-nls", version: "5.2.0", sha256: "441f95396ae52a4eff2f69770219a522ed13dc0ba69deb982ac9456eda9ca779", parent: None },
    NpmPackage { name: "vscode-uri", version: "3.1.0", sha256: "c6ec752d7a4858237389b23fb4d5ac05c2f1f606071cd212a9b54730e43cfc54", parent: None },
    NpmPackage { name: "vscode-uri", version: "2.1.2", sha256: "35387265515bcd64fbd5b070081a5d97421b56eb0217a5565a8e0c3ae24abc76", parent: Some("@vscode/emmet-helper") },
];
pub const SVELTE_VERSION: &str = "0.18.4";
const SVELTE_ENTRY: &str = "node_modules/svelte-language-server/bin/server.js";

pub const VTSLS_VERSION: &str = "0.3.0";
pub const VSCODE_LS_VERSION: &str = "4.10.0";
pub const RUST_ANALYZER_VERSION: &str = "2026-10-12";
pub const BASEDPYRIGHT_VERSION: &str = "1.40.2";
pub const JDTLS_VERSION: &str = "1.62.0-202610131109";

/// Script run by node for each npm-based server, relative to the install dir.
const VTSLS_ENTRY: &str = "node_modules/@vtsls/language-server/bin/vtsls.js";
const HTML_ENTRY: &str =
    "node_modules/vscode-langservers-extracted/bin/vscode-html-language-server";
const CSS_ENTRY: &str = "node_modules/vscode-langservers-extracted/bin/vscode-css-language-server";
const JSON_ENTRY: &str =
    "node_modules/vscode-langservers-extracted/bin/vscode-json-language-server";
const BASEDPYRIGHT_ENTRY: &str = "node_modules/basedpyright/langserver.index.js";

/// Equinox launcher jar named by the pinned archive; it is also located by
/// pattern at launch time.
const JDTLS_LAUNCHER_ENTRY: &str = "plugins/org.eclipse.equinox.launcher_1.8.0.v20260804-1928.jar";
const JDTLS_URL: &str = "https://download.eclipse.org/jdtls/milestones/1.62.0/jdt-language-server-1.62.0-202610131109.tar.gz";
const JDTLS_SHA256: &str = "f587dafd8410633c2c2bf005e853a2bbb03cddee88933d49bfe6d9cb1cf09342";

fn npm_plan(version: &str, packages: &[NpmPackage], primary: &str, entry: &str) -> InstallPlan {
    let mut artifacts = Vec::with_capacity(packages.len());
    let mut ordered: Vec<&NpmPackage> = packages.iter().collect();
    // The server's own package goes first.
    // Copies nested under another package go last so the parent is placed first.
    ordered.sort_by_key(|p| (p.name != primary, p.parent.is_some()));
    for p in ordered {
        artifacts.push(Artifact {
            url: p.url(),
            sha256: p.sha256.to_string(),
            kind: ArtifactKind::NpmTarball,
            entry: if p.name == primary {
                entry.to_string()
            } else if let Some(parent) = p.parent {
                format!("node_modules/{parent}/node_modules/{}/package.json", p.name)
            } else {
                format!("node_modules/{}/package.json", p.name)
            },
            parent: p.parent.map(str::to_string),
        });
    }
    InstallPlan {
        version: version.to_string(),
        artifacts,
    }
}

fn rust_analyzer_plan(platform: Platform) -> Result<InstallPlan, CatalogError> {
    let (triple, sha256, zip) = match (platform.os, platform.arch) {
        (Os::MacOs, Arch::Aarch64) => (
            "aarch64-apple-darwin",
            "a2e45e828b37bfc4b507c2ca456e8b61096e0bdfbae225f3d33295546d1eeacf",
            false,
        ),
        (Os::MacOs, Arch::X86_64) => (
            "x86_64-apple-darwin",
            "56a5698a2e0d495c3ec28155416db310c879f21a70f6f38db549166cf157cfab",
            false,
        ),
        (Os::Linux, Arch::Aarch64) => (
            "aarch64-unknown-linux-gnu",
            "d7219d5d8f5537bb227b521157aebddfe7e4a90f4a85a74f31e53722f5691025",
            false,
        ),
        (Os::Linux, Arch::X86_64) => (
            "x86_64-unknown-linux-gnu",
            "040cab4e2abc490fadd95c3f6cbc60b941a78761dbc3acf0ec66fd7a97f31db3",
            false,
        ),
        (Os::Windows, Arch::Aarch64) => (
            "aarch64-pc-windows-msvc",
            "b053585692c2848acfa8e9ddf5f85bdc3741f3b23c51b72717ba0b391910b5fe",
            true,
        ),
        (Os::Windows, Arch::X86_64) => (
            "x86_64-pc-windows-msvc",
            "77f7a907f0e6f179281bac38e2d08435c974db9a5b99de52c5c963aff52883ec",
            true,
        ),
    };
    let ext = if zip { "zip" } else { "gz" };
    Ok(InstallPlan {
        version: RUST_ANALYZER_VERSION.to_string(),
        artifacts: vec![Artifact {
            url: format!(
                "https://github.com/rust-lang/rust-analyzer/releases/download/{RUST_ANALYZER_VERSION}/rust-analyzer-{triple}.{ext}"
            ),
            sha256: sha256.to_string(),
            kind: if zip {
                ArtifactKind::Zip
            } else {
                ArtifactKind::Gz
            },
            entry: rust_analyzer_entry(platform).to_string(),
parent: None,
}],
    })
}

fn rust_analyzer_entry(platform: Platform) -> &'static str {
    if platform.os == Os::Windows {
        "rust-analyzer.exe"
    } else {
        "rust-analyzer"
    }
}

/// The pinned install plan for `id` on `platform`.
///
/// The npm-based servers are platform independent. `Result` is kept for
/// platforms a future server may not support.
pub fn install_plan(id: ServerId, platform: Platform) -> Result<InstallPlan, CatalogError> {
    Ok(match id {
        ServerId::Vtsls => npm_plan(
            VTSLS_VERSION,
            VTSLS_PACKAGES,
            "@vtsls/language-server",
            VTSLS_ENTRY,
        ),
        ServerId::Html => npm_plan(
            VSCODE_LS_VERSION,
            VSCODE_LS_PACKAGES,
            "vscode-langservers-extracted",
            HTML_ENTRY,
        ),
        ServerId::Css => npm_plan(
            VSCODE_LS_VERSION,
            VSCODE_LS_PACKAGES,
            "vscode-langservers-extracted",
            CSS_ENTRY,
        ),
        ServerId::Json => npm_plan(
            VSCODE_LS_VERSION,
            VSCODE_LS_PACKAGES,
            "vscode-langservers-extracted",
            JSON_ENTRY,
        ),
        ServerId::Basedpyright => npm_plan(
            BASEDPYRIGHT_VERSION,
            BASEDPYRIGHT_PACKAGES,
            "basedpyright",
            BASEDPYRIGHT_ENTRY,
        ),
        ServerId::Svelte => npm_plan(
            SVELTE_VERSION,
            SVELTE_PACKAGES,
            "svelte-language-server",
            SVELTE_ENTRY,
        ),
        ServerId::RustAnalyzer => return rust_analyzer_plan(platform),
        ServerId::Jdtls => InstallPlan {
            version: JDTLS_VERSION.to_string(),
            artifacts: vec![Artifact {
                url: JDTLS_URL.to_string(),
                sha256: JDTLS_SHA256.to_string(),
                kind: ArtifactKind::TarGz,
                entry: JDTLS_LAUNCHER_ENTRY.to_string(),
                parent: None,
            }],
        },
    })
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

fn node_launch(ctx: &LaunchContext, entry: &str) -> LaunchSpec {
    LaunchSpec {
        program: ctx
            .runtime_program
            .clone()
            .unwrap_or_else(|| PathBuf::from("node")),
        args: vec![
            ctx.install_dir.join(entry).to_string_lossy().into_owned(),
            "--stdio".to_string(),
        ],
        env: Vec::new(),
    }
}

/// Finds the Equinox launcher jar in `<install_dir>/plugins` by pattern,
/// mirroring `find_equinox_launcher` in the archive's `bin/jdtls.py`:
/// `org.eclipse.equinox.launcher.jar` first, then `org.eclipse.equinox.launcher_*.jar`.
/// Platform fragments (`org.eclipse.equinox.launcher.gtk...`) do not match.
pub fn find_equinox_launcher(install_dir: &Path) -> Result<PathBuf, CatalogError> {
    let plugins = install_dir.join("plugins");
    let plain = plugins.join("org.eclipse.equinox.launcher.jar");
    if plain.is_file() {
        return Ok(plain);
    }
    let rd = fs::read_dir(&plugins).map_err(|source| CatalogError::Io {
        path: plugins.clone(),
        source,
    })?;
    let mut found: Vec<PathBuf> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("org.eclipse.equinox.launcher_") && n.ends_with(".jar"))
                .unwrap_or(false)
        })
        .collect();
    found.sort();
    found.pop().ok_or(CatalogError::MissingLauncher(plugins))
}

/// Shared (read-only) configuration directory name inside the JDTLS archive.
/// Each `config_*_arm` directory lists the aarch64 launcher fragment, the others
/// list the x86_64 one (checked in the pinned archive's `config.ini` files).
pub fn jdtls_config_dir_name(platform: Platform) -> &'static str {
    match (platform.os, platform.arch) {
        (Os::MacOs, Arch::Aarch64) => "config_mac_arm",
        (Os::MacOs, Arch::X86_64) => "config_mac",
        (Os::Linux, Arch::Aarch64) => "config_linux_arm",
        (Os::Linux, Arch::X86_64) => "config_linux",
        (Os::Windows, _) => "config_win",
    }
}

fn jdtls_launch(ctx: &LaunchContext) -> Result<LaunchSpec, CatalogError> {
    let workspace = ctx
        .workspace_dir
        .as_ref()
        .ok_or(CatalogError::MissingLaunchInput {
            server: ServerId::Jdtls,
            what: "a workspace data directory (-data)",
        })?;
    let config = ctx
        .config_dir
        .as_ref()
        .ok_or(CatalogError::MissingLaunchInput {
            server: ServerId::Jdtls,
            what: "a writable configuration directory (-configuration)",
        })?;
    let launcher = find_equinox_launcher(&ctx.install_dir)?;
    let shared = ctx.install_dir.join(jdtls_config_dir_name(ctx.platform));
    let s = |p: &Path| p.to_string_lossy().into_owned();

    // Same flags and order as `exec_args` in the archive's bin/jdtls.py, which
    // runs the shared config read-only and cascades a per-user configuration.
    let mut args: Vec<String> = Vec::new();
    if ctx.java_major.unwrap_or(0) >= 24 {
        args.push("-Djdk.xml.maxGeneralEntitySizeLimit=0".into());
        args.push("-Djdk.xml.totalEntitySizeLimit=0".into());
    }
    args.extend(
        [
            "-Declipse.application=org.eclipse.jdt.ls.core.id1",
            "-Dosgi.bundles.defaultStartLevel=4",
            "-Declipse.product=org.eclipse.jdt.ls.core.product",
            "-Dosgi.checkConfiguration=true",
        ]
        .map(String::from),
    );
    args.push(format!("-Dosgi.sharedConfiguration.area={}", s(&shared)));
    args.extend(
        [
            "-Dosgi.sharedConfiguration.area.readOnly=true",
            "-Dosgi.configuration.cascaded=true",
            "-Xms1G",
            "--add-modules=ALL-SYSTEM",
            "--add-opens",
            "java.base/java.util=ALL-UNNAMED",
            "--add-opens",
            "java.base/java.lang=ALL-UNNAMED",
            "-jar",
        ]
        .map(String::from),
    );
    args.push(s(&launcher));
    args.push("-configuration".into());
    args.push(s(config));
    args.push("-data".into());
    args.push(s(workspace));

    Ok(LaunchSpec {
        program: ctx
            .runtime_program
            .clone()
            .unwrap_or_else(|| PathBuf::from("java")),
        args,
        env: Vec::new(),
    })
}

/// Builds the explicit-argv launch description for `id`.
pub fn launch_spec(id: ServerId, ctx: &LaunchContext) -> Result<LaunchSpec, CatalogError> {
    match id {
        ServerId::Vtsls => Ok(node_launch(ctx, VTSLS_ENTRY)),
        ServerId::Html => Ok(node_launch(ctx, HTML_ENTRY)),
        ServerId::Css => Ok(node_launch(ctx, CSS_ENTRY)),
        ServerId::Json => Ok(node_launch(ctx, JSON_ENTRY)),
        ServerId::Basedpyright => Ok(node_launch(ctx, BASEDPYRIGHT_ENTRY)),
        ServerId::Svelte => Ok(node_launch(ctx, SVELTE_ENTRY)),
        ServerId::RustAnalyzer => Ok(LaunchSpec {
            program: ctx.install_dir.join(rust_analyzer_entry(ctx.platform)),
            args: Vec::new(),
            env: Vec::new(),
        }),
        ServerId::Jdtls => jdtls_launch(ctx),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAC_ARM: Platform = Platform::new(Os::MacOs, Arch::Aarch64);

    #[test]
    fn project_code_options_are_restricted_unless_allowed() {
        let ra = initialization_options(ServerId::RustAnalyzer, false);
        assert_eq!(ra["cargo"]["buildScripts"]["enable"], false);
        assert_eq!(ra["procMacro"]["enable"], false);
        assert_eq!(ra["checkOnSave"], false);
        assert_eq!(
            initialization_options(ServerId::RustAnalyzer, true),
            json!({})
        );
        let java = initialization_options(ServerId::Jdtls, false);
        assert_eq!(
            java["settings"]["java"]["import"]["maven"]["enabled"],
            false
        );
        assert_eq!(java["settings"]["java"]["autobuild"]["enabled"], false);
        assert_eq!(
            initialization_options(ServerId::Jdtls, true)["settings"]["java"],
            json!({ "signatureHelp": { "enabled": true } })
        );
        // The spec carries the permissive options; other servers ignore the flag.
        assert_eq!(
            spec(ServerId::RustAnalyzer).initialization_options,
            json!({})
        );
        for id in [
            ServerId::Vtsls,
            ServerId::Html,
            ServerId::Css,
            ServerId::Json,
            ServerId::Basedpyright,
        ] {
            assert_eq!(
                initialization_options(id, false),
                initialization_options(id, true)
            );
        }
    }

    fn lang(p: &str) -> Option<(ServerId, &'static str)> {
        lookup_path(Path::new(p))
    }

    #[test]
    fn extension_lookup_maps_each_server() {
        assert_eq!(lang("a.rs"), Some((ServerId::RustAnalyzer, "rust")));
        assert_eq!(lang("a.py"), Some((ServerId::Basedpyright, "python")));
        assert_eq!(lang("a.pyi"), Some((ServerId::Basedpyright, "python")));
        assert_eq!(lang("A.java"), Some((ServerId::Jdtls, "java")));
        assert_eq!(lang("x.html"), Some((ServerId::Html, "html")));
        assert_eq!(lang("x.htm"), Some((ServerId::Html, "html")));
        assert_eq!(lang("README"), None);
        assert_eq!(lang("a.txt"), None);
    }

    #[test]
    fn jsx_tsx_json_and_style_variants_get_distinct_language_ids() {
        assert_eq!(lang("a.ts"), Some((ServerId::Vtsls, "typescript")));
        assert_eq!(lang("a.tsx"), Some((ServerId::Vtsls, "typescriptreact")));
        assert_eq!(lang("a.js"), Some((ServerId::Vtsls, "javascript")));
        assert_eq!(lang("a.jsx"), Some((ServerId::Vtsls, "javascriptreact")));
        assert_eq!(lang("a.mjs"), Some((ServerId::Vtsls, "javascript")));
        assert_eq!(lang("a.cts"), Some((ServerId::Vtsls, "typescript")));
        assert_eq!(lang("a.json"), Some((ServerId::Json, "json")));
        assert_eq!(lang("a.jsonc"), Some((ServerId::Json, "jsonc")));
        assert_eq!(lang("a.css"), Some((ServerId::Css, "css")));
        assert_eq!(lang("a.scss"), Some((ServerId::Css, "scss")));
        assert_eq!(lang("a.less"), Some((ServerId::Css, "less")));
    }

    #[test]
    fn extension_lookup_is_case_insensitive() {
        assert_eq!(
            server_for_path(Path::new("/p/App.TSX")),
            Some(ServerId::Vtsls)
        );
        assert_eq!(language_id_for_path(Path::new("Main.JAVA")), Some("java"));
    }

    #[test]
    fn specs_agree_with_lookup() {
        for spec in all_specs() {
            for ext in spec.extensions {
                let (id, language) =
                    lookup_extension(ext).unwrap_or_else(|| panic!("{ext} has no lookup entry"));
                assert_eq!(id, spec.id, "{ext}");
                assert!(spec.language_ids.contains(&language), "{ext} -> {language}");
            }
            for language in spec.language_ids {
                assert!(
                    spec.extensions
                        .iter()
                        .any(|e| lookup_extension(e).map(|(_, l)| l) == Some(*language)),
                    "{language} unreachable by extension"
                );
            }
        }
    }

    #[test]
    fn runtime_requirements() {
        let node18 = RuntimeRequirement {
            runtime: Runtime::Node,
            min_major: 18,
        };
        assert_eq!(spec(ServerId::Vtsls).runtime, node18);
        assert_eq!(spec(ServerId::Html).runtime, node18);
        assert_eq!(spec(ServerId::Basedpyright).runtime.runtime, Runtime::Node);
        assert_eq!(spec(ServerId::RustAnalyzer).runtime.runtime, Runtime::None);
        assert_eq!(
            spec(ServerId::Jdtls).runtime,
            RuntimeRequirement {
                runtime: Runtime::Java,
                min_major: 25
            }
        );
    }

    #[test]
    fn every_plan_is_well_formed_on_every_platform() {
        let oses = [Os::MacOs, Os::Linux, Os::Windows];
        let arches = [Arch::Aarch64, Arch::X86_64];
        for id in ALL_SERVERS {
            for os in oses {
                for arch in arches {
                    let plan = install_plan(id, Platform::new(os, arch)).unwrap();
                    assert!(!plan.artifacts.is_empty());
                    let mut urls = std::collections::HashSet::new();
                    for a in &plan.artifacts {
                        assert!(a.url.starts_with("https://"), "{}", a.url);
                        assert_eq!(a.sha256.len(), 64, "{}", a.url);
                        assert!(
                            a.sha256.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')),
                            "{}",
                            a.url
                        );
                        assert!(!a.entry.is_empty() && !a.entry.starts_with('/'));
                        // A package npm could not flatten is installed once per parent.
                        assert!(
                            urls.insert((a.url.clone(), a.parent.clone())),
                            "duplicate {}",
                            a.url
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn svelte_plan_nests_conflicting_copies_after_their_parent() {
        let plan = install_plan(ServerId::Svelte, MAC_ARM).unwrap();
        assert_eq!(plan.version, SVELTE_VERSION);
        let position = |entry: &str| plan.artifacts.iter().position(|a| a.entry == entry);
        let nested: Vec<_> = plan
            .artifacts
            .iter()
            .filter(|a| a.parent.is_some())
            .collect();
        assert!(
            nested.len() >= 4,
            "expected nested estree-walker and vscode-uri copies"
        );
        for a in nested {
            let parent = a.parent.as_deref().unwrap();
            assert!(
                a.entry
                    .starts_with(&format!("node_modules/{parent}/node_modules/")),
                "{}",
                a.entry
            );
            let parent_at = position(&format!("node_modules/{parent}/package.json"));
            let own_at = position(&a.entry);
            assert!(
                parent_at.is_some() && parent_at < own_at,
                "{parent} must install before {}",
                a.entry
            );
        }
        assert!(plan
            .artifacts
            .iter()
            .any(|a| a.entry == "node_modules/typescript/package.json"));
    }

    #[test]
    fn svelte_files_map_to_the_svelte_server() {
        assert_eq!(
            lookup_path(Path::new("src/App.svelte")),
            Some((ServerId::Svelte, "svelte"))
        );
    }

    #[test]
    fn npm_plans_are_flat_and_primary_first() {
        for (id, primary_entry) in [
            (ServerId::Vtsls, VTSLS_ENTRY),
            (ServerId::Html, HTML_ENTRY),
            (ServerId::Css, CSS_ENTRY),
            (ServerId::Json, JSON_ENTRY),
            (ServerId::Basedpyright, BASEDPYRIGHT_ENTRY),
            (ServerId::Svelte, SVELTE_ENTRY),
        ] {
            let plan = install_plan(id, MAC_ARM).unwrap();
            assert_eq!(plan.artifacts[0].entry, primary_entry);
            assert!(plan
                .artifacts
                .iter()
                .all(|a| a.kind == ArtifactKind::NpmTarball));
            let mut entries: Vec<&str> = plan.artifacts.iter().map(|a| a.entry.as_str()).collect();
            let n = entries.len();
            entries.sort();
            entries.dedup();
            assert_eq!(entries.len(), n, "{id:?} has duplicate package entries");
        }
    }

    #[test]
    fn vtsls_pins_typescript_and_its_server() {
        let plan = install_plan(ServerId::Vtsls, MAC_ARM).unwrap();
        assert_eq!(plan.version, "0.3.0");
        let urls: Vec<&str> = plan.artifacts.iter().map(|a| a.url.as_str()).collect();
        assert!(urls.contains(&"https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz"));
        assert!(urls.contains(
            &"https://registry.npmjs.org/@vtsls/language-server/-/language-server-0.3.0.tgz"
        ));
    }

    #[test]
    fn rust_analyzer_plan_per_platform() {
        let p = install_plan(ServerId::RustAnalyzer, MAC_ARM).unwrap();
        assert_eq!(p.version, "2026-10-12");
        assert_eq!(p.artifacts.len(), 1);
        let a = &p.artifacts[0];
        assert_eq!(
            a.url,
            "https://github.com/rust-lang/rust-analyzer/releases/download/2026-10-12/rust-analyzer-aarch64-apple-darwin.gz"
        );
        assert_eq!(
            a.sha256,
            "a2e45e828b37bfc4b507c2ca456e8b61096e0bdfbae225f3d33295546d1eeacf"
        );
        assert_eq!(
            (a.kind.clone(), a.entry.as_str()),
            (ArtifactKind::Gz, "rust-analyzer")
        );

        let w = install_plan(
            ServerId::RustAnalyzer,
            Platform::new(Os::Windows, Arch::X86_64),
        )
        .unwrap();
        assert_eq!(w.artifacts[0].kind, ArtifactKind::Zip);
        assert_eq!(w.artifacts[0].entry, "rust-analyzer.exe");
        assert!(w.artifacts[0].url.ends_with("x86_64-pc-windows-msvc.zip"));

        let l = install_plan(
            ServerId::RustAnalyzer,
            Platform::new(Os::Linux, Arch::X86_64),
        )
        .unwrap();
        assert!(l.artifacts[0].url.ends_with("x86_64-unknown-linux-gnu.gz"));
    }

    #[test]
    fn node_servers_launch_with_explicit_args() {
        let cache = Path::new("/cache/v");
        let joined = |rel: &str| cache.join(rel).to_string_lossy().into_owned();
        let mut ctx = LaunchContext::new(cache, MAC_ARM);
        ctx.runtime_program = Some(PathBuf::from("/usr/local/bin/node"));
        let l = launch_spec(ServerId::Vtsls, &ctx).unwrap();
        assert_eq!(l.program, PathBuf::from("/usr/local/bin/node"));
        assert_eq!(
            l.args,
            vec![
                joined("node_modules/@vtsls/language-server/bin/vtsls.js"),
                "--stdio".to_string()
            ]
        );
        assert!(l.env.is_empty());

        let ctx = LaunchContext::new(cache, MAC_ARM);
        let b = launch_spec(ServerId::Basedpyright, &ctx).unwrap();
        assert_eq!(b.program, PathBuf::from("node"));
        assert_eq!(
            b.args,
            vec![
                joined("node_modules/basedpyright/langserver.index.js"),
                "--stdio".to_string()
            ]
        );
        let css = launch_spec(ServerId::Css, &ctx).unwrap();
        assert!(css.args[0].ends_with("bin/vscode-css-language-server"));
    }

    #[test]
    fn rust_analyzer_launches_installed_binary_without_args() {
        let ctx = LaunchContext::new("/cache/v", MAC_ARM);
        let l = launch_spec(ServerId::RustAnalyzer, &ctx).unwrap();
        assert_eq!(l.program, PathBuf::from("/cache/v/rust-analyzer"));
        assert!(l.args.is_empty());
        let w = LaunchContext::new("C:/c", Platform::new(Os::Windows, Arch::X86_64));
        assert_eq!(
            launch_spec(ServerId::RustAnalyzer, &w).unwrap().program,
            PathBuf::from("C:/c/rust-analyzer.exe")
        );
    }

    fn jdtls_install_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let plugins = dir.path().join("plugins");
        fs::create_dir_all(&plugins).unwrap();
        for name in [
            "org.eclipse.equinox.launcher.gtk.linux.x86_64_1.2.1700.v20260913-1737.jar",
            "org.eclipse.equinox.launcher_1.8.0.v20260804-1928.jar",
            "org.eclipse.jdt.core_3.48.0.jar",
        ] {
            fs::write(plugins.join(name), b"").unwrap();
        }
        dir
    }

    #[test]
    fn launcher_is_found_by_pattern_and_ignores_platform_fragments() {
        let dir = jdtls_install_dir();
        let found = find_equinox_launcher(dir.path()).unwrap();
        assert_eq!(
            found.file_name().unwrap(),
            "org.eclipse.equinox.launcher_1.8.0.v20260804-1928.jar"
        );
        let empty = tempfile::tempdir().unwrap();
        fs::create_dir_all(empty.path().join("plugins")).unwrap();
        assert!(matches!(
            find_equinox_launcher(empty.path()),
            Err(CatalogError::MissingLauncher(_))
        ));
    }

    #[test]
    fn jdtls_launch_args_are_exact() {
        let dir = jdtls_install_dir();
        let shared = dir
            .path()
            .join("config_mac_arm")
            .to_string_lossy()
            .into_owned();
        let launcher = dir
            .path()
            .join("plugins")
            .join("org.eclipse.equinox.launcher_1.8.0.v20260804-1928.jar")
            .to_string_lossy()
            .into_owned();
        let mut ctx = LaunchContext::new(dir.path(), MAC_ARM);
        ctx.runtime_program = Some(PathBuf::from("/jdk/bin/java"));
        ctx.java_major = Some(21);
        ctx.workspace_dir = Some(PathBuf::from("/data/ws"));
        ctx.config_dir = Some(PathBuf::from("/data/cfg"));
        let l = launch_spec(ServerId::Jdtls, &ctx).unwrap();
        assert_eq!(l.program, PathBuf::from("/jdk/bin/java"));
        let expected: Vec<String> = vec![
            "-Declipse.application=org.eclipse.jdt.ls.core.id1".into(),
            "-Dosgi.bundles.defaultStartLevel=4".into(),
            "-Declipse.product=org.eclipse.jdt.ls.core.product".into(),
            "-Dosgi.checkConfiguration=true".into(),
            format!("-Dosgi.sharedConfiguration.area={shared}"),
            "-Dosgi.sharedConfiguration.area.readOnly=true".into(),
            "-Dosgi.configuration.cascaded=true".into(),
            "-Xms1G".into(),
            "--add-modules=ALL-SYSTEM".into(),
            "--add-opens".into(),
            "java.base/java.util=ALL-UNNAMED".into(),
            "--add-opens".into(),
            "java.base/java.lang=ALL-UNNAMED".into(),
            "-jar".into(),
            launcher,
            "-configuration".into(),
            "/data/cfg".into(),
            "-data".into(),
            "/data/ws".into(),
        ];
        assert_eq!(l.args, expected);
    }

    #[test]
    fn jdtls_adds_xml_limits_on_java_24_and_picks_platform_config() {
        let dir = jdtls_install_dir();
        let mut ctx = LaunchContext::new(dir.path(), Platform::new(Os::Linux, Arch::X86_64));
        ctx.java_major = Some(25);
        ctx.workspace_dir = Some("/w".into());
        ctx.config_dir = Some("/c".into());
        let l = launch_spec(ServerId::Jdtls, &ctx).unwrap();
        assert_eq!(l.args[0], "-Djdk.xml.maxGeneralEntitySizeLimit=0");
        assert_eq!(l.args[1], "-Djdk.xml.totalEntitySizeLimit=0");
        assert!(l
            .args
            .iter()
            .any(|a| Path::new(a).ends_with("config_linux")));
        assert_eq!(
            jdtls_config_dir_name(Platform::new(Os::Windows, Arch::Aarch64)),
            "config_win"
        );
        assert_eq!(
            jdtls_config_dir_name(Platform::new(Os::Linux, Arch::Aarch64)),
            "config_linux_arm"
        );
    }

    #[test]
    fn jdtls_requires_workspace_and_config_dirs() {
        let dir = jdtls_install_dir();
        let ctx = LaunchContext::new(dir.path(), MAC_ARM);
        assert!(matches!(
            launch_spec(ServerId::Jdtls, &ctx),
            Err(CatalogError::MissingLaunchInput { .. })
        ));
    }
}
