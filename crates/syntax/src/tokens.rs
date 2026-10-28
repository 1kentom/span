//! Colour token ids and the single capture to token mapping table.
//!
//! The ids are the contract with the UI: each one has a `--syn-<id>` CSS custom
//! property and a `cm-tree-<id>` class. `ui/src/editor/syntax-palette.ts` lists the
//! same ids and a UI test keeps both lists identical.

/// Every colour token, in the order the palette module lists them.
pub const TOKEN_IDS: [&str; 30] = [
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

/// Suffix that makes a capture paint its whole node, replacing every span from
/// an earlier pattern inside it (for example a whole `javafx.scene.control` path).
pub const COVER_SUFFIX: &str = ".all";

/// Captures that are deliberately dropped instead of coloured.
#[cfg(test)]
pub const IGNORED_CAPTURES: [&str; 1] = ["embedded"];

/// Upstream grammar capture names (the conventional tree-sitter names) mapped to
/// token ids. Token ids themselves are always valid capture names.
const UPSTREAM: [(&str, &str); 38] = [
    ("keyword", "keyword"),
    ("keyword.control", "controlKeyword"),
    ("operator", "operator"),
    ("punctuation", "punctuation"),
    ("punctuation.bracket", "punctuation"),
    ("punctuation.delimiter", "punctuation"),
    ("punctuation.special", "punctuation"),
    ("comment", "comment"),
    ("comment.documentation", "docComment"),
    ("string", "string"),
    ("string.special", "string"),
    ("string.special.key", "property"),
    ("string.escape", "escape"),
    ("character", "string"),
    ("number", "number"),
    ("boolean", "boolean"),
    ("constant", "constant"),
    ("constant.builtin", "constant"),
    ("function", "function"),
    ("function.call", "function"),
    ("function.builtin", "function"),
    ("function.method", "method"),
    ("function.macro", "macro"),
    ("method", "method"),
    ("type", "type"),
    ("type.builtin", "type"),
    ("constructor", "class"),
    ("variable", "variable"),
    ("variable.builtin", "keyword"),
    ("variable.parameter", "parameter"),
    ("property", "property"),
    ("module", "namespace"),
    ("label", "label"),
    ("tag", "tag"),
    ("attribute", "attribute"),
    ("escape", "escape"),
    ("tag.attribute", "attribute"),
    ("text.title", "function"),
];

/// Maps one capture name (without the cover suffix) to a token id.
pub fn capture_token(name: &str) -> Option<&'static str> {
    if let Some(id) = TOKEN_IDS.iter().find(|id| **id == name) {
        return Some(id);
    }
    UPSTREAM
        .iter()
        .find(|(upstream, _)| *upstream == name)
        .map(|(_, token)| *token)
}

/// Splits a raw capture name into its base name and the cover flag.
pub fn split_cover(name: &str) -> (&str, bool) {
    match name.strip_suffix(COVER_SUFFIX) {
        Some(base) => (base, true),
        None => (name, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_ids_are_unique_and_every_mapping_targets_a_token() {
        let mut ids = TOKEN_IDS.to_vec();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), TOKEN_IDS.len());
        for (upstream, token) in UPSTREAM {
            assert!(TOKEN_IDS.contains(&token), "{upstream} -> {token}");
        }
        let mut names: Vec<_> = UPSTREAM.iter().map(|(name, _)| *name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), UPSTREAM.len(), "duplicate upstream capture");
    }

    #[test]
    fn mapping_covers_documented_examples() {
        assert_eq!(capture_token("function.method"), Some("method"));
        assert_eq!(capture_token("comment.documentation"), Some("docComment"));
        assert_eq!(capture_token("importPath"), Some("importPath"));
        assert_eq!(capture_token("unknown.capture"), None);
        assert_eq!(split_cover("importPath.all"), ("importPath", true));
        assert_eq!(split_cover("string"), ("string", false));
    }
}
