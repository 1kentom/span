use crate::{io_error, CoreError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::{collections::HashMap, fs, path::Path};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
pub enum Theme {
    #[default]
    Dark,
    Light,
    Purple,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
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
    pub keybindings: HashMap<String, Vec<String>>,
    pub formatters: HashMap<String, Vec<String>>,
    /// Agent features. Optional in TypeScript so existing literals stay valid;
    /// a missing value means the defaults.
    #[specta(optional)]
    pub agents: AgentSettings,
}

/// `agents.*` settings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSettings {
    pub delegation: DelegationSettings,
}

/// `agents.delegation.*`: the span-agents tool server (#52).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegationSettings {
    /// Offer the delegation tools to new lead sessions of agents that
    /// advertise MCP over HTTP. Off by default.
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
            keybindings: HashMap::new(),
            formatters: HashMap::new(),
            agents: AgentSettings::default(),
        }
    }
}
impl Settings {
    pub fn validate(&self) -> Result<()> {
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

const COMMAND_IDS: &[&str] = &[
    "quickOpen",
    "commandPalette",
    "findInFile",
    "searchWorkspace",
    "settings",
    "closeTab",
    "save",
    "openFolder",
    "splitEditor",
    "toggleProject",
    "toggleAssistant",
    "toggleTerminal",
    "markdownPreview",
    "formatDocument",
    "goToLine",
];

fn validate_shortcut(shortcut: &str) -> Result<()> {
    let parts: Vec<&str> = shortcut.split('+').collect();
    let invalid = || CoreError::Settings(format!("Invalid portable shortcut: {shortcut}"));
    if parts.is_empty() || parts.len() > 5 || shortcut.len() > 80 {
        return Err(invalid());
    }
    let (key, modifiers) = parts.split_last().ok_or_else(invalid)?;
    if key.is_empty() || key.chars().any(char::is_control) || key.contains(' ') {
        return Err(invalid());
    }
    if !modifiers
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
    let function_key = key
        .strip_prefix('F')
        .and_then(|value| value.parse::<u8>().ok())
        .is_some_and(|value| (1..=24).contains(&value));
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
    let primary = modifiers
        .iter()
        .any(|modifier| matches!(*modifier, "Mod" | "Ctrl" | "Cmd" | "Meta"));
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

fn validate_shortcut_collisions(overrides: &HashMap<String, Vec<String>>) -> Result<()> {
    let defaults = [
        ("quickOpen", vec!["Mod+P", "Mod+K", "Mod+E"]),
        ("commandPalette", vec!["Mod+Shift+P"]),
        ("findInFile", vec!["Mod+F"]),
        ("searchWorkspace", vec!["Mod+Shift+F"]),
        ("settings", vec!["Mod+,"]),
        ("closeTab", vec!["Mod+W"]),
        ("save", vec!["Mod+S"]),
        ("openFolder", vec!["Mod+O"]),
        ("splitEditor", vec!["Mod+\\"]),
        ("toggleProject", vec!["Mod+B"]),
        ("toggleAssistant", vec!["Mod+Alt+B"]),
        ("toggleTerminal", vec!["Mod+J"]),
        ("markdownPreview", vec!["Mod+Shift+V"]),
        ("formatDocument", vec!["Alt+Shift+F"]),
        ("goToLine", vec!["Ctrl+G", "Mod+Alt+G"]),
    ];
    let mut assigned = HashMap::new();
    for (command, mut defaults) in defaults {
        if command == "quickOpen" && cfg!(target_os = "macos") {
            defaults.push("Ctrl+P");
        }
        let shortcuts: Vec<&str> = match overrides.get(command) {
            Some(items) => items.iter().map(String::as_str).collect(),
            None => defaults,
        };
        for shortcut in shortcuts {
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
            let normalized = format!("{}+{key}", modifiers.join("+"));
            if let Some(existing) = assigned.insert(normalized, command) {
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

pub(crate) fn load_with_workspace_text(user: Option<&Path>, text: &str) -> Result<Settings> {
    let mut value = serde_json::to_value(Settings::default())
        .map_err(|e| CoreError::Settings(e.to_string()))?;
    if let Some(path) = user {
        merge_file(&mut value, path)?;
    }
    merge(&mut value, without_user_only(parse(text)?));
    decode(value)
}

/// Settings honoured only from the user's own settings file. A workspace
/// `.span/settings.jsonc` arrives with the repository, so a cloned project
/// must not be able to switch these on: `agents.delegation.enabled` lets an
/// agent start other agents (ADR 0003). The key is dropped from workspace
/// settings before merging; unknown sibling keys are still rejected.
const USER_ONLY: &[&[&str]] = &[&["agents", "delegation", "enabled"]];

pub(crate) fn without_user_only(mut value: Value) -> Value {
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
    parse(&text)
        .map(Some)
        .map_err(|e| CoreError::Settings(format!("{}: {e}", path.display())))
}

fn parse(text: &str) -> Result<Value> {
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
