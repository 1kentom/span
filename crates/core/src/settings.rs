use crate::{io_error, CoreError, CoreWorkspace, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::Path,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
pub enum Theme {
    #[default]
    Dark,
    Light,
    Purple,
}

/// Language server behaviour, stored under the `languageServers` settings key.
///
/// Nested settings objects ignore keys this build does not know, so a file written by a
/// newer build still loads in an older one (and is rewritten without losing them, see
/// `keep_unknown_nested`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct LanguageServerSettings {
    /// Download missing language servers on first use. When false, nothing is
    /// downloaded until the user asks for an install.
    pub auto_install: bool,
    /// Per-server switches keyed by server id (`vtsls`, `html`, `css`, `json`,
    /// `rust-analyzer`, `basedpyright`, `jdtls`, `svelte`, `vue`, `astro`). A server that is not listed is enabled.
    pub enabled: HashMap<String, bool>,
    /// JDK home used to run JDT LS, instead of searching the host.
    pub java_home: Option<String>,
    /// Node.js executable used to run the npm based servers, instead of searching the host.
    pub node_path: Option<String>,
    /// Let rust-analyzer and JDT LS run the project's own build code (build scripts,
    /// procedural macros, `cargo check` on save, Gradle and Maven import). Off by default
    /// because opening an untrusted project would otherwise execute its code.
    pub run_project_code: bool,
    /// DEPRECATED, read only. Preview builds stored per-workspace trust here. It is now kept
    /// in `trusted-workspaces.json` beside the other per-user state; a value found here is
    /// imported into that store once and never written back. `run_project_code` stays as a
    /// global override meaning "trust every folder".
    pub trusted_workspaces: Vec<String>,
    /// Directory names from the built in watched-file exclusions (`node_modules`, `target`,
    /// `dist`, `build`, `out`, `.next`, `.turbo`, `.cache`, `.pnpm-store`, `.span`) that
    /// language servers should be told about anyway. Version control folders stay excluded.
    pub watch_include_directories: Vec<String>,
    /// Server ids whose "fell behind on file changes" warning the user turned off.
    pub silenced_watch_warnings: Vec<String>,
}

/// Settings under `languageServers` that choose executables or trigger downloads. They are
/// honoured from user settings only: a workspace file is untrusted input.
pub const USER_ONLY_LANGUAGE_SERVER_KEYS: &[&str] = &[
    "autoInstall",
    "javaHome",
    "nodePath",
    "runProjectCode",
    "watchIncludeDirectories",
    "silencedWatchWarnings",
];

/// Most entries accepted in one of the list valued language server settings.
const MAX_LANGUAGE_SERVER_LIST: usize = 64;

/// Keys under `languageServers` that older preview builds wrote. They are accepted when
/// reading (never an error), dropped from workspace files like the user-only keys, and
/// refused for writing.
pub const DEPRECATED_LANGUAGE_SERVER_KEYS: &[&str] = &["trustedWorkspaces"];

/// Absolute on any OS, judged from the text alone: `/x`, `C:\x`, `C:/x` or `\\server\share`.
pub(crate) fn is_absolute_path_text(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || path.starts_with("\\\\")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/'))
}

pub const LANGUAGE_SERVER_IDS: &[&str] = &[
    "vtsls",
    "html",
    "css",
    "json",
    "rust-analyzer",
    "basedpyright",
    "jdtls",
    "svelte",
    "vue",
    "astro",
];

impl LanguageServerSettings {
    pub fn is_enabled(&self, server: &str) -> bool {
        self.enabled.get(server).copied().unwrap_or(true)
    }

    fn validate(&self) -> Result<()> {
        for server in self.enabled.keys() {
            if !LANGUAGE_SERVER_IDS.contains(&server.as_str()) {
                return Err(CoreError::Settings(format!(
                    "Unknown language server: {server}"
                )));
            }
        }
        if self.watch_include_directories.len() > MAX_LANGUAGE_SERVER_LIST
            || self.watch_include_directories.iter().any(|name| {
                name.is_empty()
                    || name.len() > 255
                    || name == "."
                    || name == ".."
                    || name.contains(['/', '\\'])
                    || name.chars().any(char::is_control)
            })
        {
            return Err(CoreError::Settings(
                "languageServers.watchIncludeDirectories must list at most 64 folder names".into(),
            ));
        }
        if self.silenced_watch_warnings.len() > MAX_LANGUAGE_SERVER_LIST {
            return Err(CoreError::Settings(
                "languageServers.silencedWatchWarnings lists too many servers".into(),
            ));
        }
        for server in &self.silenced_watch_warnings {
            if !LANGUAGE_SERVER_IDS.contains(&server.as_str()) {
                return Err(CoreError::Settings(format!(
                    "Unknown language server: {server}"
                )));
            }
        }
        for (name, value) in [("javaHome", &self.java_home), ("nodePath", &self.node_path)] {
            if let Some(value) = value {
                if value.trim().is_empty()
                    || value.len() > 4096
                    || value.chars().any(char::is_control)
                {
                    return Err(CoreError::Settings(format!(
                        "languageServers.{name} must be a path of at most 4096 characters"
                    )));
                }
                if !is_absolute_path_text(value) {
                    return Err(CoreError::Settings(format!(
                        "languageServers.{name} must be an absolute path"
                    )));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum AutoSaveMode {
    Off,
    #[default]
    AfterDelay,
    OnFocusChange,
    OnWindowChange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SettingsScope {
    User,
    Workspace,
}

impl SettingsScope {
    pub fn buffer_path(self) -> &'static str {
        match self {
            Self::User => "settings://user",
            Self::Workspace => "settings://workspace",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub theme: Theme,
    pub font_size: u32,
    pub tab_size: u32,
    pub word_wrap: bool,
    pub ui_font_size: u32,
    pub ui_font_family: String,
    pub editor_font_family: String,
    pub collapse_panels_on_drag: bool,
    pub markdown_preview_default: bool,
    pub format_on_save: bool,
    pub auto_save: AutoSaveMode,
    pub auto_save_delay: u32,
    pub tab_limit_enabled: bool,
    pub tab_limit: u32,
    pub tab_limit_per_group: bool,
    pub zoom_level: Option<f64>,
    pub keybindings: HashMap<String, Vec<String>>,
    pub formatters: HashMap<String, Vec<String>>,
    pub language_servers: LanguageServerSettings,
    /// `editor.syntaxColors`: per theme (`dark`, `light`, `purple`) overrides of the built in
    /// syntax palette, keyed by token id (see `SYNTAX_TOKEN_IDS`) with `#rgb`, `#rrggbb` or
    /// `#rrggbbaa` values. Empty means the UI default palettes. Optional in TypeScript so
    /// existing literals stay valid.
    #[specta(optional)]
    pub syntax_colors: HashMap<String, HashMap<String, String>>,
    /// Agent features. Optional in TypeScript so existing literals stay valid;
    /// a missing value means the defaults.
    #[specta(optional)]
    pub agents: AgentSettings,
    /// Update checks. Optional in TypeScript like `agents`.
    #[specta(optional)]
    pub updates: UpdateSettings,
    /// Explorer preferences. Optional in TypeScript like `agents`.
    #[specta(optional)]
    pub explorer: ExplorerSettings,
}

/// `updates.*`: update checks for the app and for agents (ADR 0004).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct UpdateSettings {
    /// Check once per launch, check-only, with a plain GET. Off by default.
    /// Honoured only from the user's own settings file.
    pub check_on_launch: bool,
}

/// `explorer.*`: file tree visibility and navigation preferences.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ExplorerSettings {
    /// Keep dotfiles and other hidden files visible, matching the current Explorer behavior.
    pub show_hidden_files: bool,
    /// Include files excluded by ignore rules in the Explorer.
    pub show_ignored_files: bool,
    /// Render a chain of single-child folders as one compact row.
    pub compact_folders: bool,
    /// Reveal the active file in the Explorer when it is outside the visible selection.
    pub auto_reveal: bool,
    /// Ask before deleting a file or folder.
    pub confirm_delete: bool,
}

/// Settings stored by the earlier local-storage based Explorer preferences.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ExplorerLegacyPreferences {
    pub compact_folders: Option<bool>,
    pub auto_reveal: Option<bool>,
    pub confirm_delete: Option<bool>,
}

/// Result of reconciling legacy Explorer values with the current settings scopes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerPreferenceMigration {
    pub settings: Settings,
    /// Legacy leaf names whose values were imported or already configured by the user.
    pub resolved_legacy_keys: Vec<String>,
}

impl Default for ExplorerSettings {
    fn default() -> Self {
        Self {
            show_hidden_files: true,
            show_ignored_files: false,
            compact_folders: true,
            auto_reveal: true,
            confirm_delete: true,
        }
    }
}

/// `agents.*` settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentSettings {
    pub delegation: DelegationSettings,
    pub run_tools: RunToolsSettings,
    /// `agents.warmStart`: when a folder opens, start installed agents in
    /// the background (process and ACP initialize only, no session) so a
    /// delegation or an agent switch does not wait for the start. On by
    /// default. Honoured only from the user's own settings file.
    pub warm_start: bool,
    /// `agents.healthCheck`: every five minutes, send one tiny prompt to
    /// each running agent Span is not chatting with, over a hidden session,
    /// and show whether it replied (ADR 0010). Never starts an agent. On by
    /// default. Honoured only from the user's own settings file.
    pub health_check: bool,
    /// `agents.startMode.<agent>`: the mode a session Span starts for that
    /// agent (`claude`, `codex`, `gemini`, `opencode`, `generic`) begins in.
    /// A missing entry means [`StartMode::Approval`]. Honoured only from the
    /// user's own settings file. Optional in TypeScript like `agents`.
    #[specta(optional)]
    pub start_mode: HashMap<String, StartMode>,
    /// `agents.usage.*`: the Usage page (ADR 0012). Honoured only from the
    /// user's own settings file. Optional in TypeScript like `agents`.
    #[specta(optional)]
    pub usage: AgentUsageSettings,
}

/// `agents.usage.*` settings (ADR 0012).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentUsageSettings {
    /// `agents.usage.prices.<model>`: the user's own USD per million token
    /// prices, keyed by model id or id prefix. They take precedence over the
    /// bundled price table.
    #[specta(optional)]
    pub prices: BTreeMap<String, crate::usage::PriceOverride>,
    /// `agents.usage.importLocalLogs`: read the agents' own local usage logs
    /// (Claude Code, Codex, Gemini CLI, OpenCode; read only, counters only)
    /// so the Usage page also shows sessions run outside Span. On by default
    /// since the owner reversed the opt-in (ADR 0012, amendment).
    #[specta(optional)]
    pub import_local_logs: bool,
}

impl Default for AgentUsageSettings {
    fn default() -> Self {
        AgentUsageSettings {
            prices: BTreeMap::new(),
            import_local_logs: true,
        }
    }
}

/// How a session Span starts treats the agent's own default mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum StartMode {
    /// Start in the agent's normal approval mode, so Span's approval prompts
    /// appear even when the agent's own configuration (for example a global
    /// `bypassPermissions` default) would skip them. Agent tools that reach
    /// other sessions on the machine are left out where the agent allows it.
    #[default]
    Approval,
    /// Keep whatever mode the agent's own configuration starts in.
    AgentDefault,
}

impl AgentSettings {
    /// The start mode for one agent kind.
    pub fn start_mode_for(&self, agent: &str) -> StartMode {
        self.start_mode.get(agent).copied().unwrap_or_default()
    }
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            delegation: DelegationSettings::default(),
            run_tools: RunToolsSettings::default(),
            warm_start: true,
            health_check: true,
            start_mode: HashMap::new(),
            usage: AgentUsageSettings::default(),
        }
    }
}

/// `agents.delegation.*`: the span-agents tool server (#52).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct DelegationSettings {
    /// Offer the delegation tools to new lead sessions of agents that
    /// advertise MCP over HTTP. On by default; the user can turn it off.
    /// Honoured only from the user's own settings file, and the depth and
    /// budget limits apply either way.
    pub enabled: bool,
}

impl Default for DelegationSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

