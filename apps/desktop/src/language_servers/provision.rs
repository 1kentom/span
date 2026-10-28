//! Installation state, runtime checks and the gated launch resolver.
//!
//! The service decides when a download may happen. This module only answers
//! questions (is it installed, is Node or Java usable) and performs an install when
//! the service asks for one. The [`GatedResolver`] given to the manager refuses to
//! launch anything that is not installed unless auto install is on, so a download can
//! never start behind the service's back.

use super::LspSettings;
use span_lsp::servers::cache::ServerCache;
use span_lsp::servers::catalog::{self, Platform};
use span_lsp::servers::install::{BoxFuture, HttpFetch, InstallError, InstallProgress, Installer};
use span_lsp::servers::manager::{LaunchResolver, ServerError};
use span_lsp::servers::resolver::{locate_java, CatalogResolver, JavaSearch};
use span_lsp::servers::runtime::{locate_node, NodeSearch, RuntimeError, SystemProbe};
use span_lsp::servers::spec::{LaunchSpec, Runtime, ServerId};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use tokio::sync::mpsc;

/// A missing or too old runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeIssue {
    pub runtime: String,
    pub required: u32,
    pub found: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallFailure {
    pub reason: String,
    pub retryable: bool,
}

pub trait Provisioner: Send + Sync + 'static {
    fn is_installed(&self, id: ServerId) -> BoxFuture<'_, bool>;
    /// Whether the runtime the server needs is usable. Must not download anything.
    fn check_runtime(&self, id: ServerId) -> BoxFuture<'_, Result<(), RuntimeIssue>>;
    fn install(
        &self,
        id: ServerId,
        progress: mpsc::Sender<InstallProgress>,
    ) -> BoxFuture<'_, Result<(), InstallFailure>>;
    fn version(&self, id: ServerId) -> String;
    /// Rough download size in bytes, for the prompt shown before installing.
    fn size_hint(&self, id: ServerId) -> Option<u64>;
    fn configure(&self, settings: &LspSettings);
}

/// Approximate compressed download sizes in bytes. These are rough estimates for the
/// opt-in prompt only; they are not checked against the artifacts.
pub fn approximate_download_size(id: ServerId) -> u64 {
    match id {
        ServerId::Vtsls => 30_000_000,
        ServerId::Html | ServerId::Css | ServerId::Json => 10_000_000,
        ServerId::RustAnalyzer => 20_000_000,
        ServerId::Basedpyright => 20_000_000,
        ServerId::Jdtls => 60_000_000,
    }
}

struct Config {
    node: NodeSearch,
    java: JavaSearch,
    resolver: Arc<CatalogResolver>,
}

pub struct CatalogProvisioner {
    cache: ServerCache,
    installer: Installer,
    platform: Option<Platform>,
    auto_install: AtomicBool,
    config: RwLock<Config>,
    cache_root: PathBuf,
}

fn config_for(cache_root: &Path, settings: &LspSettings) -> Result<Config, String> {
    let node = match &settings.node_path {
        // An override is strict: nothing else is searched.
        Some(path) => NodeSearch {
            override_program: Some(path.clone()),
            ..Default::default()
        },
        None => NodeSearch::from_env(),
    };
    let java = match &settings.java_home {
        Some(home) => JavaSearch {
            java_home: Some(home.clone()),
            ..Default::default()
        },
        None => JavaSearch::from_host(),
    };
    let resolver = CatalogResolver::new(cache_root)
        .map_err(|e| e.to_string())?
        .with_node_search(node.clone())
        .with_java_search(java.clone());
    Ok(Config {
        node,
        java,
        resolver: Arc::new(resolver),
    })
}

impl CatalogProvisioner {
    pub fn new(cache_root: PathBuf) -> Result<Self, String> {
        let fetch = HttpFetch::new().map_err(|e| e.to_string())?;
        let settings = LspSettings::default();
        let config = config_for(&cache_root, &settings)?;
        Ok(Self {
            cache: ServerCache::new(cache_root.clone()),
            installer: Installer::new(ServerCache::new(cache_root.clone()), Arc::new(fetch)),
            platform: Platform::current(),
            auto_install: AtomicBool::new(false),
            config: RwLock::new(config),
            cache_root,
        })
    }

    fn resolver(&self) -> Arc<CatalogResolver> {
        self.config.read().unwrap().resolver.clone()
    }

    fn plan(&self, id: ServerId) -> Option<span_lsp::servers::InstallPlan> {
        catalog::install_plan(id, self.platform?).ok()
    }

