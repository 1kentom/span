//! Conventional Java source-file entry points, inspected structurally.
use tree_sitter::{Node, Parser};

/// The Java source launcher executes the first top-level type only. Compact
/// source files and nested classes require a separate project launch strategy.
pub fn java_main(source: &str) -> Option<(String, usize)> {
    if source.len() > 1024 * 1024 {
        return None;
    }
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_java::LANGUAGE.into())
        .ok()?;
    let tree = parser.parse(source, None)?;
    let root = tree.root_node();
    if root.has_error() {
        return None;
    }
    let mut cursor = root.walk();
    let class = root.named_children(&mut cursor).find(|node| {
        matches!(
            node.kind(),
            "class_declaration"
                | "interface_declaration"
                | "enum_declaration"
                | "record_declaration"
                | "annotation_type_declaration"
        )
    })?;
    if class.kind() != "class_declaration" {
        return None;
    }
    let name = class
        .child_by_field_name("name")?
        .utf8_text(source.as_bytes())
        .ok()?
        .to_owned();
    let body = class.child_by_field_name("body")?;
    let mut cursor = body.walk();
    for method in body
        .named_children(&mut cursor)
        .filter(|node| node.kind() == "method_declaration")
    {
        if method
            .child_by_field_name("name")?
            .utf8_text(source.as_bytes())
            .ok()?
            != "main"
            || method.child_by_field_name("type")?.kind() != "void_type"
            || method.child_by_field_name("body").is_none()
            || method.child_by_field_name("dimensions").is_some()
        {
            continue;
        }
        let mut method_cursor = method.walk();
        let Some(modifiers) = method
            .named_children(&mut method_cursor)
            .find(|node| node.kind() == "modifiers")
        else {
            continue;
        };
        let mut modifier_cursor = modifiers.walk();
        let kinds: Vec<_> = modifiers
            .children(&mut modifier_cursor)
            .map(|node| node.kind())
            .collect();
        if !kinds.contains(&"public") || !kinds.contains(&"static") {
            continue;
        }
        let parameters = method.child_by_field_name("parameters")?;
        let mut parameter_cursor = parameters.walk();
        let parameters: Vec<_> = parameters
            .named_children(&mut parameter_cursor)
            .filter(|node| !matches!(node.kind(), "line_comment" | "block_comment"))
            .collect();
        if parameters.len() != 1 {
            continue;
        }
        let parameter = parameters[0];
        let mut signature = String::new();
        let Some(parameter_name) = parameter.child_by_field_name("name").or_else(|| {
            let mut cursor = parameter.walk();
            let found = parameter
                .named_children(&mut cursor)
                .find(|node| node.kind() == "variable_declarator")
                .and_then(|node| node.child_by_field_name("name"));
            found
        }) else {
            continue;
        };
        parameter_signature(parameter, source, parameter_name, &mut signature);
        if matches!(
            signature.as_str(),
            "String[]" | "java.lang.String[]" | "String..." | "java.lang.String..."
        ) {
            return Some((
                name,
                method.child_by_field_name("name")?.start_position().row + 1,
            ));
        }
    }
    None
}

fn parameter_signature(node: Node<'_>, source: &str, name: Node<'_>, output: &mut String) {
    if node == name || matches!(node.kind(), "modifiers" | "line_comment" | "block_comment") {
        return;
    }
    if node.child_count() == 0 {
        if let Ok(text) = node.utf8_text(source.as_bytes()) {
            output.push_str(text);
        }
    } else {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            parameter_signature(child, source, name, output);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::java_main;
    #[test]
    fn detects_conventional_main_signatures_and_lines() {
        for signature in [
            "String[] args",
            "String args[]",
            "String... args",
            "final java.lang.String /* gap */ [] args",
        ] {
            let source = format!(
                "package demo;\nclass Test {{\n public static void main({signature}) {{}}\n}}"
            );
            assert_eq!(java_main(&source), Some(("Test".into(), 3)), "{signature}");
        }
    }
    #[test]
    fn rejects_decoys_invalid_signatures_and_nonfirst_classes() {
        for source in [
            "// class Test { public static void main(String[] args) {} }",
            "class Test { String decoy = \"public static void main(String[] args) {}\"; }",
            "class Test { public void main(String[] args) {} }",
            "class Test { public static int main(String[] args) { return 0; } }",
            "class Test { public static void main(String[][] args) {} }",
            "class Test { public static void main(String args) {} }",
            "class Test { public static void main(String[] args, int extra) {} }",
            "class Test { class Inner { public static void main(String[] args) {} } }",
            "class First {} class Second { public static void main(String[] args) {} }",
            "class Test { public static void main(String[] args) {",
        ] {
            assert_eq!(java_main(source), None, "{source}");
        }
    }
}