/// `agents.runTools.*`: workspace run configuration tools offered to agents.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct RunToolsSettings {
    /// Offer run configuration tools to new lead sessions. Off by default.
    pub enabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::Dark,
            font_size: 13,
            tab_size: 2,
            word_wrap: false,
            ui_font_size: 13,
            ui_font_family: "Inter".into(),
            editor_font_family: "JetBrains Mono".into(),
            collapse_panels_on_drag: true,
            markdown_preview_default: true,
            format_on_save: false,
            auto_save: AutoSaveMode::AfterDelay,
            auto_save_delay: 1000,
            tab_limit_enabled: true,
            tab_limit: 10,
            tab_limit_per_group: false,
            zoom_level: None,
            keybindings: HashMap::new(),
            formatters: HashMap::new(),
            language_servers: LanguageServerSettings::default(),
            syntax_colors: HashMap::new(),
            agents: AgentSettings::default(),
            updates: UpdateSettings::default(),
            explorer: ExplorerSettings::default(),
        }
    }
}
impl Settings {
    pub fn validate(&self) -> Result<()> {
        if !(1..=200).contains(&self.tab_limit) {
            return Err(CoreError::Settings(
                "tabLimit must be between 1 and 200".into(),
            ));
        }
        if self.auto_save_delay > 3_600_000 {
            return Err(CoreError::Settings(
                "autoSaveDelay must be between 0 and 3600000 milliseconds".into(),
            ));
        }
        if self
            .zoom_level
            .is_some_and(|level| !level.is_finite() || !(-5.0..=5.0).contains(&level))
        {
            return Err(CoreError::Settings(
                "zoomLevel must be between -5 and 5".into(),
            ));
        }
        if !(8..=40).contains(&self.font_size) {
            return Err(CoreError::Settings(
                "fontSize must be between 8 and 40".into(),
            ));
        }
        if !(1..=8).contains(&self.tab_size) {
            return Err(CoreError::Settings(
                "tabSize must be between 1 and 8".into(),
            ));
        }
        if !(10..=24).contains(&self.ui_font_size) {
            return Err(CoreError::Settings(
                "uiFontSize must be between 10 and 24".into(),
            ));
        }
        for (name, family) in [
            ("uiFontFamily", &self.ui_font_family),
            ("editorFontFamily", &self.editor_font_family),
        ] {
            if family.trim().is_empty()
                || family.len() > 200
                || family.chars().any(char::is_control)
            {
                return Err(CoreError::Settings(format!(
                    "{name} must be a font family between 1 and 200 characters"
                )));
            }
        }
        for (command, shortcuts) in &self.keybindings {
            if !COMMAND_IDS.contains(&command.as_str()) {
                return Err(CoreError::Settings(format!(
                    "Unknown keyboard command: {command}"
                )));
            }
            if shortcuts.len() > 4 {
                return Err(CoreError::Settings(format!(
                    "At most four shortcuts are allowed for {command}"
                )));
            }
            for shortcut in shortcuts {
                validate_shortcut(shortcut)?;
            }
        }
        validate_shortcut_collisions(&self.keybindings)?;
        self.language_servers.validate()?;
        validate_syntax_colors(&self.syntax_colors)?;
        for (language, argv) in &self.formatters {
            if language.is_empty()
                || language.len() > 64
                || !language
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
            {
                return Err(CoreError::Settings(format!(
                    "Invalid formatter language: {language}"
                )));
            }
            if argv.is_empty()
                || argv.len() > 64
                || argv[0].trim().is_empty()
                || argv
                    .iter()
                    .any(|arg| arg.len() > 4096 || arg.contains('\0'))
            {
                return Err(CoreError::Settings(format!(
                    "Formatter {language} requires an executable and valid argument list"
                )));
            }
        }
        Ok(())
    }
}

/// Every rebindable command id. The TypeScript `actionDefinitions` table and the JSON schema
/// list the same ids in the same order, and tests compare them.
pub const COMMAND_IDS: &[&str] = &[
    "quickOpen",
    "toggleFiles",
    "focusFiles",
    "openFile",
    "commandPalette",
    "findInFile",
    "searchWorkspace",
    "settings",
    "closeTab",
    "save",
    "openFolder",
    "splitEditor",
    "splitEditorDown",
    "newFile",
    "newFolder",
    "newFromTemplate",
    "toggleProject",
    "toggleAssistant",
    "toggleTerminal",
    "showSourceControl",
    "nextGitChange",
    "previousGitChange",
    "toggleGitBlame",
    "toggleWordWrap",
    "markdownPreview",
    "formatDocument",
    "formatWithLanguageServer",
    "goToLine",
    "zoomIn",
    "zoomOut",
    "resetZoom",
    "goToDefinition",
    "goToTypeDefinition",
    "goToImplementation",
    "peekDefinition",
    "peekTypeDefinition",
    "peekImplementation",
    "findReferences",
    "peekReferences",
    "goToSymbolInFile",
    "goToSymbolInWorkspace",
    "quickInfo",
    "showCallHierarchy",
    "showTypeHierarchy",
    "renameSymbol",
    "goBack",
    "goForward",
    "focusBreadcrumbs",
    "showUsage",
    "toggleZenMode",
];

/// Commands introduced after shortcuts could already be saved. Like Toggle Files,
/// a default is dropped when an explicit binding already claims the same key, so adding a default
/// never invalidates an existing settings file.
const INHERITED_DEFAULT_IDS: &[&str] = &[
    "toggleFiles",
    "focusFiles",
    "showSourceControl",
    "nextGitChange",
    "previousGitChange",
    "toggleGitBlame",
    "splitEditorDown",
    "newFile",
    "newFolder",
    "newFromTemplate",
    "goToDefinition",
    "goToTypeDefinition",
    "goToImplementation",
    "peekDefinition",
    "peekTypeDefinition",
    "peekImplementation",
    "findReferences",
    "peekReferences",
    "goToSymbolInFile",
    "goToSymbolInWorkspace",
    "quickInfo",
    "showCallHierarchy",
    "showTypeHierarchy",
    "renameSymbol",
    "goBack",
    "goForward",
    "focusBreadcrumbs",
    "toggleZenMode",
];

/// Themes that can carry `editor.syntaxColors`.
pub const SYNTAX_THEMES: &[&str] = &["dark", "light", "purple"];

/// Token ids that `editor.syntaxColors.<theme>` can colour. The TypeScript `syntaxTokenIds`
/// list is identical and tested equal.
pub const SYNTAX_TOKEN_IDS: &[&str] = &[
    "keyword",
    "controlKeyword",
    "operator",
    "punctuation",
    "comment",
    "docComment",
    "string",
    "number",
    "constant",
    "boolean",
    "function",
    "method",
    "type",
    "class",
    "interface",
    "enum",
    "typeParameter",
    "variable",
    "parameter",
    "property",
    "namespace",
    "importPath",
    "annotation",
    "macro",
    "label",
    "tag",
    "attribute",
    "regexp",
    "escape",
    "invalid",
];

/// Only literal hex colours: `#rgb`, `#rrggbb` or `#rrggbbaa`. Nothing that a stylesheet could
/// evaluate (functions, variables, names) is accepted.
fn is_hex_color(value: &str) -> bool {
    let Some(digits) = value.strip_prefix('#') else {
        return false;
    };
    matches!(digits.len(), 3 | 6 | 8) && digits.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_syntax_colors(colors: &HashMap<String, HashMap<String, String>>) -> Result<()> {
    let mut total = 0;
    for (theme, tokens) in colors {
        if !SYNTAX_THEMES.contains(&theme.as_str()) {
            return Err(CoreError::Settings(format!(
                "editor.syntaxColors: unknown theme \"{theme}\" (use dark, light or purple)"
            )));
        }
        for (token, color) in tokens {
            if !SYNTAX_TOKEN_IDS.contains(&token.as_str()) {
                return Err(CoreError::Settings(format!(
                    "editor.syntaxColors.{theme}: unknown token \"{token}\""
                )));
            }
            if !is_hex_color(color) {
                return Err(CoreError::Settings(format!(
                    "editor.syntaxColors.{theme}.{token}: colour must be #rgb, #rrggbb or #rrggbbaa"
                )));
            }
            total += 1;
        }
    }
    if total > SYNTAX_THEMES.len() * SYNTAX_TOKEN_IDS.len() {
        return Err(CoreError::Settings(
            "editor.syntaxColors has too many entries".into(),
        ));
    }
    Ok(())
}

// Normalize keyboard naming variants before validation and collision checks.
fn normalize_zoom_shortcut(shortcut: &str) -> String {
    let value = if let Some(prefix) = shortcut.strip_suffix("++") {
        format!("{prefix}+Plus")
    } else {
        shortcut.to_owned()
    };
    let Some((prefix, key)) = value.rsplit_once('+') else {
        return value;
    };
    let mut modifiers: Vec<&str> = prefix.split('+').collect();
    let key = match key.to_ascii_lowercase().as_str() {
        "equal" | "numpadequal" => "=",
        "plus" => {
            if !modifiers.contains(&"Shift") {
                modifiers.push("Shift");
            }
            "="
        }
        "numpadplus" | "numpadadd" => "=",
        "minus" | "numpadminus" | "numpadsubtract" => "-",
        "numpad0" => "0",
        _ => key,
    };
    format!("{}+{key}", modifiers.join("+"))
}

fn validate_shortcut(shortcut: &str) -> Result<()> {
    let normalized = normalize_zoom_shortcut(shortcut);
    let shortcut = normalized.as_str();
    let parts: Vec<&str> = shortcut.split('+').collect();
    let invalid = || CoreError::Settings(format!("Invalid portable shortcut: {shortcut}"));
    if parts.is_empty() || parts.len() > 5 || shortcut.len() > 80 {
        return Err(invalid());
    }
    let (key, modifiers) = parts.split_last().ok_or_else(invalid)?;
    if key.is_empty() || key.chars().any(char::is_control) || key.contains(' ') {
        return Err(invalid());
    }
    // Function keys may stand alone or with Shift only (F12, Shift+F12). Every other key needs
    // a command modifier so ordinary typing is never captured.
    let function_key = key
        .strip_prefix('F')
        .and_then(|value| value.parse::<u8>().ok())
        .is_some_and(|value| (1..=24).contains(&value));
    if !function_key
        && !modifiers
            .iter()
            .any(|modifier| matches!(*modifier, "Mod" | "Ctrl" | "Alt" | "Meta" | "Cmd"))
    {
        return Err(invalid());
    }
    let mut seen = std::collections::HashSet::new();
    for modifier in modifiers {
        if !matches!(*modifier, "Mod" | "Ctrl" | "Alt" | "Shift" | "Meta" | "Cmd")
            || !seen.insert(*modifier)
        {
            return Err(invalid());
        }
    }
    let named_key = matches!(
        *key,
        "Enter"
            | "Escape"
            | "Tab"
            | "Space"
            | "Backspace"
            | "Delete"
            | "Insert"
            | "Home"
            | "End"
            | "PageUp"
            | "PageDown"
            | "ArrowUp"
            | "ArrowDown"
            | "ArrowLeft"
            | "ArrowRight"
    );
    let single_key = key.len() == 1
        && key
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || b"`\\[],./;'=-".contains(byte));
    if !single_key && !named_key && !function_key {
        return Err(invalid());
    }
    if key.eq_ignore_ascii_case("q")
        && modifiers
            .iter()
            .any(|modifier| matches!(*modifier, "Mod" | "Ctrl" | "Cmd" | "Meta"))
    {
        return Err(CoreError::Settings(
            "The application quit shortcut is reserved".into(),
        ));
    }
    // Text editing keys use one command modifier (Cmd+Z, Ctrl+Z). Both Control and Command together
    // (Ctrl+Cmd+Z, the macOS Zen mode default) is not an editing shortcut.
    let primaries = modifiers
        .iter()
        .filter_map(|modifier| match *modifier {
            "Mod" if cfg!(target_os = "macos") => Some("Meta"),
            "Mod" | "Ctrl" => Some("Ctrl"),
            "Cmd" | "Meta" => Some("Meta"),
            _ => None,
        })
        .collect::<std::collections::HashSet<_>>();
    let primary = primaries.len() == 1;
    let editing_modifiers = modifiers
        .iter()
        .all(|modifier| matches!(*modifier, "Mod" | "Ctrl" | "Cmd" | "Meta" | "Shift"));
    let shifted = modifiers.contains(&"Shift");
    let text_key = matches!(
        key.to_ascii_lowercase().as_str(),
        "a" | "c" | "v" | "x" | "z" | "y"
    );
    if primary && editing_modifiers && text_key && (!shifted || key.eq_ignore_ascii_case("z")) {
        return Err(CoreError::Settings(
            "Standard text editing shortcuts are reserved".into(),
        ));
    }
    Ok(())
}

fn shortcut_conflict_key(shortcut: &str) -> Result<String> {
    let normalized = normalize_zoom_shortcut(shortcut);
    let shortcut = normalized.as_str();
    let mut parts: Vec<&str> = shortcut.split('+').collect();
    let key = parts
        .pop()
        .ok_or_else(|| CoreError::Settings("Empty shortcut".into()))?
        .to_ascii_uppercase();
    let mut modifiers: Vec<&str> = parts
        .into_iter()
        .map(|modifier| match modifier {
            "Mod" => {
                if cfg!(target_os = "macos") {
                    "Meta"
                } else {
                    "Ctrl"
                }
            }
            "Cmd" => "Meta",
            other => other,
        })
        .collect();
    modifiers.sort_unstable();
    if modifiers.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(CoreError::Settings(format!(
            "Duplicate shortcut modifier: {shortcut}"
        )));
    }
    Ok(format!("{}+{key}", modifiers.join("+")))
}

