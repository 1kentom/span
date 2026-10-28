use crate::{io_error, CoreError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::{fs, path::Path};

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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::Dark,
            font_size: 13,
            tab_size: 2,
            word_wrap: false,
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
        Ok(())
    }
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

pub(crate) fn load_with_workspace_text(user: Option<&Path>, text: &str) -> Result<Settings> {
    let mut value = serde_json::to_value(Settings::default())
        .map_err(|e| CoreError::Settings(e.to_string()))?;
    if let Some(path) = user {
        merge_file(&mut value, path)?;
    }
    merge(&mut value, parse(text)?);
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
    merge(target, value);
    Ok(())
}

fn parse(text: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(&strip_jsonc(text)?)
        .map_err(|e| CoreError::Settings(e.to_string()))?;
    if !value.is_object() {
        return Err(CoreError::Settings(
            "Settings must contain an object".into(),
        ));
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
