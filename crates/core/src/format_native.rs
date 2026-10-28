use crate::{CoreError, Result};
use std::path::Path;

/// Format the languages supported by the embedded dprint formatter libraries.
/// The plugin crates expose the same Rust formatter implementation used by
/// their dprint Wasm plugins, without starting a child process or a Wasm host.
pub(crate) fn format(path: &Path, text: &str, language: &str, tab_size: u32) -> Result<String> {
    match language {
        "javascript" | "typescript" => format_typescript(path, text, tab_size),
        "json" => format_json(path, text, tab_size),
        "markdown" => format_markdown(text, tab_size),
        _ => Err(CoreError::Formatter(format!(
            "Native formatting does not support {language}"
        ))),
    }
}

fn format_typescript(path: &Path, text: &str, tab_size: u32) -> Result<String> {
    let config = dprint_plugin_typescript::configuration::ConfigurationBuilder::new()
        .indent_width(tab_size as u8)
        .build();
    let extension = path.extension().and_then(|ext| ext.to_str());
    let formatted =
        dprint_plugin_typescript::format_text(dprint_plugin_typescript::FormatTextOptions {
            path,
            extension,
            text: text.to_owned(),
            config: &config,
            external_formatter: None,
        })
        .map_err(|error| CoreError::Formatter(error.to_string()))?
        .unwrap_or_else(|| text.to_owned());
    Ok(preserve_line_endings(text, formatted))
}

fn format_json(path: &Path, text: &str, tab_size: u32) -> Result<String> {
    let config = dprint_plugin_json::configuration::ConfigurationBuilder::new()
        .indent_width(tab_size as u8)
        .build();
    let formatted = dprint_plugin_json::format_text(path, text, &config)
        .map_err(|error| CoreError::Formatter(error.to_string()))?
        .unwrap_or_else(|| text.to_owned());
    Ok(preserve_line_endings(text, formatted))
}

fn format_markdown(text: &str, tab_size: u32) -> Result<String> {
    let config = dprint_plugin_markdown::configuration::ConfigurationBuilder::new()
        .code_block_preserve_indentation(true)
        .build();
    let formatted = dprint_plugin_markdown::format_text(text, &config, |language, code, _line| {
        let language = language.trim().to_ascii_lowercase();
        let extension = match language.as_str() {
            "js" | "javascript" => "js",
            "jsx" => "jsx",
            "mjs" => "mjs",
            "cjs" => "cjs",
            "ts" | "typescript" => "ts",
            "tsx" => "tsx",
            "mts" => "mts",
            "cts" => "cts",
            "json" | "jsonc" => "jsonc",
            _ => return Ok(None),
        };
        let path = Path::new("markdown-code-block").with_extension(extension);
        let language = if extension == "jsonc" {
            "json"
        } else {
            "typescript"
        };
        format(&path, code, language, tab_size)
            .map(Some)
            .map_err(|error| match error {
                CoreError::Formatter(message) => dprint_plugin_markdown::FormatError::CodeBlock(
                    Box::new(std::io::Error::other(message)),
                ),
                error => dprint_plugin_markdown::FormatError::CodeBlock(Box::new(
                    std::io::Error::other(error.to_string()),
                )),
            })
    })
    .map_err(|error| CoreError::Formatter(error.to_string()))?
    .unwrap_or_else(|| text.to_owned());
    Ok(preserve_line_endings(text, formatted))
}

fn preserve_line_endings(original: &str, formatted: String) -> String {
    if original.contains("\r\n") && !original.replace("\r\n", "").contains('\n') {
        formatted.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        formatted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_tsx_unicode_and_comments_are_preserved_and_idempotent() {
        let path = Path::new("App.tsx");
        let source = "// привет\nconst App=()=> <div title=\"世界\">{1+2}</div>\n";
        let formatted = format(path, source, "typescript", 2).unwrap();
        assert!(formatted.contains("// привет"));
        assert!(formatted.contains("世界"));
        assert_eq!(
            format(path, &formatted, "typescript", 2).unwrap(),
            formatted
        );
    }

    #[test]
    fn jsonc_retains_comments_and_unknown_properties() {
        let path = Path::new("settings.jsonc");
        let source =
            "{\n// keep this note\n\"known\":1,\n\"unknownFutureOption\":{\"enabled\":true}\n}\n";
        let formatted = format(path, source, "json", 2).unwrap();
        assert!(formatted.contains("// keep this note"));
        assert!(formatted.contains("unknownFutureOption"));
        assert_eq!(format(path, &formatted, "json", 2).unwrap(), formatted);
    }

    #[test]
    fn markdown_formats_supported_fenced_code_and_is_idempotent() {
        let source = "# Title\n\n```ts\nconst answer=42\n```\n";
        let formatted = format(Path::new("guide.md"), source, "markdown", 2).unwrap();
        assert!(formatted.contains("const answer = 42;"));
        assert_eq!(
            format(Path::new("guide.md"), &formatted, "markdown", 2).unwrap(),
            formatted
        );
    }

    #[test]
    fn markdown_uses_jsx_and_tsx_parsers_and_leaves_unsupported_fences_alone() {
        let source = "```tsx\nconst View=()=> <div>{1+2}</div>\n```\n\n```jsx\nconst Card=()=> <section>{3+4}</section>\n```\n\n```custom\n  keep   this\n```\n";
        let formatted = format(Path::new("guide.md"), source, "markdown", 2).unwrap();
        assert!(formatted.contains("const View = () => <div>{1 + 2}</div>;"));
        assert!(formatted.contains("const Card = () => <section>{3 + 4}</section>;"));
        assert!(
            formatted.contains("```custom\n  keep   this\n```"),
            "{formatted:?}"
        );
        assert_eq!(
            format(Path::new("guide.md"), &formatted, "markdown", 2).unwrap(),
            formatted
        );
    }

    #[test]
    fn pure_crlf_documents_keep_crlf_line_endings() {
        let source = "const value=1;\r\n";
        let formatted = format(Path::new("main.ts"), source, "typescript", 2).unwrap();
        assert!(formatted.contains("\r\n"));
        assert!(!formatted.replace("\r\n", "").contains('\n'));
    }
}