fn validate_shortcut_collisions(overrides: &HashMap<String, Vec<String>>) -> Result<()> {
    let defaults = [
        ("quickOpen", vec!["Mod+P"]),
        ("toggleFiles", vec!["Mod+E"]),
        ("focusFiles", vec!["Mod+Shift+E"]),
        ("openFile", vec![]),
        ("commandPalette", vec!["Mod+Shift+P"]),
        ("findInFile", vec!["Mod+F"]),
        ("searchWorkspace", vec!["Mod+Shift+F"]),
        ("settings", vec!["Mod+,"]),
        ("closeTab", vec!["Mod+W"]),
        ("save", vec!["Mod+S"]),
        ("openFolder", vec!["Mod+O"]),
        ("splitEditor", vec!["Mod+\\"]),
        ("splitEditorDown", vec!["Mod+Alt+\\"]),
        ("newFile", vec!["Mod+N"]),
        ("newFolder", vec!["Mod+Shift+N"]),
        ("newFromTemplate", vec!["Alt+Insert"]),
        ("toggleProject", vec!["Mod+B"]),
        ("toggleAssistant", vec!["Mod+Alt+B"]),
        ("toggleTerminal", vec!["Mod+J"]),
        ("showSourceControl", vec!["Ctrl+Shift+G"]),
        ("nextGitChange", vec!["Alt+F5"]),
        ("previousGitChange", vec!["Alt+Shift+F5"]),
        ("toggleGitBlame", vec![]),
        ("toggleWordWrap", vec!["Alt+Z"]),
        ("markdownPreview", vec!["Mod+Shift+V"]),
        ("formatDocument", vec!["Alt+Shift+F"]),
        ("formatWithLanguageServer", vec!["Mod+Alt+Shift+F"]),
        ("goToLine", vec!["Ctrl+G", "Mod+Alt+G"]),
        ("zoomIn", vec!["Mod+=", "Mod+Shift+="]),
        ("zoomOut", vec!["Mod+-"]),
        ("resetZoom", vec!["Mod+0"]),
        ("goToDefinition", vec!["F12"]),
        ("goToTypeDefinition", vec!["Mod+Shift+F12"]),
        ("goToImplementation", vec!["Mod+F12"]),
        ("peekDefinition", vec!["Alt+F12"]),
        ("peekTypeDefinition", vec![]),
        ("peekImplementation", vec![]),
        ("findReferences", vec!["Shift+F12"]),
        ("peekReferences", vec!["Shift+Alt+F12"]),
        ("goToSymbolInFile", vec!["Mod+Shift+O"]),
        ("goToSymbolInWorkspace", vec!["Mod+T"]),
        ("quickInfo", vec!["Mod+Shift+I"]),
        ("showCallHierarchy", vec!["Shift+Alt+H"]),
        ("showTypeHierarchy", vec!["Mod+Alt+H"]),
        ("renameSymbol", vec!["F2"]),
        ("goBack", vec!["Mod+Alt+ArrowLeft"]),
        ("goForward", vec!["Mod+Alt+ArrowRight"]),
        ("focusBreadcrumbs", vec!["Mod+Shift+."]),
        ("showUsage", vec![]),
        // VS Code's Cmd+K Z needs a chord, which Span does not have: Ctrl+Cmd+Z on macOS, Ctrl+Alt+Z elsewhere.
        (
            "toggleZenMode",
            if cfg!(target_os = "macos") {
                vec!["Meta+Ctrl+Z"]
            } else {
                vec!["Ctrl+Alt+Z"]
            },
        ),
    ];
    let claimed = overrides
        .values()
        .flatten()
        .map(|key| shortcut_conflict_key(key))
        .collect::<Result<std::collections::HashSet<_>>>()?;
    let mut assigned = HashMap::new();
    for (command, mut defaults) in defaults {
        if INHERITED_DEFAULT_IDS.contains(&command) {
            defaults.retain(|shortcut| {
                !claimed.contains(&shortcut_conflict_key(shortcut).expect("valid default shortcut"))
            });
        }
        if command == "quickOpen" && cfg!(target_os = "macos") {
            defaults.push("Ctrl+P");
        }
        let shortcuts: Vec<&str> = match overrides.get(command) {
            Some(items) => items.iter().map(String::as_str).collect(),
            None => defaults,
        };
        for shortcut in shortcuts {
            let normalized = shortcut_conflict_key(shortcut)?;
            if let Some(existing) = assigned.insert(normalized, command) {
                if existing == command {
                    continue;
                }
                return Err(CoreError::Settings(format!(
                    "Shortcut {shortcut} conflicts with {existing}"
                )));
            }
        }
    }
    Ok(())
}

pub(crate) fn load(user: Option<&Path>, workspace: &Path) -> Result<Settings> {
    let mut value = serde_json::to_value(Settings::default())
        .map_err(|e| CoreError::Settings(e.to_string()))?;
    if let Some(path) = user {
        merge_file(&mut value, path)?;
    }
    if let Some(workspace) = read_file(workspace)? {
        merge(&mut value, without_user_only(workspace));
    }
    decode(value)
}

/// Settings honoured only from the user's own settings file. A workspace
/// `.span/settings.jsonc` arrives with the repository, so a cloned project
/// must not be able to change these: `agents.delegation.enabled` lets an
/// agent start other agents (ADR 0003), and `agents.runTools.enabled` lets an
/// agent run a saved process. These keys are dropped from workspace settings
/// before merging.
const USER_ONLY: &[&[&str]] = &[
    &["agents", "delegation", "enabled"],
    &["agents", "runTools", "enabled"],
    // Starts agent processes when a folder opens (ADR 0009).
    &["agents", "warmStart"],
    // Sends prompts to running agents in the background (ADR 0010).
    &["agents", "healthCheck"],
    // A cloned project must not make agents skip approval prompts.
    &["agents", "startMode"],
    // A cloned project must not change what the Usage page reports (ADR 0012).
    &["agents", "usage"],
    // A cloned project must not make Span contact the network at launch.
    &["updates", "checkOnLaunch"],
];

impl CoreWorkspace {
    /// Imports legacy Explorer preferences into user settings only when neither scope has
    /// configured that typed preference. Callers serialize this operation with other
    /// workspace commands so the read/check/write is one transaction.
    pub fn migrate_explorer_preferences(
        &self,
        legacy: ExplorerLegacyPreferences,
    ) -> Result<ExplorerPreferenceMigration> {
        let user = self.get_settings_jsonc_for_scope(SettingsScope::User)?;
        let workspace = self.get_settings_jsonc_for_scope(SettingsScope::Workspace)?;

        // Validate both files independently before preparing any write. In particular, a
        // malformed workspace file must not result in a partial import to user settings.
        load_with_texts(&user, "{}")?;
        load_with_texts("{}", &workspace)?;

        let user_configured = explicit_explorer_preferences(&user)?;
        let workspace_configured = explicit_explorer_preferences(&workspace)?;
        let candidates = [
            ("compactFolders", legacy.compact_folders),
            ("autoReveal", legacy.auto_reveal),
            ("confirmDelete", legacy.confirm_delete),
        ];
        let mut patched = user.clone();
        let mut resolved_legacy_keys = Vec::new();
        for (leaf, legacy_value) in candidates {
            if let Some(value) = legacy_value {
                if user_configured.contains(leaf) {
                    resolved_legacy_keys.push(leaf.to_owned());
                } else if !workspace_configured.contains(leaf) {
                    patched = patch_in_scope(
                        SettingsScope::User,
                        &patched,
                        &format!("explorer.{leaf}"),
                        Some(if value { "true" } else { "false" }),
                    )?;
                    resolved_legacy_keys.push(leaf.to_owned());
                }
            }
        }
        let settings = if patched == user {
            load_with_texts(&user, &workspace)?
        } else {
            if self.has_dirty_settings_buffer() {
                return Err(CoreError::Settings(
                    "Save or discard the open settings draft before importing Explorer preferences"
                        .into(),
                ));
            }
            self.update_settings_jsonc_for_scope(SettingsScope::User, &patched)?
        };
        Ok(ExplorerPreferenceMigration {
            settings,
            resolved_legacy_keys,
        })
    }

    /// Run tools are an execution capability, so repository settings cannot
    /// enable them for an agent. Read only the user's settings scope.
    pub fn run_tools_enabled(&self) -> Result<bool> {
        Ok(self
            .get_settings_for_scope(SettingsScope::User)?
            .agents
            .run_tools
            .enabled)
    }

    /// The start mode for sessions of one agent kind. Read only the user's
    /// settings scope, so a repository cannot make an agent skip approvals.
    pub fn agent_start_mode(&self, agent: &str) -> Result<StartMode> {
        Ok(self
            .get_settings_for_scope(SettingsScope::User)?
            .agents
            .start_mode_for(agent))
    }

    /// Change the explicit user-only opt-in without rewriting workspace
    /// settings or dropping unrelated JSONC comments.
    pub fn set_run_tools_enabled(&self, enabled: bool) -> Result<Settings> {
        let text = self.get_settings_jsonc_for_scope(SettingsScope::User)?;
        let patched = patch_nested_key(
            &text,
            &["agents", "runTools", "enabled"],
            Value::Bool(enabled),
        )?;
        self.update_settings_jsonc_for_scope(SettingsScope::User, &patched)
    }
}

/// Patch an explicit nested opt-in while retaining unrelated JSONC bytes, including comments.
fn patch_nested_key(text: &str, path: &[&str], value: Value) -> Result<String> {
    parse(text)?;
    let Some((key, rest)) = path.split_first() else {
        return Err(CoreError::Settings("Empty preference path".into()));
    };
    let mask = comment_mask(text);
    let mut index = skip_space(&mask, 0) + 1;
    let mut members = 0;
    let mut matching = None;
    loop {
        index = skip_space(&mask, index);
        if mask.get(index) == Some(&b'}') {
            if let Some((value_start, end)) = matching {
                let replacement = if rest.is_empty() {
                    value.to_string()
                } else {
                    patch_nested_key(&text[value_start..end], rest, value)?
                };
                let mut patched = text.to_owned();
                patched.replace_range(value_start..end, &replacement);
                parse(&patched)?;
                return Ok(patched);
            }
            let mut nested = value;
            for segment in rest.iter().rev() {
                let mut object = serde_json::Map::new();
                object.insert((*segment).to_owned(), nested);
                nested = Value::Object(object);
            }
            let member = format!(
                "{}: {}",
                serde_json::to_string(key)
                    .map_err(|error| CoreError::Settings(error.to_string()))?,
                nested
            );
            let previous = mask[..index]
                .iter()
                .rfind(|byte| !byte.is_ascii_whitespace());
            let comma = if members > 0 && previous != Some(&b',') {
                ","
            } else {
                ""
            };
            let mut patched = text.to_owned();
            patched.insert_str(index, &format!("{comma}\n  {member}\n"));
            parse(&patched)?;
            return Ok(patched);
        }
        let start = index;
        index = string_end(&mask, index);
        let member_key: String = serde_json::from_slice(&mask[start..index])
            .map_err(|error| CoreError::Settings(error.to_string()))?;
        index = skip_space(&mask, index) + 1;
        let value_start = skip_space(&mask, index);
        index = value_start;
        let mut depth = 0;
        while index < mask.len() {
            match mask[index] {
                b'"' => {
                    index = string_end(&mask, index);
                    continue;
                }
                b'{' | b'[' => depth += 1,
                b'}' if depth == 0 => break,
                b'}' | b']' => depth -= 1,
                b',' if depth == 0 => break,
                _ => {}
            }
            index += 1;
        }
        let mut end = index;
        while end > value_start && mask[end - 1].is_ascii_whitespace() {
            end -= 1;
        }
        if member_key == *key {
            matching = Some((value_start, end));
        }
        members += 1;
        if mask.get(index) == Some(&b',') {
            index += 1;
        }
    }
}

pub(crate) fn without_user_only(mut value: Value) -> Value {
    drop_user_only(&mut value);
    for path in USER_ONLY {
        let Some((last, parents)) = path.split_last() else {
            continue;
        };
        let mut node = Some(&mut value);
        for key in parents {
            node = node.and_then(|n| n.get_mut(*key));
        }
        if let Some(object) = node.and_then(Value::as_object_mut) {
            object.remove(*last);
        }
    }
    value
}

fn decode(value: Value) -> Result<Settings> {
    let settings: Settings =
        serde_json::from_value(value).map_err(|e| CoreError::Settings(e.to_string()))?;
    settings.validate()?;
    Ok(settings)
}

fn merge_file(target: &mut Value, path: &Path) -> Result<()> {
    if let Some(value) = read_file(path)? {
        merge(target, value);
    }
    Ok(())
}

fn read_file(path: &Path) -> Result<Option<Value>> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_error("Read settings", path, e)),
    };
    let value =
        parse(&text).map_err(|e| CoreError::Settings(format!("{}: {e}", path.display())))?;
    normalize(value).map(Some)
}

