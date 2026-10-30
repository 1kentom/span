//! The models each agent last advertised, so a lead can see them in
//! `list_agents` before the agent runs (ADR 0003, amendment of 2026-10-30).
//!
//! Filled from the `model` config option of every session the agent
//! reports, kept per agent name (lowercase) in memory and, once
//! [`set_model_cache`] named a file, as a small JSON file in app data. Only
//! model ids, display names and the model a new session started on are
//! kept: never prompts, titles or session ids. Nothing here is guessed: an
//! agent that never reported a model option has no entry.
use crate::ConfigOption;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, MutexGuard};

/// Most models kept per agent.
const MAX_MODELS: usize = 200;

/// One model an agent offered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedModel {
    pub id: String,
    pub name: String,
}

/// What one agent last advertised.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedModels {
    pub models: Vec<CachedModel>,
    /// The model a new session of this agent started on, when seen.
    #[serde(default)]
    pub default_model: Option<String>,
}

#[derive(Default)]
struct Cache {
    agents: BTreeMap<String, CachedModels>,
    path: Option<PathBuf>,
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Mutex::default);

fn cache() -> MutexGuard<'static, Cache> {
    CACHE.lock().unwrap_or_else(|p| p.into_inner())
}

fn save(cache: &Cache) {
    let Some(path) = &cache.path else {
        return;
    };
    if let Ok(bytes) = serde_json::to_vec_pretty(&cache.agents) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, bytes);
    }
}

/// The `model` option among `options`: category `model`, else id `model`.
pub fn model_option(options: &[ConfigOption]) -> Option<&ConfigOption> {
    options
        .iter()
        .find(|o| o.category.as_deref() == Some("model"))
        .or_else(|| options.iter().find(|o| o.id == "model"))
}

/// Every model `option` offers, in the agent's order, without repeats.
pub fn models_of(option: &ConfigOption) -> Vec<CachedModel> {
    let mut models: Vec<CachedModel> = Vec::new();
    for choice in option.groups.iter().flat_map(|g| &g.choices) {
        if models.iter().any(|m| m.id == choice.value) {
            continue;
        }
        models.push(CachedModel {
            id: choice.value.clone(),
            name: choice.name.clone(),
        });
    }
    models.truncate(MAX_MODELS);
    models
}

/// Keep the model list in the JSON file at `path`. Entries already in it
/// are loaded; entries recorded before this call are kept. A missing or
/// unreadable file starts empty.
pub fn set_model_cache(path: PathBuf) {
    let loaded: BTreeMap<String, CachedModels> = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let mut cache = cache();
    for (agent, models) in loaded {
        cache.agents.entry(agent).or_insert(models);
    }
    cache.path = Some(path);
}

/// Record the models `options` offer for `agent`. `started` is true for the
/// first options of a new session: its current model is the default.
pub fn remember_models(agent: &str, options: &[ConfigOption], started: bool) {
    let Some(option) = model_option(options) else {
        return;
    };
    let models = models_of(option);
    if models.is_empty() || agent.trim().is_empty() {
        return;
    }
    let mut cache = cache();
    let entry = cache.agents.entry(agent.to_lowercase()).or_default();
    let mut next = CachedModels {
        models,
        default_model: entry.default_model.clone(),
    };
    if started {
        next.default_model = Some(option.current_value.clone());
    }
    if *entry != next {
        *entry = next;
        save(&cache);
    }
}

/// Record `from`'s entry under `alias` too (an installed agent id whose
/// process reports another name).
pub fn alias_models(alias: &str, from: &str) {
    let mut cache = cache();
    let Some(found) = cache.agents.get(&from.to_lowercase()).cloned() else {
        return;
    };
    let key = alias.to_lowercase();
    if cache.agents.get(&key) != Some(&found) {
        cache.agents.insert(key, found);
        save(&cache);
    }
}

/// What `agent` last advertised, when it ever did.
pub fn cached_models(agent: &str) -> Option<CachedModels> {
    cache().agents.get(&agent.to_lowercase()).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ConfigChoice, ConfigGroup};

    fn option(current: &str) -> ConfigOption {
        ConfigOption {
            id: "model".into(),
            name: "Model".into(),
            description: None,
            category: Some("model".into()),
            current_value: current.into(),
            groups: vec![ConfigGroup {
                name: String::new(),
                choices: ["a", "b", "a"]
                    .iter()
                    .map(|v| ConfigChoice {
                        value: (*v).into(),
                        name: v.to_uppercase(),
                        description: None,
                    })
                    .collect(),
            }],
        }
    }

    #[test]
    fn remembers_ids_names_and_the_starting_model_only() {
        remember_models("Cache-Test-Agent", &[option("b")], true);
        remember_models("cache-test-agent", &[option("a")], false);
        let found = cached_models("CACHE-TEST-AGENT").unwrap();
        assert_eq!(found.models.len(), 2);
        assert_eq!(found.models[1].name, "B");
        assert_eq!(found.default_model.as_deref(), Some("b"));
        alias_models("cache-test-installed", "cache-test-agent");
        assert_eq!(cached_models("cache-test-installed"), Some(found));
        assert!(cached_models("cache-test-unknown").is_none());
    }
}
