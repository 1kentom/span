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

pub const ALL_SERVERS: [ServerId; 10] = [
    ServerId::Vtsls,
    ServerId::Html,
    ServerId::Css,
    ServerId::Json,
    ServerId::RustAnalyzer,
    ServerId::Basedpyright,
    ServerId::Jdtls,
    ServerId::Svelte,
    ServerId::Vue,
    ServerId::Astro,
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
        ServerId::Vue => ServerSpec {
            id,
            display_name: "Vue",
            language_ids: &["vue"],
            extensions: &["vue"],
            root_markers: &[
                "vue.config.js",
                "vite.config.ts",
                "vite.config.js",
                "nuxt.config.ts",
                "package.json",
            ],
            // `@vue/language-server` 2.2.12 has no `engines`; it needs a Node that runs TypeScript 5.9.
            runtime: RuntimeRequirement {
                runtime: Runtime::Node,
                min_major: 18,
            },
            // Takeover mode: `hybridMode: false` makes the Vue server run its own TypeScript service, so
            // no second server has to be wired in. `{tsdk}` becomes the installed `typescript/lib` at launch.
            initialization_options: json!({
                "typescript": { "tsdk": TSDK_PLACEHOLDER },
                "vue": { "hybridMode": false },
            }),
        },
        ServerId::Astro => ServerSpec {
            id,
            display_name: "Astro",
            language_ids: &["astro"],
            extensions: &["astro"],
            root_markers: &[
                "astro.config.mjs",
                "astro.config.ts",
                "astro.config.js",
                "package.json",
            ],
            // `@astrojs/language-server` 2.17.2 needs Node 18 or newer.
            runtime: RuntimeRequirement {
                runtime: Runtime::Node,
                min_major: 18,
            },
            initialization_options: json!({ "typescript": { "tsdk": TSDK_PLACEHOLDER } }),
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
        "vue" => (ServerId::Vue, "vue"),
        "astro" => (ServerId::Astro, "astro"),
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
        // Vue's copy (0.4.0) is a GitHub commit, not a registry tarball. Astro's 0.4.1 is a registry one.
        if self.name == "@emmetio/css-parser" && self.version == "0.4.0" {
            return "https://codeload.github.com/ramya-rao-a/css-parser/tar.gz/370c480ac103bd17c7bcfb34bf5d577dc40d3660".to_string();
        }
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

/// Complete closure of `@vue/language-server@2.2.12`, resolved like the others, plus
/// `typescript` 5.9.3. `@emmetio/css-parser` 0.4.0 is a GitHub fork that npm fetches by commit, so it is
/// pinned to that commit's archive (see `NpmPackage::url`). Takeover mode is used because 3.x only runs
/// with a separate TypeScript server plugin.
#[rustfmt::skip]
const VUE_PACKAGES: &[NpmPackage] = &[
    NpmPackage { name: "@babel/helper-string-parser", version: "7.29.7", sha256: "124565ecd300d7187973060ba6b1d1c4f296e55f0489ddfd6af794f516fed127", parent: None },
    NpmPackage { name: "@babel/helper-validator-identifier", version: "7.29.7", sha256: "7a31904bc45f1bb232d5e5dd797d12296f4a27fb4bf0f6d517827700f997dc1f", parent: None },
    NpmPackage { name: "@babel/parser", version: "7.29.9", sha256: "8f3b9fbc531e0c08e2c329cf1ff57bbe121e2d10061b65a05614a25b2255cc43", parent: None },
    NpmPackage { name: "@babel/types", version: "7.29.8", sha256: "514a4ed09355fe1417f03e89c5a5f518745e2eb75a4069d25b55a3e7298069de", parent: None },
    NpmPackage { name: "@emmetio/abbreviation", version: "2.3.3", sha256: "04bf8598f3667f6391dd71e785d7d236406f9483266aad82d3078425aedd76b8", parent: None },
    NpmPackage { name: "@emmetio/css-abbreviation", version: "2.1.8", sha256: "ebdf10502278bc7455e64829670a21872f52c7fbdfcf8b4c5e3a3df55815223b", parent: None },
    NpmPackage { name: "@emmetio/css-parser", version: "0.4.0", sha256: "6004ae05ad17931a62a72b27ebf1dab54fca6e72c0a9f0b7925a8b315bbe776d", parent: None },
    NpmPackage { name: "@emmetio/html-matcher", version: "1.3.0", sha256: "9071db2ef306a14b20d69e0e62d8d574734954c73588a29486063cadc8746a29", parent: None },
    NpmPackage { name: "@emmetio/scanner", version: "1.0.4", sha256: "1e9aab50b22abc1e8cca5fc535fcace154e0d8852fd68d05f6e0bbdf0899acc9", parent: None },
    NpmPackage { name: "@emmetio/stream-reader", version: "2.2.0", sha256: "9e1e5baaa16416c7ce291a01a2504be71fe4d2b286764697e0acc086d59d5cbc", parent: None },
    NpmPackage { name: "@emmetio/stream-reader-utils", version: "0.1.0", sha256: "62a0bd85e1827dc6db4487ba11ee2fa796a322f59269fc169cfce5e58c92f310", parent: None },
    NpmPackage { name: "@johnsoncodehk/pug-beautify", version: "0.2.2", sha256: "60635aa22b9c1f879f4b1ca02698136a1dcc5111b5f7d500981716657d1748c5", parent: None },
    NpmPackage { name: "@volar/language-core", version: "2.4.15", sha256: "042e8ab54f34d1a545bb59b3f33a93f3515ad0a18989675aac8021a3379f437e", parent: None },
    NpmPackage { name: "@volar/language-server", version: "2.4.15", sha256: "d33a1dec55a26f87899e796b8c8efe31909ee955b340b0b028fd41630478da81", parent: None },
    NpmPackage { name: "@volar/language-service", version: "2.4.15", sha256: "6f0ec3dcad55e0964ddd3784aa18cd849122ae2b97131b60446793de9f46bc18", parent: None },
    NpmPackage { name: "@volar/source-map", version: "2.4.15", sha256: "c211e4399650eeea44d83145c316a82320f96392c859a615e5ba61eba0e2f23d", parent: None },
    NpmPackage { name: "@volar/test-utils", version: "2.4.15", sha256: "b47c7f9fe5325793854f3bfc649ef115d917b2a0d8b40e5a7c0fc0915eb30c04", parent: None },
    NpmPackage { name: "@volar/typescript", version: "2.4.15", sha256: "5f76128fb0e727710c37b8dc0af93c0181f198fd9d6b5925b1b8ff7d415d241d", parent: None },
    NpmPackage { name: "@vscode/emmet-helper", version: "2.11.0", sha256: "47903a07e1613481d66dff359ac89c9be3d0619391a04d5272789894294b7be2", parent: None },
    NpmPackage { name: "@vscode/l10n", version: "0.0.18", sha256: "f1c2dc897488595f6bb42121869f525c6c6a5f7c8dca550754199c3251ed7c5c", parent: None },
    NpmPackage { name: "@vue/compiler-core", version: "3.5.44", sha256: "343008543669d7a5d5ffd686171895126136bf3a7ca21b7257ca17855dec1cf0", parent: None },
    NpmPackage { name: "@vue/compiler-dom", version: "3.5.44", sha256: "9d0f62df9ddfe60bdd5115bc20bd6612c669db9d0809c51e0dc3d24b37e7c958", parent: None },
    NpmPackage { name: "@vue/compiler-vue2", version: "2.7.16", sha256: "c8fb39669970b7799446466314ea472e3319ba4aa21e6eaaf3b9311a2ff46c1d", parent: None },
    NpmPackage { name: "@vue/language-core", version: "2.2.12", sha256: "ef2579fe5154c62da609bfb869380f13f73b37a58163cfb2ba36fa2ea490b745", parent: None },
    NpmPackage { name: "@vue/language-server", version: "2.2.12", sha256: "d12e972aee1fdcdd7fac69c9b50599af624e09e08a2995da0d9959f2b66f84e3", parent: None },
    NpmPackage { name: "@vue/language-service", version: "2.2.12", sha256: "4c595241a01ddee16158bbeaa27ac55f8385189d42dc0038be4ae53ea8ecc588", parent: None },
    NpmPackage { name: "@vue/shared", version: "3.5.44", sha256: "aee2236b79bdca0fae054ce96eb1469a84c8a44879397176d1674186f8470475", parent: None },
    NpmPackage { name: "@vue/typescript-plugin", version: "2.2.12", sha256: "2915d8ca53cf3869b5ee163174c213a5e09e4d8bfcd395e97a58e1f76b0d6cdc", parent: None },
    NpmPackage { name: "acorn", version: "7.4.1", sha256: "daf0504df11000adcb815b61f5172f0042ac17c33646706581ab5be3e1dc077b", parent: None },
    NpmPackage { name: "alien-signals", version: "1.0.13", sha256: "79cfb53be82473352d8d31fbe2349cec6246914bb6624575f37179c4a71b8fb4", parent: None },
    NpmPackage { name: "balanced-match", version: "1.0.2", sha256: "d854f7abdd0c7a8120cf381e0ad5f972cbd0255f5d987424bd672c8c4fcebcc1", parent: None },
    NpmPackage { name: "brace-expansion", version: "2.1.7", sha256: "6f4d64fdab4cdc5096d48537f35a6bbb2b8b918abaa4bdb0833e92486f66befc", parent: None },
    NpmPackage { name: "call-bind-apply-helpers", version: "1.0.2", sha256: "073e9ff9dbabedf5c128020a677381e9f92c90188d118830b30a7656a7c37d2c", parent: None },
    NpmPackage { name: "call-bound", version: "1.0.4", sha256: "32086f492fedf1b9b34811f2ee50ca2cca53da5c783f7cd5f939d3f1e86bbd32", parent: None },
    NpmPackage { name: "character-parser", version: "2.2.0", sha256: "8c8fdbb2c10df62cfaf4d135ca5fa610e44af4090299651be3ed3ef91e2cc87e", parent: None },
    NpmPackage { name: "de-indent", version: "1.0.2", sha256: "d347c00d8980c918099dae8def07ebc9f4659149570b1653c5e1af0b266cd57d", parent: None },
    NpmPackage { name: "dunder-proto", version: "1.0.1", sha256: "ed1342228c82c10df9921c59d684df516a0cd6ed25b61e5f9d6330895326cfdb", parent: None },
    NpmPackage { name: "emmet", version: "2.4.11", sha256: "11867ac4d973092529c5e37e40d7a85b5f39de36e485885e73f5a88302780f20", parent: None },
    NpmPackage { name: "entities", version: "7.0.1", sha256: "554b7e2a79fa9eda0439714011fa42d77c6829842faa91e022070015bfd483a0", parent: None },
    NpmPackage { name: "es-define-property", version: "1.0.1", sha256: "5986b8b13121340a8b0d5c7d8f0f961aa80ef3a74515ca9cb7a78d86ed0385f7", parent: None },
    NpmPackage { name: "es-errors", version: "1.3.0", sha256: "d14dd1c35b4bd3b8aca3219fd3627eb7f3eb49cf6b4c8a7ca58b91fd7a190993", parent: None },
    NpmPackage { name: "es-object-atoms", version: "1.1.2", sha256: "f295c5df6751c65b4b9492b03c88fab5e13419de28a51ecdf17e693b4a421af0", parent: None },
    NpmPackage { name: "estree-walker", version: "2.0.2", sha256: "302931e539a9c5568d56634119290c4df9a7bde64a2f2dbc646d6013e3b03c58", parent: None },
    NpmPackage { name: "function-bind", version: "1.1.2", sha256: "704402651b02a1454f17d445fc7dd716efc282d059407126d58ef30a47e807aa", parent: None },
    NpmPackage { name: "get-intrinsic", version: "1.3.0", sha256: "662e27e54e00fe46fbb08f9f4aacb054e3695dbe72cc14b436613fbcfb780544", parent: None },
    NpmPackage { name: "get-proto", version: "1.0.1", sha256: "eb2cc52afb1f1fd82c5fc2a58c2380f0f16fdcdb5631538f3c66887435d70681", parent: None },
    NpmPackage { name: "gopd", version: "1.2.0", sha256: "d536d0de4dd285dc1468fbb7f39334a47ee0eec9c27f9b626a6e71466c9fda82", parent: None },
    NpmPackage { name: "has-symbols", version: "1.1.0", sha256: "4460c7532f28b8df2ddc9a1ec17816d43c24d4b9591dc6c5936b82f7f86ae7c5", parent: None },
    NpmPackage { name: "has-tostringtag", version: "1.0.2", sha256: "dc1c74e3f1179a6271f84747d72c89f258aa46ad3e6464fae0e41737a7f0ef7b", parent: None },
    NpmPackage { name: "hasown", version: "2.0.4", sha256: "e9d2b03f95573600e1c13124ce618e3142ed2c538d164595bedcd4408b8a4e4c", parent: None },
    NpmPackage { name: "he", version: "1.2.0", sha256: "777a7c030c1b6c0bbe8638136dcc5cedbb36b1082f821b06648de5d7d11c1b68", parent: None },
    NpmPackage { name: "is-expression", version: "4.0.0", sha256: "6c821f160a11fb907a57a687e46fa72097bfd952c7e4dbe571b52431670e9848", parent: None },
    NpmPackage { name: "is-regex", version: "1.2.1", sha256: "a73e499153621af82d1f0f1ba77f21a01f95612b09d50d57253fc9e123a98b0d", parent: None },
    NpmPackage { name: "jsonc-parser", version: "2.3.1", sha256: "b0a8126281d0bfca3a647661f6aacf9630d658adfc15b196fff58c81e3f1ab8c", parent: None },
    NpmPackage { name: "jsonc-parser", version: "3.3.1", sha256: "4a0315b8671e7463bae7af7c142cdf19e9aa7ba39eb36dc2df383b8648e3cbc9", parent: Some("vscode-json-languageservice") },
    NpmPackage { name: "math-intrinsics", version: "1.1.0", sha256: "b8c2c35575493dc086df88cfc468a9e2651b6617336480ab3f00fcf853f443a7", parent: None },
    NpmPackage { name: "minimatch", version: "9.0.9", sha256: "7d28c9a3ef17ce542093c78ec191481503e2711d29db1bd1522062303ab40478", parent: None },
    NpmPackage { name: "muggle-string", version: "0.4.1", sha256: "626315ee7cc1981c08139999aba9afa694b67aa9d659822f8b53b9e358278067", parent: None },
    NpmPackage { name: "object-assign", version: "4.1.1", sha256: "782d726a263ba7b26cced612af97b80035516df4b0cd788524e7b2cebc4e29ed", parent: None },
    NpmPackage { name: "path-browserify", version: "1.0.1", sha256: "74ad6965c6f8cb61d17b1798d48095c3238eca5707b517640a12150f17b8f93d", parent: None },
    NpmPackage { name: "pug-error", version: "2.1.0", sha256: "43d9448c1c3c0afb6db358255f816ab97cb778e93d633b120fd621f80d878c98", parent: None },
    NpmPackage { name: "pug-lexer", version: "5.0.1", sha256: "21012b133c17080002b6c6347206bff769f2d64c9a3a466150b4734b64b81809", parent: None },
    NpmPackage { name: "pug-parser", version: "6.0.0", sha256: "d126ac2684da60b20a937c61029bcb0b0d5613755099dacdd616e26cfd1da9fc", parent: None },
    NpmPackage { name: "request-light", version: "0.7.0", sha256: "15d60d0da12c1e9eff0bc8f0f00417e760b672165fe9a77b64639de29285ace5", parent: None },
    NpmPackage { name: "semver", version: "7.8.5", sha256: "d85045d4300d7d57c891336b95df532e73f34c22ffcd222452b6d08b9d127d5d", parent: None },
    NpmPackage { name: "source-map-js", version: "1.2.2", sha256: "05c8cf8e7c3a6b56cada7668fe9342b10f4b625efc92aba9ba05b9e8fe4d71a3", parent: None },
    NpmPackage { name: "token-stream", version: "1.0.0", sha256: "98b67de3601abd82a7cdc1ae8650917bf49f1f94feda7d6266ac055d76e890cd", parent: None },
    NpmPackage { name: "typescript", version: "5.9.3", sha256: "10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3", parent: None },
    NpmPackage { name: "typescript-auto-import-cache", version: "0.3.6", sha256: "4c4544e27c84b86f816145f192ccc66f5654c10c964c558fcecdefb067b6a17e", parent: None },
    NpmPackage { name: "volar-service-css", version: "0.0.64", sha256: "fe53b077625253d53eefcf3b8a96e0eef7aaaead9cbd4903cb6f7a71a4cba6ea", parent: None },
    NpmPackage { name: "volar-service-emmet", version: "0.0.64", sha256: "73c578e00befcfd90cd8616989e5ae32d2e16f5864e549375d6adaf0683b6fdd", parent: None },
    NpmPackage { name: "volar-service-html", version: "0.0.64", sha256: "6f99207ac8ec2f2ab1d4bc671cb9430d8718c00514cd5ee37c6fa4dadde97107", parent: None },
    NpmPackage { name: "volar-service-json", version: "0.0.64", sha256: "c3536f887552e991404e898f41357d4e7af21a2e964030eebbd8e2b7120070c4", parent: None },
    NpmPackage { name: "volar-service-pug", version: "0.0.64", sha256: "011e1dff997c820b3ad145250542a92cb73a883dea9614f0121309a7efe6664f", parent: None },
    NpmPackage { name: "volar-service-pug-beautify", version: "0.0.64", sha256: "46521f09c460c16f9711e2a100416408d84c002d8b04c8c0233e487e16b7f5b5", parent: None },
    NpmPackage { name: "volar-service-typescript", version: "0.0.64", sha256: "e82151f00a92b1bec33681991a88d9bb78e18788854a042420374f242b5353c6", parent: None },
    NpmPackage { name: "volar-service-typescript-twoslash-queries", version: "0.0.64", sha256: "a5f3562215940c931801ce5bc34d823041f19ef6b73694b9d56aa12314e95bda", parent: None },
    NpmPackage { name: "vscode-css-languageservice", version: "6.3.10", sha256: "75dfff4a7b2a9b8df08c17d5444a8224a3701e29fc30c2539db12a7a9ffc9448", parent: None },
    NpmPackage { name: "vscode-html-languageservice", version: "5.6.2", sha256: "a519e4029da8cf4d7d4cf6d882307038635f203c505862a4ef68f18fa194322a", parent: None },
    NpmPackage { name: "vscode-json-languageservice", version: "5.7.2", sha256: "18dc41edc48bdcab2da866a5b5f53956ee722b66fffe9d89740d04ba7f505459", parent: None },
    NpmPackage { name: "vscode-jsonrpc", version: "9.0.3", sha256: "282d3d574a565ab9bea0af6518eadac91221dfd0cd55cfd308662b816a7920a7", parent: None },
    NpmPackage { name: "vscode-jsonrpc", version: "8.2.0", sha256: "3da44531c398f1545074cb728e359a822f35b9f8ac7171c847f42f0728b9c7cb", parent: Some("vscode-languageserver") },
    NpmPackage { name: "vscode-languageserver", version: "9.0.1", sha256: "6cd7f463ae7872e588a4dd5ed5149475fe32e53517509a81e715eb0540602412", parent: None },
    NpmPackage { name: "vscode-languageserver-protocol", version: "3.18.4", sha256: "76ff8f83f7f1bac53e351cd30740ff75610277b65b4043141d359660d88f0dcd", parent: None },
    NpmPackage { name: "vscode-languageserver-protocol", version: "3.17.5", sha256: "7473eb2d2163f3f8bea09644f9d803789a195e596b65d3946c4157e583e3ccc8", parent: Some("vscode-languageserver") },
    NpmPackage { name: "vscode-languageserver-textdocument", version: "1.0.15", sha256: "2a133b20d5c5b1ff6d8627c628807c28d771b8741c8c6fca2aef3dd77cac669c", parent: None },
    NpmPackage { name: "vscode-languageserver-types", version: "3.18.4", sha256: "83c119b73d1895194087e9376d0916161b5550c210e9e892b65a3e04a43ea68e", parent: None },
    NpmPackage { name: "vscode-languageserver-types", version: "3.17.5", sha256: "d673f9e7f8bbe51351be51c58f32d4dcfa97a670ebb86bc633368394c609cac0", parent: Some("vscode-css-languageservice") },
    NpmPackage { name: "vscode-languageserver-types", version: "3.17.5", sha256: "d673f9e7f8bbe51351be51c58f32d4dcfa97a670ebb86bc633368394c609cac0", parent: Some("vscode-languageserver") },
    NpmPackage { name: "vscode-nls", version: "5.2.0", sha256: "441f95396ae52a4eff2f69770219a522ed13dc0ba69deb982ac9456eda9ca779", parent: None },
    NpmPackage { name: "vscode-uri", version: "3.2.0", sha256: "12fa4a47728ca404c3a679e351eda6c54030c8ed3dd9bc6762ab0be1bf04014b", parent: None },
];
pub const VUE_VERSION: &str = "2.2.12";
const VUE_ENTRY: &str = "node_modules/@vue/language-server/bin/vue-language-server.js";

/// Complete closure of `@astrojs/language-server@2.17.2`, resolved like the others, plus `typescript` 5.9.3
/// and `@emnapi/runtime`, a peer of the WebAssembly runtime the Astro compiler loads.
#[rustfmt::skip]
const ASTRO_PACKAGES: &[NpmPackage] = &[
    NpmPackage { name: "@astrojs/astro2tsx", version: "0.1.2", sha256: "56b002c86cace8d7d6f2850f8406e4b8b99c222cc79fada28231a76707ad38fe", parent: None },
    NpmPackage { name: "@astrojs/language-server", version: "2.17.2", sha256: "8dfee20ae7ccfd0b7aaee77ce24ebb8d45d801eecef970561ef68564bba71d7b", parent: None },
    NpmPackage { name: "@astrojs/yaml2ts", version: "0.2.4", sha256: "73dbace18980fcbc1bc5f832af257b534d2fb9dcfb3b2a3d2d420c46c92058af", parent: None },
    NpmPackage { name: "@emmetio/abbreviation", version: "2.3.3", sha256: "04bf8598f3667f6391dd71e785d7d236406f9483266aad82d3078425aedd76b8", parent: None },
    NpmPackage { name: "@emmetio/css-abbreviation", version: "2.1.8", sha256: "ebdf10502278bc7455e64829670a21872f52c7fbdfcf8b4c5e3a3df55815223b", parent: None },
    NpmPackage { name: "@emmetio/css-parser", version: "0.4.1", sha256: "b21847dfdfc56130afb521520a35f4abd3fd3d1b03eb9636fc79d8dcda74d5db", parent: None },
    NpmPackage { name: "@emmetio/html-matcher", version: "1.3.0", sha256: "9071db2ef306a14b20d69e0e62d8d574734954c73588a29486063cadc8746a29", parent: None },
    NpmPackage { name: "@emmetio/scanner", version: "1.0.4", sha256: "1e9aab50b22abc1e8cca5fc535fcace154e0d8852fd68d05f6e0bbdf0899acc9", parent: None },
    NpmPackage { name: "@emmetio/stream-reader", version: "2.2.0", sha256: "9e1e5baaa16416c7ce291a01a2504be71fe4d2b286764697e0acc086d59d5cbc", parent: None },
    NpmPackage { name: "@emmetio/stream-reader-utils", version: "0.1.0", sha256: "62a0bd85e1827dc6db4487ba11ee2fa796a322f59269fc169cfce5e58c92f310", parent: None },
    NpmPackage { name: "@emnapi/core", version: "1.11.3", sha256: "2f902aa197cf64722e5afddabecf4af94f8cab161d06b2f036bc29f2039136de", parent: None },
    NpmPackage { name: "@emnapi/runtime", version: "1.11.3", sha256: "e6eb8913a08b551436d65f9a5cfbdcc8006f58e6798226d24e695c25679b5e49", parent: None },
    NpmPackage { name: "@emnapi/wasi-threads", version: "1.2.3", sha256: "e1fc19dd8ecfde1313fd6afdf9b41a1a22c690c59cd6b384a5c7c97f96acde33", parent: None },
    NpmPackage { name: "@napi-rs/wasm-runtime", version: "1.2.4", sha256: "e64c2013eba51ad6624ccf94f06c8a570c0d80488b7eabf17af2934690ccb887", parent: None },
    NpmPackage { name: "@tybys/wasm-util", version: "0.10.4", sha256: "c6293ce0ae57dbf718723df204f014f6e6285cefc2fee51ea65fe8cac5eef0a0", parent: None },
    NpmPackage { name: "@volar/kit", version: "2.4.28", sha256: "7551010a1a62728d6875607ead1bf09b1358364f87c384fb2b4f98a9a740c516", parent: None },
    NpmPackage { name: "@volar/language-core", version: "2.4.28", sha256: "9634a2d697741a95af7a068a80ae740eadc655557df45f56175433cbc3cf9286", parent: None },
    NpmPackage { name: "@volar/language-server", version: "2.4.28", sha256: "ea231a5b20f94e5e9c43b4d16a06a9f6db866439a9fe92c9ec0de78d092636b3", parent: None },
    NpmPackage { name: "@volar/language-service", version: "2.4.28", sha256: "2a203b834dfc4ac9220bc1aea0b2799cd16b0aecd9c21ab496e442cbd9eea964", parent: None },
    NpmPackage { name: "@volar/source-map", version: "2.4.28", sha256: "053ca21a007a04afd4acff3cc2181971a45315e0b78b4875700ec904cc6671a6", parent: None },
    NpmPackage { name: "@volar/typescript", version: "2.4.28", sha256: "489fc8eb2c67da21636a9b8c4cbfe5f48a2100b177489868195e5872685ce96a", parent: None },
    NpmPackage { name: "@vscode/emmet-helper", version: "2.11.0", sha256: "47903a07e1613481d66dff359ac89c9be3d0619391a04d5272789894294b7be2", parent: None },
    NpmPackage { name: "@vscode/l10n", version: "0.0.18", sha256: "f1c2dc897488595f6bb42121869f525c6c6a5f7c8dca550754199c3251ed7c5c", parent: None },
    NpmPackage { name: "ajv", version: "8.20.0", sha256: "b2f0b3a893bbb8cc5efb6814f08b1499e19e31d5dd73683f5893382f48f6e7b3", parent: None },
    NpmPackage { name: "ajv-draft-04", version: "1.0.0", sha256: "b2328acf9b3a5b1b3a098789770c2dd34ed86b5913c904c056091ec10319c2e7", parent: None },
    NpmPackage { name: "ajv-i18n", version: "4.2.0", sha256: "b84c90f14594a447bf59badc6a9b01e75049400186adec9c85b52e1709867239", parent: None },
    NpmPackage { name: "emmet", version: "2.4.11", sha256: "11867ac4d973092529c5e37e40d7a85b5f39de36e485885e73f5a88302780f20", parent: None },
    NpmPackage { name: "fast-deep-equal", version: "3.1.3", sha256: "b019a0980f27638dc3f85836b0e478f188e00d7a6e5852c0819fa86f56e47b8f", parent: None },
    NpmPackage { name: "fast-uri", version: "3.1.8", sha256: "86be033b406a7737c0521edc8fe3e15c7ac0cb6b5e509478cc9539a2efaa086c", parent: None },
    NpmPackage { name: "fdir", version: "6.5.0", sha256: "241ddcd9f31e2a1fca405326017dbb8333ce174198e887f0f96387c29f0d365e", parent: None },
    NpmPackage { name: "json-schema-traverse", version: "1.0.0", sha256: "023222622df29fc274bde5d3590e47aa1d4a8e3c1d6e2aba029948ed79799b21", parent: None },
    NpmPackage { name: "jsonc-parser", version: "2.3.1", sha256: "b0a8126281d0bfca3a647661f6aacf9630d658adfc15b196fff58c81e3f1ab8c", parent: None },
    NpmPackage { name: "jsonc-parser", version: "3.3.1", sha256: "4a0315b8671e7463bae7af7c142cdf19e9aa7ba39eb36dc2df383b8648e3cbc9", parent: Some("vscode-json-languageservice") },
    NpmPackage { name: "muggle-string", version: "0.4.1", sha256: "626315ee7cc1981c08139999aba9afa694b67aa9d659822f8b53b9e358278067", parent: None },
    NpmPackage { name: "path-browserify", version: "1.0.1", sha256: "74ad6965c6f8cb61d17b1798d48095c3238eca5707b517640a12150f17b8f93d", parent: None },
    NpmPackage { name: "picomatch", version: "4.0.7", sha256: "697b463be3cdbd9ffc8f4194fd5019a69ddf95875fb703d78b2b115cc9e740a8", parent: None },
    NpmPackage { name: "prettier", version: "3.9.10", sha256: "9dc72045591793dff972432fb78722f7ab91aaa90a7fa8c1261ede55969246b7", parent: None },
    NpmPackage { name: "request-light", version: "0.7.0", sha256: "15d60d0da12c1e9eff0bc8f0f00417e760b672165fe9a77b64639de29285ace5", parent: None },
    NpmPackage { name: "request-light", version: "0.5.8", sha256: "4b6d4b48fa05056435b300a4a5f904bacbe0e6ddfa28bb44b729eb64f24375b9", parent: Some("yaml-language-server") },
    NpmPackage { name: "require-from-string", version: "2.0.2", sha256: "cb694a4965908f7775a0c757f00cf4e624d193cd71d77988fbcca0f597b88d82", parent: None },
    NpmPackage { name: "semver", version: "7.8.5", sha256: "d85045d4300d7d57c891336b95df532e73f34c22ffcd222452b6d08b9d127d5d", parent: None },
    NpmPackage { name: "tinyglobby", version: "0.2.17", sha256: "afb4afae9175f8b873ac13e1d21cea0997a0bcb40c3598613a834490058cb562", parent: None },
    NpmPackage { name: "tslib", version: "2.8.1", sha256: "66f635d5eeabae44807534976913a102cf615b9a045368359c9f79ae6ee2119e", parent: None },
    NpmPackage { name: "typesafe-path", version: "0.2.2", sha256: "9d1f8c10cfc35ce186599e5b91606dc2c4787948592c086ef486fa0609283488", parent: None },
    NpmPackage { name: "typescript", version: "5.9.3", sha256: "10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3", parent: None },
    NpmPackage { name: "typescript-auto-import-cache", version: "0.3.6", sha256: "4c4544e27c84b86f816145f192ccc66f5654c10c964c558fcecdefb067b6a17e", parent: None },
    NpmPackage { name: "volar-service-css", version: "0.0.71", sha256: "eea24cff3460a3f9bde14b338e9bd3682f7bdda17dfb0c4bdbb7b51dc6370d8c", parent: None },
    NpmPackage { name: "volar-service-emmet", version: "0.0.71", sha256: "d3157a8659c92dd6d03749db72f812c234d577df5bad41ec3f86bbdec52f12b2", parent: None },
    NpmPackage { name: "volar-service-html", version: "0.0.71", sha256: "289680ec72b2653488efab005280645207b8ca4f234860c7716c02dd28c2838c", parent: None },
    NpmPackage { name: "volar-service-prettier", version: "0.0.71", sha256: "cebabb658511686cd0dcdc80d7569100b8846efd9cf63d5febab0afd8e35dafe", parent: None },
    NpmPackage { name: "volar-service-typescript", version: "0.0.71", sha256: "25f86e33d511cd8bf8289f080755a826b215d82cb4b8251c846232d4c65f99d8", parent: None },
    NpmPackage { name: "volar-service-typescript-twoslash-queries", version: "0.0.71", sha256: "b9085577910ca8965a2beeb8cee6a95fabf479ec2a67c7b0f5e0fe7bde517199", parent: None },
    NpmPackage { name: "volar-service-yaml", version: "0.0.71", sha256: "da814283f08127d6188f6e0da7a30a8ba6087b161db469737c04e7bc505f31a1", parent: None },
    NpmPackage { name: "vscode-css-languageservice", version: "6.3.10", sha256: "75dfff4a7b2a9b8df08c17d5444a8224a3701e29fc30c2539db12a7a9ffc9448", parent: None },
    NpmPackage { name: "vscode-html-languageservice", version: "5.6.2", sha256: "a519e4029da8cf4d7d4cf6d882307038635f203c505862a4ef68f18fa194322a", parent: None },
    NpmPackage { name: "vscode-json-languageservice", version: "4.1.8", sha256: "c82cade415f91090c0dd04f2d134044e571afd88f04b0d77535ea5e3c8593610", parent: None },
    NpmPackage { name: "vscode-jsonrpc", version: "9.0.3", sha256: "282d3d574a565ab9bea0af6518eadac91221dfd0cd55cfd308662b816a7920a7", parent: None },
    NpmPackage { name: "vscode-jsonrpc", version: "8.2.0", sha256: "3da44531c398f1545074cb728e359a822f35b9f8ac7171c847f42f0728b9c7cb", parent: Some("vscode-languageserver") },
    NpmPackage { name: "vscode-languageserver", version: "9.0.1", sha256: "6cd7f463ae7872e588a4dd5ed5149475fe32e53517509a81e715eb0540602412", parent: None },
    NpmPackage { name: "vscode-languageserver-protocol", version: "3.18.4", sha256: "76ff8f83f7f1bac53e351cd30740ff75610277b65b4043141d359660d88f0dcd", parent: None },
    NpmPackage { name: "vscode-languageserver-protocol", version: "3.17.5", sha256: "7473eb2d2163f3f8bea09644f9d803789a195e596b65d3946c4157e583e3ccc8", parent: Some("vscode-languageserver") },
    NpmPackage { name: "vscode-languageserver-textdocument", version: "1.0.15", sha256: "2a133b20d5c5b1ff6d8627c628807c28d771b8741c8c6fca2aef3dd77cac669c", parent: None },
    NpmPackage { name: "vscode-languageserver-types", version: "3.18.4", sha256: "83c119b73d1895194087e9376d0916161b5550c210e9e892b65a3e04a43ea68e", parent: None },
    NpmPackage { name: "vscode-languageserver-types", version: "3.17.5", sha256: "d673f9e7f8bbe51351be51c58f32d4dcfa97a670ebb86bc633368394c609cac0", parent: Some("vscode-css-languageservice") },
    NpmPackage { name: "vscode-languageserver-types", version: "3.17.5", sha256: "d673f9e7f8bbe51351be51c58f32d4dcfa97a670ebb86bc633368394c609cac0", parent: Some("vscode-languageserver") },
    NpmPackage { name: "vscode-nls", version: "5.2.0", sha256: "441f95396ae52a4eff2f69770219a522ed13dc0ba69deb982ac9456eda9ca779", parent: None },
    NpmPackage { name: "vscode-uri", version: "3.2.0", sha256: "12fa4a47728ca404c3a679e351eda6c54030c8ed3dd9bc6762ab0be1bf04014b", parent: None },
    NpmPackage { name: "yaml", version: "2.9.1", sha256: "4ef6c54cf559b8a207b7b518378230805a1c84af239b14960e8c67c7d59de5d3", parent: None },
    NpmPackage { name: "yaml", version: "2.8.3", sha256: "9539805d7447def2bed5c5b4acacc283362c5e80abc5d93472b2f35f0cbf85ad", parent: Some("yaml-language-server") },
    NpmPackage { name: "yaml-language-server", version: "1.23.0", sha256: "f0b6ec7f169507e9fa31667d0440446d23901b48005d859d99e3de5adef216cf", parent: None },
];
pub const ASTRO_VERSION: &str = "2.17.2";
const ASTRO_ENTRY: &str = "node_modules/@astrojs/language-server/bin/nodeServer.js";

/// Replaced with `<install dir>/node_modules/typescript/lib` when the server starts.
pub const TSDK_PLACEHOLDER: &str = "{tsdk}";

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
        ServerId::Vue => npm_plan(VUE_VERSION, VUE_PACKAGES, "@vue/language-server", VUE_ENTRY),
        ServerId::Astro => npm_plan(
            ASTRO_VERSION,
            ASTRO_PACKAGES,
            "@astrojs/language-server",
            ASTRO_ENTRY,
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
        ServerId::Vue => Ok(node_launch(ctx, VUE_ENTRY)),
        ServerId::Astro => Ok(node_launch(ctx, ASTRO_ENTRY)),
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
    fn framework_plans_nest_conflicting_copies_after_their_parent_and_ship_typescript() {
        for (id, version) in [
            (ServerId::Svelte, SVELTE_VERSION),
            (ServerId::Vue, VUE_VERSION),
            (ServerId::Astro, ASTRO_VERSION),
        ] {
            let plan = install_plan(id, MAC_ARM).unwrap();
            assert_eq!(plan.version, version);
            let position = |entry: &str| plan.artifacts.iter().position(|a| a.entry == entry);
            let nested: Vec<_> = plan
                .artifacts
                .iter()
                .filter(|a| a.parent.is_some())
                .collect();
            assert!(!nested.is_empty(), "{id:?} should have nested copies");
            for a in nested {
                let parent = a.parent.as_deref().unwrap();
                assert!(
                    a.entry
                        .starts_with(&format!("node_modules/{parent}/node_modules/")),
                    "{}",
                    a.entry
                );
                let parent_at = position(&format!("node_modules/{parent}/package.json"));
                assert!(
                    parent_at.is_some() && parent_at < position(&a.entry),
                    "{id:?}: {parent} must install before {}",
                    a.entry
                );
            }
            assert!(
                plan.artifacts
                    .iter()
                    .any(|a| a.entry == "node_modules/typescript/package.json"),
                "{id:?} needs typescript for its tsdk"
            );
        }
    }

    #[test]
    fn the_emmet_css_parser_fork_is_pinned_to_its_commit_archive() {
        let plan = install_plan(ServerId::Vue, MAC_ARM).unwrap();
        let fork = plan
            .artifacts
            .iter()
            .find(|a| a.entry == "node_modules/@emmetio/css-parser/package.json")
            .unwrap();
        assert!(fork
            .url
            .starts_with("https://codeload.github.com/ramya-rao-a/css-parser/tar.gz/370c480"));
    }

    #[test]
    fn typescript_servers_get_a_tsdk_placeholder() {
        for id in [ServerId::Vue, ServerId::Astro] {
            let options = initialization_options(id, false);
            assert_eq!(options["typescript"]["tsdk"], TSDK_PLACEHOLDER, "{id:?}");
        }
        assert_eq!(
            initialization_options(ServerId::Vue, false)["vue"]["hybridMode"],
            false
        );
    }

    #[test]
    fn svelte_files_map_to_the_svelte_server() {
        assert_eq!(
            lookup_path(Path::new("src/App.svelte")),
            Some((ServerId::Svelte, "svelte"))
        );
        assert_eq!(
            lookup_path(Path::new("App.vue")),
            Some((ServerId::Vue, "vue"))
        );
        assert_eq!(
            lookup_path(Path::new("pages/index.astro")),
            Some((ServerId::Astro, "astro"))
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
            (ServerId::Vue, VUE_ENTRY),
            (ServerId::Astro, ASTRO_ENTRY),
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