/// A workspace settings file can be written by anyone who can put files in a repository,
/// so it must not choose executables or trigger downloads. Load ignores these keys there
/// (writes through `update_setting` and `update_settings_jsonc` reject them with an error).
fn drop_user_only(value: &mut Value) {
    if let Some(servers) = value
        .get_mut("languageServers")
        .and_then(Value::as_object_mut)
    {
        for key in USER_ONLY_LANGUAGE_SERVER_KEYS
            .iter()
            .chain(DEPRECATED_LANGUAGE_SERVER_KEYS)
        {
            servers.remove(*key);
        }
    }
}

/// Error naming the first user-only key present in workspace settings text.
#[cfg(test)]
pub(crate) fn reject_user_only(text: &str) -> Result<()> {
    reject_changed_user_only("{}", text)
}

/// Like [`reject_user_only`], but a user-only key that `previous` already holds with the
/// same value is tolerated: the file arrived that way (it is ignored on read) and an
/// unrelated write must not fail because of it. Adding or changing one is still an error.
pub(crate) fn reject_changed_user_only(previous: &str, text: &str) -> Result<()> {
    let value = parse(text)?;
    let Some(servers) = value.get("languageServers").and_then(Value::as_object) else {
        return Ok(());
    };
    // An unreadable previous file cannot excuse anything.
    let before = parse(previous).unwrap_or(Value::Null);
    let before = before.get("languageServers").and_then(Value::as_object);
    for key in USER_ONLY_LANGUAGE_SERVER_KEYS {
        if let Some(now) = servers.get(*key) {
            if before.and_then(|b| b.get(*key)) != Some(now) {
                return Err(user_only_error(key));
            }
        }
    }
    Ok(())
}

fn user_only_error(key: &str) -> CoreError {
    CoreError::Settings(format!(
        "languageServers.{key} can be set in user settings only"
    ))
}

/// Nested settings objects (dotted path) whose keys are a fixed list in this build.
const STRUCT_PATHS: &[&[&str]] = &[
    &["languageServers"],
    &["agents"],
    &["agents", "delegation"],
    &["agents", "usage"],
    &["updates"],
    &["explorer"],
];

fn at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(value, |node, key| node.get(*key))
}

/// Loading ignores nested keys this build does not know (they may come from a newer build).
/// An explicit edit of the settings text is still checked: a typo in a nested key is an
/// error, unless the previous text already held that key (it arrived from elsewhere and an
/// unrelated edit must not fail because of it).
pub(crate) fn reject_new_unknown_nested(previous: &str, text: &str) -> Result<()> {
    let now = normalize(parse(text)?)?;
    let before = parse(previous).and_then(normalize).unwrap_or(Value::Null);
    let template = serde_json::to_value(Settings::default())
        .map_err(|error| CoreError::Settings(error.to_string()))?;
    for path in STRUCT_PATHS {
        let (Some(Value::Object(current)), Some(Value::Object(known))) =
            (at_path(&now, path), at_path(&template, path))
        else {
            continue;
        };
        for key in current.keys() {
            let is_known = known.contains_key(key);
            let was_there = at_path(&before, path).and_then(|b| b.get(key)).is_some();
            if !is_known && !was_there {
                return Err(CoreError::Settings(format!(
                    "unknown field `{key}` in {}",
                    path.join(".")
                )));
            }
        }
    }
    Ok(())
}

/// A typed save rewrites a whole nested object. Keys this build does not know are carried
/// over from the raw file verbatim so a write never drops what a newer build stored.
pub(crate) fn keep_unknown_nested(raw: &Value, key: &str, value: &mut Value) {
    for path in STRUCT_PATHS {
        if path[0] != key {
            continue;
        }
        let rest = &path[1..];
        let (Some(Value::Object(old)), Some(target)) = (
            at_path(raw, &path[..1]).and_then(|v| at_path(v, rest)),
            rest.iter()
                .try_fold(&mut *value, |node, k| node.get_mut(*k)),
        ) else {
            continue;
        };
        let Some(new) = target.as_object_mut() else {
            continue;
        };
        for (k, v) in old {
            if !new.contains_key(k) {
                new.insert(k.clone(), v.clone());
            }
        }
    }
}

pub(crate) fn parse(text: &str) -> Result<Value> {
    let mut value: Value = serde_json::from_str(&strip_jsonc(text)?)
        .map_err(|e| CoreError::Settings(e.to_string()))?;
    if !value.is_object() {
        return Err(CoreError::Settings(
            "Settings must contain an object".into(),
        ));
    }
    if let Some(schema) = value
        .as_object_mut()
        .and_then(|object| object.remove("$schema"))
    {
        if !schema.is_string() {
            return Err(CoreError::Settings("$schema must be a string".into()));
        }
    }
    Ok(value)
}

pub(crate) const ALIASES: &[(&str, &str)] = &[
    ("files.autoSave", "autoSave"),
    ("files.autoSaveDelay", "autoSaveDelay"),
    ("editor.wordWrap", "wordWrap"),
    ("editor.fontSize", "fontSize"),
    ("editor.fontFamily", "editorFontFamily"),
    ("editor.tabSize", "tabSize"),
    ("editor.formatOnSave", "formatOnSave"),
    ("editor.syntaxColors", "syntaxColors"),
    ("window.zoomLevel", "zoomLevel"),
    ("workbench.editor.limit.enabled", "tabLimitEnabled"),
    ("workbench.editor.limit.value", "tabLimit"),
    ("workbench.editor.limit.perEditorGroup", "tabLimitPerGroup"),
];

const EXPLORER_LEAVES: &[&str] = &[
    "showHiddenFiles",
    "showIgnoredFiles",
    "compactFolders",
    "autoReveal",
    "confirmDelete",
];

fn normalize(mut value: Value) -> Result<Value> {
    let object = value.as_object_mut().expect("parsed settings object");
    for (alias, key) in ALIASES {
        if let Some(mut configured) = object.remove(*alias) {
            if *alias == "editor.wordWrap" {
                configured = match configured.as_str() {
                    Some("on") => Value::Bool(true),
                    Some("off") => Value::Bool(false),
                    _ => return Err(CoreError::Settings("editor.wordWrap supports on or off; bounded and wordWrapColumn are not implemented".into())),
                };
            }
            object.insert((*key).into(), configured);
        }
    }
    for leaf in EXPLORER_LEAVES {
        let dotted = format!("explorer.{leaf}");
        let Some(configured) = object.remove(&dotted) else {
            continue;
        };
        let explorer = object
            .entry("explorer")
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        let Some(explorer) = explorer.as_object_mut() else {
            return Err(CoreError::Settings("explorer must be an object".into()));
        };
        // Dotted settings are the canonical alias when both spellings occur in one file.
        explorer.insert((*leaf).into(), configured);
    }
    Ok(value)
}

pub(crate) fn explicit_explorer_preferences(
    text: &str,
) -> Result<std::collections::HashSet<String>> {
    let normalized = normalize(parse(text)?)?;
    Ok(normalized
        .get("explorer")
        .and_then(Value::as_object)
        .map(|preferences| preferences.keys().cloned().collect())
        .unwrap_or_default())
}

pub(crate) fn load_with_texts(user: &str, workspace: &str) -> Result<Settings> {
    let mut value = serde_json::to_value(Settings::default())
        .map_err(|error| CoreError::Settings(error.to_string()))?;
    merge(&mut value, normalize(parse(user)?)?);
    merge(&mut value, without_user_only(normalize(parse(workspace)?)?));
    decode(value)
}

pub(crate) fn canonical_key(key: &str) -> Option<String> {
    if let Some((_, canonical)) = ALIASES.iter().find(|(alias, _)| *alias == key) {
        return Some((*canonical).into());
    }
    serde_json::to_value(Settings::default())
        .ok()?
        .as_object()?
        .contains_key(key)
        .then(|| key.into())
}

/// Edits one setting in `scope`. Besides top-level keys it accepts exactly
/// `languageServers.enabled.<serverId>` and, in user scope only,
/// `languageServers.autoInstall`, `languageServers.runProjectCode`, `languageServers.javaHome`
/// and `languageServers.nodePath`.
/// A missing value removes the key.
pub(crate) fn patch_in_scope(
    scope: crate::SettingsScope,
    text: &str,
    key: &str,
    value_json: Option<&str>,
) -> Result<String> {
    if let Some(rest) = key.strip_prefix("explorer.") {
        return patch_explorer(text, rest, value_json);
    }
    if let Some(rest) = key
        .strip_prefix("editor.syntaxColors.")
        .or_else(|| key.strip_prefix("syntaxColors."))
    {
        return patch_syntax_color(text, rest, value_json);
    }
    let Some(rest) = key.strip_prefix("languageServers.") else {
        return patch(text, key, value_json);
    };
    let unsupported = || CoreError::Settings(format!("Unsupported setting: {key}"));
    let value = value_json
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(|error| CoreError::Settings(error.to_string()))?
        .filter(|v| !v.is_null());
    let root = parse(text)?;
    let existing = root.get("languageServers").cloned();
    let mut servers = match existing {
        None => serde_json::Map::new(),
        Some(Value::Object(map)) => map,
        Some(_) => {
            return Err(CoreError::Settings(
                "languageServers must be an object".into(),
            ))
        }
    };
    if let Some(id) = rest.strip_prefix("enabled.") {
        if !LANGUAGE_SERVER_IDS.contains(&id) {
            return Err(CoreError::Settings(format!(
                "Unknown language server: {id}"
            )));
        }
        let mut enabled = match servers.remove("enabled") {
            None => serde_json::Map::new(),
            Some(Value::Object(map)) => map,
            Some(_) => {
                return Err(CoreError::Settings(
                    "languageServers.enabled must be an object".into(),
                ))
            }
        };
        match value {
            None => {
                enabled.remove(id);
            }
            Some(Value::Bool(flag)) => {
                enabled.insert(id.into(), Value::Bool(flag));
            }
            Some(_) => {
                return Err(CoreError::Settings(format!(
                    "languageServers.enabled.{id} must be true or false"
                )))
            }
        }
        if !enabled.is_empty() {
            servers.insert("enabled".into(), Value::Object(enabled));
        }
    } else if USER_ONLY_LANGUAGE_SERVER_KEYS.contains(&rest) {
        if scope != crate::SettingsScope::User {
            return Err(user_only_error(rest));
        }
        match (rest, value) {
            (_, None) => {
                servers.remove(rest);
            }
            ("autoInstall" | "runProjectCode", Some(Value::Bool(flag))) => {
                servers.insert(rest.into(), Value::Bool(flag));
            }
            ("autoInstall" | "runProjectCode", Some(_)) => {
                return Err(CoreError::Settings(format!(
                    "languageServers.{rest} must be true or false"
                )))
            }
            ("watchIncludeDirectories" | "silencedWatchWarnings", Some(Value::Array(items))) => {
                let names: Vec<String> = items
                    .iter()
                    .map(|item| item.as_str().map(str::to_owned))
                    .collect::<Option<_>>()
                    .ok_or_else(|| {
                        CoreError::Settings(format!(
                            "languageServers.{rest} must be a list of strings"
                        ))
                    })?;
                let candidate = if rest == "watchIncludeDirectories" {
                    LanguageServerSettings {
                        watch_include_directories: names,
                        ..Default::default()
                    }
                } else {
                    LanguageServerSettings {
                        silenced_watch_warnings: names,
                        ..Default::default()
                    }
                };
                candidate.validate()?;
                servers.insert(rest.into(), Value::Array(items));
            }
            ("watchIncludeDirectories" | "silencedWatchWarnings", Some(_)) => {
                return Err(CoreError::Settings(format!(
                    "languageServers.{rest} must be a list of strings"
                )))
            }
            (_, Some(Value::String(path))) => {
                let candidate = LanguageServerSettings {
                    java_home: (rest == "javaHome").then(|| path.clone()),
                    node_path: (rest == "nodePath").then(|| path.clone()),
                    ..Default::default()
                };
                candidate.validate()?;
                servers.insert(rest.into(), Value::String(path));
            }
            (_, Some(_)) => {
                return Err(CoreError::Settings(format!(
                    "languageServers.{rest} must be an absolute path string"
                )))
            }
        }
    } else if DEPRECATED_LANGUAGE_SERVER_KEYS.contains(&rest)
        && scope == crate::SettingsScope::User
        && value.is_none()
    {
        // Only removal: the key is never written again, but it can be cleaned out once its
        // entries were imported, which also lets older builds read the file.
        servers.remove(rest);
    } else {
        return Err(unsupported());
    }
    if servers.is_empty() {
        patch(text, "languageServers", None)
    } else {
        patch(
            text,
            "languageServers",
            Some(&Value::Object(servers).to_string()),
        )
    }
}