    pub fn auto_install(&self) -> bool {
        self.auto_install.load(Ordering::SeqCst)
    }
}

fn retryable(error: &InstallError) -> bool {
    matches!(
        error,
        InstallError::Network { .. }
            | InstallError::HttpStatus { .. }
            | InstallError::Truncated { .. }
            | InstallError::Io { .. }
            | InstallError::Cancelled
            | InstallError::Cache(_)
    )
}

fn runtime_label(runtime: &Runtime) -> String {
    match runtime {
        Runtime::Node => "node".into(),
        Runtime::Java => "java".into(),
        Runtime::None => "none".into(),
    }
}

impl Provisioner for CatalogProvisioner {
    fn is_installed(&self, id: ServerId) -> BoxFuture<'_, bool> {
        Box::pin(async move {
            match self.plan(id) {
                Some(plan) => self.cache.is_complete(id, &plan).await,
                None => false,
            }
        })
    }

    fn check_runtime(&self, id: ServerId) -> BoxFuture<'_, Result<(), RuntimeIssue>> {
        Box::pin(async move {
            let req = catalog::spec(id).runtime;
            let (node, java) = {
                let config = self.config.read().unwrap();
                (config.node.clone(), config.java.clone())
            };
            tokio::task::spawn_blocking(move || match req.runtime {
                Runtime::None => Ok(()),
                Runtime::Node => locate_node(&SystemProbe, &node, req.min_major)
                    .map(|_| ())
                    .map_err(|e| RuntimeIssue {
                        runtime: runtime_label(&Runtime::Node),
                        required: req.min_major,
                        found: match e {
                            RuntimeError::TooOld { found, .. } => vec![found],
                            _ => Vec::new(),
                        },
                    }),
                Runtime::Java => locate_java(&SystemProbe, &java, req.min_major)
                    .map(|_| ())
                    .map_err(|e| RuntimeIssue {
                        runtime: runtime_label(&Runtime::Java),
                        required: req.min_major,
                        found: e.found.into_iter().map(|j| j.version).collect(),
                    }),
            })
            .await
            .unwrap_or_else(|e| {
                Err(RuntimeIssue {
                    runtime: format!("probe failed: {e}"),
                    required: req.min_major,
                    found: Vec::new(),
                })
            })
        })
    }

    fn install(
        &self,
        id: ServerId,
        progress: mpsc::Sender<InstallProgress>,
    ) -> BoxFuture<'_, Result<(), InstallFailure>> {
        Box::pin(async move {
            let plan = self.plan(id).ok_or_else(|| InstallFailure {
                reason: "no pinned build for this platform".into(),
                retryable: false,
            })?;
            self.installer
                .install(id, &plan, &[], Some(&progress))
                .await
                .map(|_| ())
                .map_err(|e| InstallFailure {
                    retryable: retryable(&e),
                    reason: e.to_string(),
                })
        })
    }

    fn version(&self, id: ServerId) -> String {
        self.plan(id).map(|p| p.version).unwrap_or_default()
    }

    fn size_hint(&self, id: ServerId) -> Option<u64> {
        Some(approximate_download_size(id))
    }

    fn configure(&self, settings: &LspSettings) {
        self.auto_install
            .store(settings.auto_install, Ordering::SeqCst);
        match config_for(&self.cache_root, settings) {
            Ok(config) => *self.config.write().unwrap() = config,
            Err(error) => eprintln!("Could not apply language server settings: {error}"),
        }
    }
}

/// Launch resolver that never downloads unless auto install is on.
pub struct GatedResolver {
    provisioner: Arc<CatalogProvisioner>,
}

impl GatedResolver {
    pub fn new(provisioner: Arc<CatalogProvisioner>) -> Self {
        Self { provisioner }
    }

    async fn gate(&self, id: ServerId) -> Result<Arc<CatalogResolver>, ServerError> {
        if !self.provisioner.auto_install() && !self.provisioner.is_installed(id).await {
            return Err(ServerError::NotInstalled(id));
        }
        Ok(self.provisioner.resolver())
    }
}

impl LaunchResolver for GatedResolver {
    async fn resolve(&self, id: ServerId) -> Result<LaunchSpec, ServerError> {
        Ok(self.gate(id).await?.resolve_typed(id, None).await?)
    }

    async fn resolve_for(&self, id: ServerId, root: &Path) -> Result<LaunchSpec, ServerError> {
        Ok(self.gate(id).await?.resolve_typed(id, Some(root)).await?)
    }
}
