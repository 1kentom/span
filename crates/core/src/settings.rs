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

/// Language server behaviour, stored under the `languageServers` settings key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct LanguageServerSettings {
    /// Download missing language servers on first use. When false, nothing is
    /// downloaded until the user asks for an install.
    pub auto_install: bool,
    /// Per-server switches keyed by server id (`vtsls`, `html`, `css`, `json`,
    /// `rust-analyzer`, `basedpyright`, `jdtls`). A server that is not listed is enabled.
    pub enabled: HashMap<String, bool>,
    /// JDK home used to run JDT LS, instead of searching the host.
    pub java_home: Option<String>,
    /// Node.js executable used to run the npm based servers, instead of searching the host.
    pub node_path: Option<String>,
}

pub const LANGUAGE_SERVER_IDS: &[&str] = &[
    "vtsls",
    "html",
    "css",
    "json",
    "rust-analyzer",
    "basedpyright",
    "jdtls",
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
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum AutoSaveMode {
    #[default]
    Off,
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
            auto_save: AutoSaveMode::Off,
            auto_save_delay: 1000,
            tab_limit_enabled: true,
            tab_limit: 10,
            tab_limit_per_group: false,
            zoom_level: None,
            keybindings: HashMap::new(),
            formatters: HashMap::new(),
            language_servers: LanguageServerSettings::default(),
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
    "toggleWordWrap",
    "markdownPreview",
    "formatDocument",
    "goToLine",
    "zoomIn",
    "zoomOut",
    "resetZoom",
];

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
        ("toggleWordWrap", vec!["Alt+Z"]),
        ("markdownPreview", vec!["Mod+Shift+V"]),
        ("formatDocument", vec!["Alt+Shift+F"]),
        ("goToLine", vec!["Ctrl+G", "Mod+Alt+G"]),
        ("zoomIn", vec!["Mod+=", "Mod+Shift+="]),
        ("zoomOut", vec!["Mod+-"]),
        ("resetZoom", vec!["Mod+0"]),
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
            let normalized = format!("{}+{key}", modifiers.join("+"));
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
    merge_file(&mut value, workspace)?;
    decode(value)
}

fn decode(value: Value) -> Result<Settings> {
    let settings: Settings =
        serde_json::from_value(value).map_err(|e| CoreError::Settings(e.to_string()))?;
    settings.validate()?;
    Ok(settings)
}

fn merge_file(target: &mut Value, path: &Path) -> Result<()> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(io_error("Read settings", path, e)),
    };
    let value =
        parse(&text).map_err(|e| CoreError::Settings(format!("{}: {e}", path.display())))?;
    merge(target, normalize(value)?);
    Ok(())
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
    ("window.zoomLevel", "zoomLevel"),
    ("workbench.editor.limit.enabled", "tabLimitEnabled"),
    ("workbench.editor.limit.value", "tabLimit"),
    ("workbench.editor.limit.perEditorGroup", "tabLimitPerGroup"),
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
    Ok(value)
}

pub(crate) fn load_with_texts(user: &str, workspace: &str) -> Result<Settings> {
    let mut value = serde_json::to_value(Settings::default())
        .map_err(|error| CoreError::Settings(error.to_string()))?;
    merge(&mut value, normalize(parse(user)?)?);
    merge(&mut value, normalize(parse(workspace)?)?);
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
        assert!(defaults.is_enabled("jdtls"));
        let value = load_with_texts(
            "{}",
            r#"{ "languageServers": { "autoInstall": true, "enabled": { "jdtls": false },
                 "javaHome": "/opt/jdk", "nodePath": "/usr/bin/node" } }"#,
        )
        .unwrap()
        .language_servers;
        assert!(value.auto_install && !value.is_enabled("jdtls") && value.is_enabled("vtsls"));
        assert_eq!(value.java_home.as_deref(), Some("/opt/jdk"));
    }

    #[test]
    fn language_server_settings_reject_unknown_servers_and_bad_paths() {
        for text in [
            r#"{ "languageServers": { "enabled": { "gopls": true } } }"#,
            r#"{ "languageServers": { "javaHome": "" } }"#,
            r#"{ "languageServers": { "nodePath": "a\u0000b" } }"#,
            r#"{ "languageServers": { "bogus": 1 } }"#,
        ] {
            assert!(load_with_texts("{}", text).is_err(), "{text}");
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