/// Sets or removes `editor.syntaxColors.<theme>.<token>`, or removes `editor.syntaxColors.<theme>`
/// as a whole. Empty parent objects are removed. Both scopes may set colours.
fn patch_syntax_color(text: &str, rest: &str, value_json: Option<&str>) -> Result<String> {
    let (theme, token) = match rest.split_once('.') {
        Some((theme, token)) => (theme, Some(token)),
        None => (rest, None),
    };
    if !SYNTAX_THEMES.contains(&theme) {
        return Err(CoreError::Settings(format!(
            "editor.syntaxColors: unknown theme \"{theme}\" (use dark, light or purple)"
        )));
    }
    let value = value_json
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(|error| CoreError::Settings(error.to_string()))?
        .filter(|v| !v.is_null());
    let root = parse(text)?;
    // Reuse the member name the file already uses so comments and layout stay put.
    let member = if root.get("editor.syntaxColors").is_some() || root.get("syntaxColors").is_none()
    {
        "editor.syntaxColors"
    } else {
        "syntaxColors"
    };
    let mut colors = match normalize(root)?.get("syntaxColors").cloned() {
        None => serde_json::Map::new(),
        Some(Value::Object(map)) => map,
        Some(_) => {
            return Err(CoreError::Settings(
                "editor.syntaxColors must be an object".into(),
            ))
        }
    };
    match token {
        None => {
            if value.is_some() {
                return Err(CoreError::Settings(format!(
                    "editor.syntaxColors.{theme} can only be removed; set a token as editor.syntaxColors.{theme}.<token>"
                )));
            }
            colors.remove(theme);
        }
        Some(token) => {
            if !SYNTAX_TOKEN_IDS.contains(&token) {
                return Err(CoreError::Settings(format!(
                    "editor.syntaxColors.{theme}: unknown token \"{token}\""
                )));
            }
            let mut tokens = match colors.remove(theme) {
                None => serde_json::Map::new(),
                Some(Value::Object(map)) => map,
                Some(_) => {
                    return Err(CoreError::Settings(format!(
                        "editor.syntaxColors.{theme} must be an object"
                    )))
                }
            };
            match value {
                None => {
                    tokens.remove(token);
                }
                Some(Value::String(color)) => {
                    if !is_hex_color(&color) {
                        return Err(CoreError::Settings(format!(
                            "editor.syntaxColors.{theme}.{token}: colour must be #rgb, #rrggbb or #rrggbbaa"
                        )));
                    }
                    tokens.insert(token.into(), Value::String(color));
                }
                Some(_) => {
                    return Err(CoreError::Settings(format!(
                        "editor.syntaxColors.{theme}.{token} must be a colour string"
                    )))
                }
            }
            if !tokens.is_empty() {
                colors.insert(theme.into(), Value::Object(tokens));
            }
        }
    }
    if colors.is_empty() {
        patch(text, member, None)
    } else {
        patch(text, member, Some(&Value::Object(colors).to_string()))
    }
}

/// Sets or removes one `explorer.<leaf>` preference while preserving other Explorer keys.
fn patch_explorer(text: &str, leaf: &str, value_json: Option<&str>) -> Result<String> {
    const KEYS: &[&str] = &[
        "showHiddenFiles",
        "showIgnoredFiles",
        "compactFolders",
        "autoReveal",
        "confirmDelete",
    ];
    if !KEYS.contains(&leaf) {
        return Err(CoreError::Settings(format!(
            "Unsupported setting: explorer.{leaf}"
        )));
    }
    let value = value_json
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(|error| CoreError::Settings(error.to_string()))?
        .filter(|value| !value.is_null());
    if value.as_ref().is_some_and(|value| !value.is_boolean()) {
        return Err(CoreError::Settings(format!(
            "explorer.{leaf} must be true or false"
        )));
    }
    let root = parse(text)?;
    let explorer = match root.get("explorer") {
        None => serde_json::Map::new(),
        Some(Value::Object(map)) => map.clone(),
        Some(_) => return Err(CoreError::Settings("explorer must be an object".into())),
    };
    let dotted = format!("explorer.{leaf}");
    let has_dotted = root.get(&dotted).is_some();
    let has_nested = explorer.contains_key(leaf);
    if let Some(value) = value {
        let mut patched = text.to_owned();
        if has_dotted {
            patched = patch_nested_key(&patched, &[&dotted], value.clone())?;
        }
        if has_nested || !has_dotted {
            patched = patch_nested_key(&patched, &["explorer", leaf], value)?;
        }
        return Ok(patched);
    }

    let mut patched = text.to_owned();
    if has_dotted {
        patched = remove_jsonc_key(&patched, &[&dotted])?;
    }
    if has_nested {
        patched = remove_jsonc_key(&patched, &["explorer", leaf])?;
    }
    let after = parse(&patched)?;
    if after
        .get("explorer")
        .and_then(Value::as_object)
        .is_some_and(serde_json::Map::is_empty)
    {
        patched = remove_jsonc_key(&patched, &["explorer"])?;
    }
    Ok(patched)
}

/// Removes one member from a JSONC object while leaving unrelated source bytes untouched.
fn remove_jsonc_key(text: &str, path: &[&str]) -> Result<String> {
    let Some((key, rest)) = path.split_first() else {
        return Err(CoreError::Settings("Empty preference path".into()));
    };
    let Some(JsoncMemberSpan {
        start,
        value_start,
        value_end,
        delimiter,
        previous_comma,
    }) = jsonc_member_span(text, key)?
    else {
        return Ok(text.to_owned());
    };
    if !rest.is_empty() {
        let child = remove_jsonc_key(&text[value_start..value_end], rest)?;
        let mut patched = text.to_owned();
        patched.replace_range(value_start..value_end, &child);
        parse(&patched)?;
        return Ok(patched);
    }

    let mut patched = text.to_owned();
    if let Some(delimiter) = delimiter {
        patched.replace_range(start..delimiter + 1, "");
    } else {
        let remove_start = previous_comma.unwrap_or(start);
        patched.replace_range(remove_start..value_end, "");
    }
    parse(&patched)?;
    Ok(patched)
}

struct JsoncMemberSpan {
    start: usize,
    value_start: usize,
    value_end: usize,
    delimiter: Option<usize>,
    previous_comma: Option<usize>,
}

/// Returns the key/value spans and its separator in one object, respecting JSONC comments.
fn jsonc_member_span(text: &str, key: &str) -> Result<Option<JsoncMemberSpan>> {
    parse(text)?;
    let mask = comment_mask(text);
    let mut index = skip_space(&mask, 0) + 1;
    let mut previous_comma = None;
    loop {
        index = skip_space(&mask, index);
        if mask.get(index) == Some(&b'}') {
            return Ok(None);
        }
        let start = index;
        index = string_end(&mask, index);
        let member_key: String = serde_json::from_slice(&mask[start..index])
            .map_err(|error| CoreError::Settings(error.to_string()))?;
        index = skip_space(&mask, index) + 1;
        let value_start = skip_space(&mask, index);
        index = value_start;
        let mut depth = 0;
        while index < mask.len() {
            match mask[index] {
                b'"' => {
                    index = string_end(&mask, index);
                    continue;
                }
                b'{' | b'[' => depth += 1,
                b'}' if depth == 0 => break,
                b'}' | b']' => depth -= 1,
                b',' if depth == 0 => break,
                _ => {}
            }
            index += 1;
        }
        let mut value_end = index;
        while value_end > value_start && mask[value_end - 1].is_ascii_whitespace() {
            value_end -= 1;
        }
        let delimiter = if mask.get(index) == Some(&b',') {
            Some(index)
        } else {
            None
        };
        if member_key == key {
            return Ok(Some(JsoncMemberSpan {
                start,
                value_start,
                value_end,
                delimiter,
                previous_comma,
            }));
        }
        if delimiter.is_some() {
            previous_comma = delimiter;
            index += 1;
        }
    }
}

/// Edits one top-level setting. Unrelated comments, unknown keys and formatting remain intact.
pub(crate) fn patch(text: &str, key: &str, value_json: Option<&str>) -> Result<String> {
    parse(text)?;
    let canonical = canonical_key(key)
        .ok_or_else(|| CoreError::Settings(format!("Unsupported setting: {key}")))?;
    let value = value_json
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(|error| CoreError::Settings(error.to_string()))?;
    let mask = comment_mask(text);
    let mut members = Vec::new();
    let mut index = skip_space(&mask, 0) + 1;
    let close;
    loop {
        index = skip_space(&mask, index);
        if mask.get(index) == Some(&b'}') {
            close = index;
            break;
        }
        let start = index;
        index = string_end(&mask, index);
        let member_key: String = serde_json::from_slice(&mask[start..index])
            .map_err(|error| CoreError::Settings(error.to_string()))?;
        index = skip_space(&mask, index) + 1;
        let value_start = skip_space(&mask, index);
        index = value_start;
        let mut depth = 0;
        while index < mask.len() {
            match mask[index] {
                b'"' => {
                    index = string_end(&mask, index);
                    continue;
                }
                b'{' | b'[' => depth += 1,
                b'}' if depth == 0 => break,
                b'}' | b']' => depth -= 1,
                b',' if depth == 0 => break,
                _ => {}
            }
            index += 1;
        }
        let mut end = index;
        while end > value_start && mask[end - 1].is_ascii_whitespace() {
            end -= 1;
        }
        let comma = (mask.get(index) == Some(&b',')).then_some(index);
        let remove = canonical_key(&member_key).as_ref() == Some(&canonical);
        members.push((start, end, comma, remove));
        if comma.is_some() {
            index += 1;
        }
    }
    let matching: Vec<_> = members.iter().filter(|member| member.3).collect();
    if let (Some(value), [member]) = (&value, matching.as_slice()) {
        let key_end = string_end(&mask, member.0);
        let existing_key: String = serde_json::from_slice(&mask[member.0..key_end])
            .map_err(|error| CoreError::Settings(error.to_string()))?;
        if existing_key == key {
            let colon = skip_space(&mask, key_end);
            let value_start = skip_space(&mask, colon + 1);
            let mut patched = text.to_owned();
            patched.replace_range(value_start..member.1, &value.to_string());
            parse(&patched)?;
            return Ok(patched);
        }
    }
    let mut result = text.as_bytes().to_vec();
    for (start, end, comma, remove) in &members {
        if *remove {
            for position in *start..*end {
                if !mask[position].is_ascii_whitespace() {
                    result[position] = b' ';
                }
            }
            if let Some(position) = comma {
                result[*position] = b' ';
            }
        }
    }
    if let Some(value) = value {
        let ending = if text.contains("\r\n") { "\r\n" } else { "\n" };
        let addition = format!(
            "{ending}  {}: {}{ending}",
            serde_json::to_string(key).unwrap(),
            serde_json::to_string(&value).unwrap()
        );
        result.splice(close..close, addition.bytes());
        if let Some((_, end, None, _)) = members.iter().rev().find(|member| !member.3) {
            result.insert(*end, b',');
        }
    }
    let patched =
        String::from_utf8(result).map_err(|error| CoreError::Settings(error.to_string()))?;
    parse(&patched)?;
    Ok(patched)
}

fn skip_space(bytes: &[u8], mut index: usize) -> usize {
    while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    index
}

fn string_end(bytes: &[u8], mut index: usize) -> usize {
    index += 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'"' => return index + 1,
            _ => index += 1,
        }
    }
    index
}

fn comment_mask(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut mask = bytes.to_vec();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'"' {
            index = string_end(bytes, index);
            continue;
        }
        if bytes[index..].starts_with(b"//") {
            while index < bytes.len() && bytes[index] != b'\n' {
                mask[index] = b' ';
                index += 1;
            }
        } else if bytes[index..].starts_with(b"/*") {
            mask[index] = b' ';
            mask[index + 1] = b' ';
            index += 2;
            while index < bytes.len() && !bytes[index..].starts_with(b"*/") {
                if !matches!(bytes[index], b'\n' | b'\r') {
                    mask[index] = b' ';
                }
                index += 1;
            }
            if index + 1 < bytes.len() {
                mask[index] = b' ';
                mask[index + 1] = b' ';
                index += 2;
            }
        } else {
            index += 1;
        }
    }
    mask
}

fn merge(target: &mut Value, value: Value) {
    if let (Some(target), Value::Object(source)) = (target.as_object_mut(), &value) {
        for (key, value) in source {
            if let Some(existing) = target.get_mut(key) {
                merge(existing, value.clone());
            } else {
                target.insert(key.clone(), value.clone());
            }
        }
    } else {
        *target = value;
    }
}

// Remove comments and trailing commas while preserving string contents and line numbers.
fn strip_jsonc(text: &str) -> Result<String> {
    let mut chars = text.chars().peekable();
    let mut output = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped = false;
    while let Some(ch) = chars.next() {
        if in_string {
            output.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
        } else if ch == '"' {
            in_string = true;
            output.push(ch);
        } else if ch == '/' && chars.peek() == Some(&'/') {
            chars.next();
            for next in chars.by_ref() {
                if next == '\n' {
                    output.push('\n');
                    break;
                }
                output.push(' ');
            }
        } else if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut closed = false;
            while let Some(next) = chars.next() {
                if next == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    closed = true;
                    break;
                }
                output.push(if next == '\n' { '\n' } else { ' ' });
            }
            if !closed {
                return Err(CoreError::Settings("Unclosed block comment".into()));
            }
        } else {
            output.push(ch);
        }
    }
    let chars: Vec<char> = output.chars().collect();
    let mut clean = String::with_capacity(output.len());
    in_string = false;
    escaped = false;
    for (index, ch) in chars.iter().copied().enumerate() {
        if in_string {
            clean.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
        } else if ch == '"' {
            in_string = true;
            clean.push(ch);
        } else if ch == ','
            && matches!(
                chars[index + 1..].iter().find(|c| !c.is_whitespace()),
                Some('}' | ']')
            )
        {
            clean.push(' ');
        } else {
            clean.push(ch);
        }
    }
    Ok(clean)
}

#[cfg(test)]
mod language_server_tests {
    use super::*;

    #[test]
    fn language_server_settings_default_to_opt_in_installs() {
        let defaults = Settings::default().language_servers;
        assert!(!defaults.auto_install);
        assert!(!defaults.run_project_code, "project code is off by default");
        assert!(defaults.is_enabled("jdtls"));
        let value = load_with_texts(
            r#"{ "languageServers": { "autoInstall": true, "enabled": { "jdtls": false },
                 "javaHome": "/opt/jdk", "nodePath": "/usr/bin/node",
                 "runProjectCode": true } }"#,
            "{}",
        )
        .unwrap()
        .language_servers;
        assert!(value.run_project_code);
        assert!(value.auto_install && !value.is_enabled("jdtls") && value.is_enabled("vtsls"));
        assert_eq!(value.java_home.as_deref(), Some("/opt/jdk"));
    }

    #[test]
    fn language_server_settings_reject_unknown_servers_and_bad_paths() {
        for text in [
            r#"{ "languageServers": { "enabled": { "gopls": true } } }"#,
            r#"{ "languageServers": { "javaHome": "" } }"#,
            r#"{ "languageServers": { "nodePath": "a\u0000b" } }"#,
        ] {
            assert!(load_with_texts(text, "{}").is_err(), "{text}");
        }
        // An unknown sibling key is no longer a load error (it may come from a newer build),
        // but a hand edit that introduces one is still refused, see
        // `explicit_edits_reject_new_unknown_nested_keys_but_tolerate_existing_ones`.
        let unknown = r#"{ "languageServers": { "bogus": 1 } }"#;
        assert!(load_with_texts(unknown, "{}").is_ok());
        assert!(reject_new_unknown_nested("{}", unknown).is_err());
    }
}

#[cfg(test)]
mod file_open_shortcut_tests {
    use super::*;

    #[test]
    fn source_control_shortcut_validates_and_preserves_explicit_existing_keys() {
        assert!(COMMAND_IDS.contains(&"showSourceControl"));
        for command in ["showSourceControl", "save"] {
            Settings {
                keybindings: HashMap::from([(command.into(), vec!["Ctrl+Shift+G".into()])]),
                ..Default::default()
            }
            .validate()
            .unwrap();
        }
        assert!(Settings {
            keybindings: HashMap::from([
                ("showSourceControl".into(), vec!["Ctrl+Shift+G".into()]),
                ("save".into(), vec!["Ctrl+Shift+G".into()]),
            ]),
            ..Default::default()
        }
        .validate()
        .is_err());
        let schema: serde_json::Value =
            serde_json::from_str(include_str!("../settings.schema.json")).unwrap();
        assert!(schema["properties"]["keybindings"]["propertyNames"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == "showSourceControl"));
    }

    #[test]
    fn picker_command_validates_and_preserves_existing_explicit_keys() {
        Settings::default().validate().unwrap();
        for command in [
            "openFile",
            "toggleFiles",
            "focusFiles",
            "quickOpen",
            "settings",
        ] {
            let settings = Settings {
                keybindings: HashMap::from([(command.into(), vec!["Mod+E".into()])]),
                ..Default::default()
            };
            settings.validate().unwrap();
        }
        let settings = Settings {
            keybindings: HashMap::from([("openFile".into(), vec!["Mod+P".into()])]),
            ..Default::default()
        };
        assert!(settings
            .validate()
            .unwrap_err()
            .to_string()
            .contains("conflicts"));
        let explicit_collision = Settings {
            keybindings: HashMap::from([
                ("toggleFiles".into(), vec!["Mod+E".into()]),
                ("openFile".into(), vec!["Mod+E".into()]),
            ]),
            ..Default::default()
        };
        assert!(explicit_collision.validate().is_err());
        let schema: serde_json::Value =
            serde_json::from_str(include_str!("../settings.schema.json")).unwrap();
        assert!(schema["properties"]["keybindings"]["propertyNames"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == "openFile"));
        assert!(schema["properties"]["keybindings"]["propertyNames"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == "toggleFiles"));
        assert!(COMMAND_IDS.contains(&"focusFiles"));
        assert!(COMMAND_IDS.contains(&"toggleFiles"));
    }

    #[test]
    fn language_server_format_shortcut_is_a_validated_action() {
        assert!(COMMAND_IDS.contains(&"formatWithLanguageServer"));
        let schema: serde_json::Value =
            serde_json::from_str(include_str!("../settings.schema.json")).unwrap();
        assert!(schema["properties"]["keybindings"]["propertyNames"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == "formatWithLanguageServer"));
        let rebound = Settings {
            keybindings: HashMap::from([(
                "formatWithLanguageServer".into(),
                vec!["Mod+Alt+Shift+L".into()],
            )]),
            ..Default::default()
        };
        rebound.validate().unwrap();
        let conflict = Settings {
            keybindings: HashMap::from([("save".into(), vec!["Mod+Alt+Shift+F".into()])]),
            ..Default::default()
        };
        assert!(conflict
            .validate()
            .unwrap_err()
            .to_string()
            .contains("conflicts"));
    }

    #[test]
    fn explorer_defaults_do_not_conflict_and_overrides_claim_their_defaults() {
        for keybindings in [
            HashMap::from([("quickOpen".into(), vec!["Mod+E".into()])]),
            HashMap::from([("focusFiles".into(), vec!["Mod+E".into()])]),
            HashMap::from([("toggleFiles".into(), vec!["Mod+E".into()])]),
        ] {
            Settings {
                keybindings,
                ..Default::default()
            }
            .validate()
            .unwrap();
        }
    }
}

#[cfg(test)]
mod zoom_shortcut_tests {
    use super::*;

    #[test]
    fn validates_zoom_commands_and_portable_key_variants() {
        for keys in [
            vec!["Mod+=", "Mod+Shift+="],
            vec!["Mod+Equal", "Mod+Plus"],
            vec!["Mod++", "Mod+NumpadPlus"],
        ] {
            let settings = Settings {
                keybindings: HashMap::from([
                    (
                        "zoomIn".into(),
                        keys.into_iter().map(str::to_owned).collect(),
                    ),
                    ("zoomOut".into(), vec!["Mod+Minus".into()]),
                    ("resetZoom".into(), vec!["Mod+Numpad0".into()]),
                ]),
                ..Default::default()
            };
            settings.validate().unwrap();
        }
        assert_eq!(normalize_zoom_shortcut("Mod+Shift+Plus"), "Mod+Shift+=");
        assert_eq!(normalize_zoom_shortcut("Ctrl+NumpadAdd"), "Ctrl+=");
    }

    #[test]
    fn detects_zoom_collisions_against_defaults_and_named_aliases() {
        let mut settings = Settings {
            keybindings: HashMap::from([("settings".into(), vec!["Mod+Equal".into()])]),
            ..Default::default()
        };
        assert!(settings
            .validate()
            .unwrap_err()
            .to_string()
            .contains("conflicts"));
        settings.keybindings.insert("zoomIn".into(), vec![]);
        settings.validate().unwrap();
        settings
            .keybindings
            .insert("settings".into(), vec!["Mod+Numpad0".into()]);
        assert!(settings
            .validate()
            .unwrap_err()
            .to_string()
            .contains("conflicts"));
    }
}

#[cfg(test)]
mod word_wrap_shortcut_tests {
    use super::*;
    #[test]
    fn word_wrap_can_be_rebound_and_its_default_participates_in_conflicts() {
        let mut settings = Settings {
            keybindings: HashMap::from([("toggleWordWrap".into(), vec!["Alt+W".into()])]),
            ..Default::default()
        };
        settings.validate().unwrap();
        settings.keybindings = HashMap::from([("settings".into(), vec!["Alt+Z".into()])]);
        assert!(settings
            .validate()
            .unwrap_err()
            .to_string()
            .contains("conflicts"));
        settings.keybindings.insert("toggleWordWrap".into(), vec![]);
        settings.validate().unwrap();
    }
}

#[cfg(test)]
mod run_opt_in_patch_tests {
    use super::*;
    #[test]
    fn nested_user_opt_in_preserves_comments_and_sibling_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let user = directory.path().join("user.jsonc");
        let original = "{\n// root note\n\"agents\": { // agents note\n  \"delegation\": {\"enabled\": true},\n  \"runTools\": { /* private preference */ \"enabled\": false, },\n},\n\"fontSize\": 17, // font note\n\"futureUserKey\": {\"keep\": 7},\n}\n";
        fs::write(&user, original).unwrap();
        let workspace = CoreWorkspace::open(directory.path())
            .unwrap()
            .with_user_settings(Some(user.clone()));
        workspace.set_run_tools_enabled(true).unwrap();
        assert!(workspace.run_tools_enabled().unwrap());
        assert!(
            workspace
                .get_settings_for_scope(SettingsScope::User)
                .unwrap()
                .agents
                .delegation
                .enabled
        );
        let saved = fs::read_to_string(&user).unwrap();
        for note in [
            "// root note",
            "// agents note",
            "/* private preference */",
            "// font note",
        ] {
            assert!(saved.contains(note));
        }
        assert_eq!(
            workspace
                .get_settings_for_scope(SettingsScope::User)
                .unwrap()
                .font_size,
            17
        );
        assert_eq!(parse(&saved).unwrap()["futureUserKey"]["keep"], 7);
        workspace.set_run_tools_enabled(false).unwrap();
        assert!(!workspace.run_tools_enabled().unwrap());
    }
    #[test]
    fn nested_user_opt_in_creates_missing_objects_with_valid_commas() {
        for text in [
            "{}",
            "{\"fontSize\":16}",
            "{\"fontSize\":16,}",
            "{\"agents\":{}}",
        ] {
            let patched =
                patch_nested_key(text, &["agents", "runTools", "enabled"], Value::Bool(true))
                    .unwrap();
            assert!(
                load_with_texts(&patched, "{}")
                    .unwrap()
                    .agents
                    .run_tools
                    .enabled
            );
        }
    }
    #[test]
    fn opt_out_updates_the_effective_last_duplicate_in_jsonc() {
        for text in [
            r#"{"agents":{"runTools":{"enabled":false,"enabled":true}}}"#,
            r#"{"agents":{"runTools":{"enabled":true}},"agents":{"runTools":{"enabled":true}}}"#,
        ] {
            let patched =
                patch_nested_key(text, &["agents", "runTools", "enabled"], Value::Bool(false))
                    .unwrap();
            assert!(
                !load_with_texts(&patched, "{}")
                    .unwrap()
                    .agents
                    .run_tools
                    .enabled
            );
        }
    }
}

#[cfg(test)]
mod language_server_key_tests {
    use super::*;
    use crate::SettingsScope::{User, Workspace};

    #[test]
    fn workspace_text_cannot_choose_executables_or_downloads() {
        let ws = r#"{ "languageServers": { "nodePath": "/tmp/evil", "javaHome": "/tmp/jdk",
                 "autoInstall": true, "runProjectCode": true, "enabled": { "css": false } } }"#;
        let loaded = load_with_texts("{}", ws).unwrap().language_servers;
        assert!(!loaded.run_project_code);
        assert_eq!(loaded.node_path, None);
        assert_eq!(loaded.java_home, None);
        assert!(!loaded.auto_install);
        assert!(!loaded.is_enabled("css"), "per server switches still apply");
        let err = reject_user_only(ws).unwrap_err().to_string();
        assert!(err.contains("languageServers.") && err.contains("user settings only"));
        let only = r#"{ "languageServers": { "nodePath": "/tmp/evil" } }"#;
        let err = reject_user_only(only).unwrap_err().to_string();
        assert!(err.contains("languageServers.nodePath") && err.contains("user settings only"));
        // User settings keep working, and a workspace value never overrides them.
        let user = r#"{ "languageServers": { "nodePath": "/usr/bin/node", "autoInstall": true,
                 "runProjectCode": true } }"#;
        let merged = load_with_texts(user, ws).unwrap().language_servers;
        assert!(merged.run_project_code);
        assert_eq!(merged.node_path.as_deref(), Some("/usr/bin/node"));
        assert!(merged.auto_install);
    }

    #[test]
    fn executable_paths_must_be_absolute() {
        for bad in ["node", "./node", "bin/node", "~/node", "C:node"] {
            let text = format!(r#"{{ "languageServers": {{ "nodePath": "{bad}" }} }}"#);
            assert!(load_with_texts(&text, "{}").is_err(), "{bad}");
        }
        for good in [
            "/usr/bin/node",
            "C:\\node\\node.exe",
            "C:/node/node.exe",
            "\\\\srv\\share\\n",
        ] {
            assert!(is_absolute_path_text(good), "{good}");
        }
    }

    fn set(scope: crate::SettingsScope, text: &str, key: &str, v: Option<&str>) -> Result<String> {
        patch_in_scope(scope, text, key, v)
    }

    #[test]
    fn dotted_keys_set_and_remove_and_keep_the_rest() {
        let base = "{\n  // keep me\n  \"fontSize\": 14\n}\n";
        let t = set(
            Workspace,
            base,
            "languageServers.enabled.vtsls",
            Some("false"),
        )
        .unwrap();
        assert!(t.contains("// keep me") && t.contains("\"fontSize\": 14"));
        assert!(!load_with_texts("{}", &t)
            .unwrap()
            .language_servers
            .is_enabled("vtsls"));
        let t = set(Workspace, &t, "languageServers.enabled.css", Some("false")).unwrap();
        let s = load_with_texts("{}", &t).unwrap().language_servers;
        assert!(!s.is_enabled("vtsls") && !s.is_enabled("css"));
        let t = set(Workspace, &t, "languageServers.enabled.vtsls", None).unwrap();
        let t = set(Workspace, &t, "languageServers.enabled.css", Some("null")).unwrap();
        assert!(!t.contains("languageServers"), "{t}");
        assert!(t.contains("// keep me"));

        for (key, value, check) in [
            ("autoInstall", "true", 0),
            ("javaHome", "\"/opt/jdk\"", 1),
            ("nodePath", "\"/usr/bin/node\"", 2),
            ("runProjectCode", "true", 3),
        ] {
            let full = format!("languageServers.{key}");
            let t = set(User, base, &full, Some(value)).unwrap();
            let s = load_with_texts(&t, "{}").unwrap().language_servers;
            match check {
                0 => assert!(s.auto_install),
                1 => assert_eq!(s.java_home.as_deref(), Some("/opt/jdk")),
                3 => assert!(s.run_project_code),
                _ => assert_eq!(s.node_path.as_deref(), Some("/usr/bin/node")),
            }
            assert!(t.contains("// keep me"));
            let back = set(User, &t, &full, None).unwrap();
            assert!(!back.contains(key), "{back}");
            let again = set(User, &t, &full, Some("null")).unwrap();
            assert!(!again.contains(key), "{again}");
        }
    }

    #[test]
    fn workspace_writes_of_user_only_keys_are_rejected_and_user_writes_work() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("p");
        std::fs::create_dir(&project).unwrap();
        let user = dir.path().join("user.jsonc");
        let ws = crate::CoreWorkspace::open(&project)
            .unwrap()
            .with_user_settings(Some(user));
        let err = ws
            .update_setting(Workspace, "languageServers.nodePath", Some("\"/x\""))
            .unwrap_err()
            .to_string();
        assert!(err.contains("user settings only"), "{err}");
        let err = ws
            .update_settings_jsonc_for_scope(
                Workspace,
                r#"{ "languageServers": { "autoInstall": true } }"#,
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("user settings only"), "{err}");
        ws.update_setting(Workspace, "languageServers.enabled.css", Some("false"))
            .unwrap();
        let merged = ws
            .update_setting(User, "languageServers.nodePath", Some("\"/usr/bin/node\""))
            .unwrap();
        assert_eq!(
            merged.language_servers.node_path.as_deref(),
            Some("/usr/bin/node")
        );
        assert!(!merged.language_servers.is_enabled("css"));
    }

    #[test]
    fn unrelated_workspace_writes_survive_a_preexisting_user_only_key() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("p");
        std::fs::create_dir_all(project.join(".span")).unwrap();
        let file = project.join(".span/settings.jsonc");
        std::fs::write(
            &file,
            "{\n  // cloned\n  \"languageServers\": { \"nodePath\": \"/tmp/evil\", \"runProjectCode\": true }\n}\n",
        )
        .unwrap();
        let ws = crate::CoreWorkspace::open(&project)
            .unwrap()
            .with_user_settings(Some(dir.path().join("user.jsonc")));
        // Unrelated single key writes work, including a per server switch beside it.
        let merged = ws
            .update_setting(Workspace, "fontSize", Some("15"))
            .unwrap();
        assert_eq!(merged.font_size, 15);
        let merged = ws
            .update_setting(Workspace, "languageServers.enabled.css", Some("false"))
            .unwrap();
        assert!(!merged.language_servers.is_enabled("css"));
        // The pre-existing keys stay ignored on read.
        assert_eq!(merged.language_servers.node_path, None);
        assert!(!merged.language_servers.run_project_code);
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("// cloned") && text.contains("/tmp/evil"));
        // A write that adds or changes a user-only key is still refused.
        for (key, v) in [
            ("languageServers.nodePath", "\"/other\""),
            ("languageServers.autoInstall", "true"),
            ("languageServers.runProjectCode", "false"),
        ] {
            let err = ws.update_setting(Workspace, key, Some(v)).unwrap_err();
            assert!(err.to_string().contains("user settings only"), "{key}");
        }
        let err = ws
            .update_settings_jsonc_for_scope(
                Workspace,
                r#"{ "languageServers": { "nodePath": "/tmp/evil", "javaHome": "/x" } }"#,
            )
            .unwrap_err();
        assert!(err.to_string().contains("user settings only"));
    }

    #[test]
    fn deprecated_trusted_workspaces_is_read_but_never_written() {
        // A preview build wrote the key. It loads (even with odd entries), and a workspace
        // file cannot use it.
        let file = r#"{ "languageServers": { "trustedWorkspaces": ["/home/me/a", "C:\\work\\b", "rel", ""] } }"#;
        let s = load_with_texts(file, "{}").unwrap().language_servers;
        assert_eq!(s.trusted_workspaces.len(), 4);
        let ws = r#"{ "languageServers": { "trustedWorkspaces": ["/home/me/evil"] } }"#;
        assert!(load_with_texts("{}", ws)
            .unwrap()
            .language_servers
            .trusted_workspaces
            .is_empty());
        // Writing it is refused in both scopes; only removal is allowed in user scope.
        for scope in [User, Workspace] {
            assert!(set(
                scope,
                "{}",
                "languageServers.trustedWorkspaces",
                Some(r#"["/a"]"#)
            )
            .is_err());
        }
        let back = set(User, file, "languageServers.trustedWorkspaces", None).unwrap();
        assert!(!back.contains("trustedWorkspaces"), "{back}");
        assert!(set(Workspace, file, "languageServers.trustedWorkspaces", None).is_err());
        assert!(!USER_ONLY_LANGUAGE_SERVER_KEYS.contains(&"trustedWorkspaces"));
    }

    #[test]
    fn unknown_nested_keys_load_validate_and_survive_a_write() {
        let text = "{\n  // mine\n  \"languageServers\": {\n    \"autoInstall\": true,\n    \"futureKnob\": { \"a\": [1, 2] }\n  },\n  \"agents\": { \"delegation\": { \"enabled\": true, \"mode\": \"x\" }, \"other\": 1 },\n  \"updates\": { \"channel\": \"beta\" },\n  \"someTopLevelKey\": 3\n}\n";
        let loaded = load_with_texts(text, "{}").unwrap();
        assert!(loaded.language_servers.auto_install);
        assert!(loaded.agents.delegation.enabled);
        // The write goes through the dotted key path and keeps every unknown key verbatim.
        let written = set(User, text, "languageServers.runProjectCode", Some("true")).unwrap();
        let value = parse(&written).unwrap();
        assert_eq!(
            value["languageServers"]["futureKnob"],
            serde_json::json!({ "a": [1, 2] })
        );
        assert_eq!(value["languageServers"]["runProjectCode"], true);
        assert_eq!(value["languageServers"]["autoInstall"], true);
        assert_eq!(value["agents"]["other"], 1);
        assert_eq!(value["agents"]["delegation"]["mode"], "x");
        assert_eq!(value["updates"]["channel"], "beta");
        assert_eq!(value["someTopLevelKey"], 3);
        load_with_texts(&written, "{}").unwrap();
        // Removing the last known key keeps the object because of the unknown one.
        let cleared = set(User, &written, "languageServers.runProjectCode", None).unwrap();
        assert!(cleared.contains("futureKnob"), "{cleared}");
        // Known keys are still validated strictly.
        assert!(load_with_texts(
            r#"{ "languageServers": { "futureKnob": 1, "autoInstall": "yes" } }"#,
            "{}"
        )
        .is_err());
    }

    #[test]
    fn typed_nested_rewrite_keeps_unknown_keys() {
        let raw = parse(r#"{ "languageServers": { "futureKnob": 1, "nodePath": "/n" } }"#).unwrap();
        let mut value = serde_json::json!({ "autoInstall": false, "enabled": {} });
        keep_unknown_nested(&raw, "languageServers", &mut value);
        assert_eq!(value["futureKnob"], 1);
        assert_eq!(value["autoInstall"], false);
        // Maps are not struct paths: stale entries are not resurrected.
        let raw = parse(r#"{ "keybindings": { "save": ["Mod+S"] } }"#).unwrap();
        let mut value = serde_json::json!({});
        keep_unknown_nested(&raw, "keybindings", &mut value);
        assert_eq!(value, serde_json::json!({}));
    }

    #[test]
    fn explicit_edits_reject_new_unknown_nested_keys_but_tolerate_existing_ones() {
        let old = r#"{ "languageServers": { "futureKnob": 1 } }"#;
        assert!(reject_new_unknown_nested(old, old).is_ok());
        assert!(reject_new_unknown_nested(
            old,
            r#"{ "languageServers": { "futureKnob": 2, "autoInstall": true } }"#
        )
        .is_ok());
        assert!(reject_new_unknown_nested(
            old,
            r#"{ "languageServers": { "futureKnob": 1, "typo": 1 } }"#
        )
        .is_err());
        assert!(reject_new_unknown_nested("{}", r#"{ "updates": { "auto": true } }"#).is_err());
        assert!(reject_new_unknown_nested("{}", r#"{ "topLevelUnknown": true }"#).is_ok());
    }

    #[test]
    fn dotted_keys_reject_bad_input() {
        let b = "{}";
        for (scope, key, v) in [
            (User, "languageServers.enabled.gopls", "true"),
            (User, "languageServers.enabled.css", "\"yes\""),
            (User, "languageServers.autoInstall", "1"),
            (User, "languageServers.runProjectCode", "\"yes\""),
            (Workspace, "languageServers.runProjectCode", "true"),
            (User, "languageServers.javaHome", "5"),
            (User, "languageServers.javaHome", "\"jdk\""),
            (User, "languageServers.nodePath", "\"\""),
            (User, "languageServers.bogus", "1"),
            (User, "languageServers.", "1"),
            (Workspace, "languageServers.autoInstall", "true"),
            (Workspace, "languageServers.javaHome", "\"/opt/jdk\""),
            (Workspace, "languageServers.nodePath", "\"/usr/bin/node\""),
        ] {
            assert!(set(scope, b, key, Some(v)).is_err(), "{key} {v}");
        }
        let err = set(Workspace, b, "languageServers.nodePath", Some("\"/x\""))
            .unwrap_err()
            .to_string();
        assert!(err.contains("languageServers.nodePath") && err.contains("user settings only"));
        // Removing from the workspace scope is also refused: those keys are not valid there.
        assert!(set(Workspace, b, "languageServers.javaHome", None).is_err());
    }

    #[test]
    fn watch_lists_are_user_only_and_round_trip() {
        let base = "{\n  // keep me\n}\n";
        let t = set(
            User,
            base,
            "languageServers.watchIncludeDirectories",
            Some(r#"["node_modules", "dist"]"#),
        )
        .unwrap();
        let t = set(
            User,
            &t,
            "languageServers.silencedWatchWarnings",
            Some(r#"["vtsls"]"#),
        )
        .unwrap();
        assert!(t.contains("// keep me"));
        let s = load_with_texts(&t, "{}").unwrap().language_servers;
        assert_eq!(s.watch_include_directories, ["node_modules", "dist"]);
        assert_eq!(s.silenced_watch_warnings, ["vtsls"]);
        let back = set(User, &t, "languageServers.silencedWatchWarnings", None).unwrap();
        assert!(!back.contains("silencedWatchWarnings"), "{back}");
        assert!(back.contains("watchIncludeDirectories"));

        // A workspace file cannot set either list, and its values are ignored on read.
        let ws = r#"{ "languageServers": { "watchIncludeDirectories": ["target"],
                 "silencedWatchWarnings": ["vtsls"] } }"#;
        let loaded = load_with_texts("{}", ws).unwrap().language_servers;
        assert!(loaded.watch_include_directories.is_empty());
        assert!(loaded.silenced_watch_warnings.is_empty());
        let err = reject_user_only(ws).unwrap_err().to_string();
        assert!(err.contains("user settings only"), "{err}");
        for key in [
            "languageServers.watchIncludeDirectories",
            "languageServers.silencedWatchWarnings",
        ] {
            let err = set(Workspace, "{}", key, Some(r#"["vtsls"]"#))
                .unwrap_err()
                .to_string();
            assert!(err.contains("user settings only"), "{key}: {err}");
        }
    }

    #[test]
    fn watch_lists_reject_bad_entries() {
        let too_many = format!(
            "[{}]",
            (0..65)
                .map(|i| format!("\"d{i}\""))
                .collect::<Vec<_>>()
                .join(",")
        );
        for (key, v) in [
            (
                "languageServers.watchIncludeDirectories",
                "\"node_modules\"",
            ),
            ("languageServers.watchIncludeDirectories", "[1]"),
            ("languageServers.watchIncludeDirectories", r#"[""]"#),
            ("languageServers.watchIncludeDirectories", r#"[".."]"#),
            ("languageServers.watchIncludeDirectories", r#"["a/b"]"#),
            ("languageServers.watchIncludeDirectories", r#"["a\\b"]"#),
            ("languageServers.watchIncludeDirectories", too_many.as_str()),
            ("languageServers.silencedWatchWarnings", r#"["gopls"]"#),
            ("languageServers.silencedWatchWarnings", "true"),
        ] {
            assert!(set(User, "{}", key, Some(v)).is_err(), "{key} {v}");
        }
        assert!(load_with_texts(
            r#"{ "languageServers": { "silencedWatchWarnings": ["nope"] } }"#,
            "{}"
        )
        .is_err());
    }
}

#[cfg(test)]
mod code_navigation_tests {
    use super::*;
    use crate::SettingsScope::{User, Workspace};

    fn set(scope: crate::SettingsScope, text: &str, key: &str, v: Option<&str>) -> Result<String> {
        patch_in_scope(scope, text, key, v)
    }

    fn schema() -> serde_json::Value {
        serde_json::from_str(include_str!("../settings.schema.json")).unwrap()
    }

    fn strings(value: &serde_json::Value) -> Vec<String> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn schema_lists_the_same_command_ids_and_syntax_tokens_in_order() {
        let schema = schema();
        assert_eq!(
            strings(&schema["properties"]["keybindings"]["propertyNames"]["enum"]),
            COMMAND_IDS
        );
        let colors = &schema["properties"]["syntaxColors"];
        assert_eq!(strings(&colors["propertyNames"]["enum"]), SYNTAX_THEMES);
        assert_eq!(
            strings(&colors["additionalProperties"]["propertyNames"]["enum"]),
            SYNTAX_TOKEN_IDS
        );
        assert_eq!(SYNTAX_TOKEN_IDS.len(), 30);
        let mut unique = SYNTAX_TOKEN_IDS.to_vec();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), SYNTAX_TOKEN_IDS.len());
    }

    #[test]
    fn zen_mode_defaults_are_valid_and_editing_keys_stay_reserved() {
        for shortcut in ["Meta+Ctrl+Z", "Ctrl+Alt+Z"] {
            validate_shortcut(shortcut).unwrap();
        }
        for shortcut in ["Mod+Z", "Mod+Shift+Z", "Ctrl+Z", "Meta+Z", "Cmd+Shift+Z"] {
            assert!(validate_shortcut(shortcut).is_err(), "{shortcut}");
        }
        Settings {
            keybindings: HashMap::from([(
                "toggleZenMode".into(),
                vec!["Meta+Ctrl+Z".into(), "Ctrl+Alt+Z".into()],
            )]),
            ..Default::default()
        }
        .validate()
        .unwrap();
    }

    #[test]
    fn navigation_defaults_are_unique_and_function_keys_may_stand_alone() {
        Settings::default().validate().unwrap();
        for shortcut in ["F12", "Shift+F12", "Alt+F12", "Mod+Alt+Shift+F12", "F2"] {
            validate_shortcut(shortcut).unwrap();
        }
        for shortcut in ["Shift+A", "A", "Shift+Enter"] {
            assert!(validate_shortcut(shortcut).is_err(), "{shortcut}");
        }
        let clash = Settings {
            keybindings: HashMap::from([
                ("save".into(), vec!["F12".into()]),
                ("closeTab".into(), vec!["F12".into()]),
            ]),
            ..Default::default()
        };
        let message = clash.validate().unwrap_err().to_string();
        assert!(
            message.contains("F12") && message.contains("conflicts"),
            "{message}"
        );
    }

    #[test]
    fn an_existing_binding_claims_a_new_navigation_default_without_error() {
        let settings = Settings {
            keybindings: HashMap::from([("save".into(), vec!["F2".into()])]),
            ..Default::default()
        };
        settings.validate().unwrap();
        let rebound = Settings {
            keybindings: HashMap::from([("renameSymbol".into(), vec!["Mod+Alt+R".into()])]),
            ..Default::default()
        };
        rebound.validate().unwrap();
    }

    fn colors(text: &str) -> HashMap<String, HashMap<String, String>> {
        load_with_texts(text, "{}").unwrap().syntax_colors
    }

    #[test]
    fn syntax_colors_default_empty_and_set_remove_through_dotted_keys() {
        assert!(Settings::default().syntax_colors.is_empty());
        for scope in [User, Workspace] {
            let t = set(
                scope,
                "{}",
                "editor.syntaxColors.dark.keyword",
                Some("\"#ff8800\""),
            )
            .unwrap();
            let t = set(
                scope,
                &t,
                "editor.syntaxColors.dark.comment",
                Some("\"#abc\""),
            )
            .unwrap();
            let t = set(
                scope,
                &t,
                "editor.syntaxColors.light.string",
                Some("\"#11223344\""),
            )
            .unwrap();
            let loaded = colors(&t);
            assert_eq!(loaded["dark"]["keyword"], "#ff8800");
            assert_eq!(loaded["dark"]["comment"], "#abc");
            assert_eq!(loaded["light"]["string"], "#11223344");
            let t = set(scope, &t, "editor.syntaxColors.dark.keyword", None).unwrap();
            assert_eq!(colors(&t)["dark"].len(), 1);
            let t = set(scope, &t, "editor.syntaxColors.dark.comment", Some("null")).unwrap();
            let loaded = colors(&t);
            assert!(!loaded.contains_key("dark"), "empty parent is removed");
            assert!(loaded.contains_key("light"));
            let t = set(scope, &t, "editor.syntaxColors.light", None).unwrap();
            assert!(!t.contains("syntaxColors"), "{t}");
            assert!(colors(&t).is_empty());
        }
    }

    #[test]
    fn removing_a_whole_theme_keeps_the_others_and_comments() {
        let text = "{\n  // keep me\n  \"tabSize\": 4,\n  \"editor.syntaxColors\": { \"dark\": { \"keyword\": \"#fff\" }, \"purple\": { \"tag\": \"#000\" } }\n}\n";
        let t = set(User, text, "editor.syntaxColors.dark", None).unwrap();
        assert!(t.contains("// keep me"), "{t}");
        let loaded = colors(&t);
        assert!(!loaded.contains_key("dark"));
        assert_eq!(loaded["purple"]["tag"], "#000");
        let t = set(User, &t, "syntaxColors.purple.tag", Some("\"#123456\"")).unwrap();
        assert_eq!(colors(&t)["purple"]["tag"], "#123456");
        assert!(t.contains("// keep me"), "{t}");
    }

    #[test]
    fn syntax_colors_reject_bad_colours_tokens_and_themes() {
        for color in [
            "\"red\"",
            "\"url(x)\"",
            "\"var(--a)\"",
            "\"#12\"",
            "\"#12345\"",
            "\"#1234567\"",
            "\"#123456789\"",
            "\"#ggg\"",
            "\"ff0000\"",
            "\"#fff; x\"",
            "\"calc(1)\"",
            "\"\"",
            "5",
            "true",
        ] {
            let err = set(User, "{}", "editor.syntaxColors.dark.keyword", Some(color))
                .unwrap_err()
                .to_string();
            assert!(
                err.contains("editor.syntaxColors.dark.keyword"),
                "{color}: {err}"
            );
        }
        let err = set(
            User,
            "{}",
            "editor.syntaxColors.dark.bogus",
            Some("\"#fff\""),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("unknown token \"bogus\""), "{err}");
        let err = set(
            User,
            "{}",
            "editor.syntaxColors.solarized.keyword",
            Some("\"#fff\""),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("unknown theme \"solarized\""), "{err}");
        assert!(set(User, "{}", "editor.syntaxColors.dark", Some("{}")).is_err());
        // Hand written files go through the same validation.
        for text in [
            r##"{ "editor.syntaxColors": { "dark": { "keyword": "red" } } }"##,
            r##"{ "syntaxColors": { "dark": { "nope": "#fff" } } }"##,
            r##"{ "syntaxColors": { "neon": { "keyword": "#fff" } } }"##,
            r##"{ "syntaxColors": { "dark": { "keyword": 1 } } }"##,
            r##"{ "syntaxColors": { "dark": "#fff" } }"##,
        ] {
            assert!(load_with_texts(text, "{}").is_err(), "{text}");
            assert!(load_with_texts("{}", text).is_err(), "{text}");
        }
    }

    #[test]
    fn every_token_in_every_theme_fits_the_entry_limit() {
        let mut map = serde_json::Map::new();
        for theme in SYNTAX_THEMES {
            let tokens: serde_json::Map<String, Value> = SYNTAX_TOKEN_IDS
                .iter()
                .map(|token| ((*token).into(), Value::String("#abcdef".into())))
                .collect();
            map.insert((*theme).into(), Value::Object(tokens));
        }
        let text = serde_json::json!({ "syntaxColors": map }).to_string();
        let loaded = colors(&text);
        assert_eq!(loaded.values().map(HashMap::len).sum::<usize>(), 90);
    }

    #[test]
    fn workspace_colours_override_user_colours_per_token() {
        let user = r##"{ "editor.syntaxColors": { "dark": { "keyword": "#111111", "string": "#222222" }, "light": { "tag": "#333333" } } }"##;
        let workspace = r##"{ "editor.syntaxColors": { "dark": { "keyword": "#999999" } } }"##;
        let merged = load_with_texts(user, workspace).unwrap().syntax_colors;
        assert_eq!(merged["dark"]["keyword"], "#999999");
        assert_eq!(merged["dark"]["string"], "#222222");
        assert_eq!(merged["light"]["tag"], "#333333");
    }

    #[test]
    fn syntax_colors_are_configured_keys_resettable_and_keep_comments() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("p");
        std::fs::create_dir(&project).unwrap();
        let ws = crate::CoreWorkspace::open(&project)
            .unwrap()
            .with_user_settings(Some(dir.path().join("user.jsonc")));
        ws.update_settings_jsonc_for_scope(User, "{\n  // mine\n  \"tabSize\": 3\n}\n")
            .unwrap();
        ws.update_setting(User, "editor.syntaxColors.dark.keyword", Some("\"#fa0\""))
            .unwrap();
        ws.update_setting(
            Workspace,
            "editor.syntaxColors.dark.keyword",
            Some("\"#0af\""),
        )
        .unwrap();
        let merged = ws.get_settings().unwrap();
        assert_eq!(merged.syntax_colors["dark"]["keyword"], "#0af");
        assert_eq!(
            ws.get_settings_for_scope(User).unwrap().syntax_colors["dark"]["keyword"],
            "#fa0"
        );
        assert_eq!(
            ws.get_settings_keys_for_scope(User).unwrap(),
            ["syntaxColors", "tabSize"]
        );
        assert!(ws
            .get_settings_jsonc_for_scope(User)
            .unwrap()
            .contains("// mine"));
        // Reset of the whole setting uses the canonical or the dotted alias name.
        ws.update_setting(User, "editor.syntaxColors", None)
            .unwrap();
        assert_eq!(ws.get_settings_keys_for_scope(User).unwrap(), ["tabSize"]);
        ws.update_setting(Workspace, "syntaxColors", None).unwrap();
        assert!(ws.get_settings().unwrap().syntax_colors.is_empty());
        assert!(ws
            .get_settings_jsonc_for_scope(User)
            .unwrap()
            .contains("// mine"));
    }
}
