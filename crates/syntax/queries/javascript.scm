; Overrides appended after the upstream JavaScript query. Later patterns win.

(escape_sequence) @escape
(regex) @regexp
[
  (true)
  (false)
] @boolean

; Properties and members
(member_expression property: (property_identifier) @property)
(pair key: (property_identifier) @property)
(call_expression
  function: (member_expression property: (property_identifier) @method))
(method_definition name: (property_identifier) @method)

; Classes and constructors
(class_declaration name: (_) @class)
(new_expression constructor: (identifier) @class)
((identifier) @class
 (#match? @class "^[A-Z][A-Za-z0-9_]*[a-z]"))
([
    (identifier)
    (shorthand_property_identifier)
    (shorthand_property_identifier_pattern)
 ] @constant
 (#match? @constant "^_*[A-Z][A-Z0-9_]+$"))

; Parameters
(arrow_function parameter: (identifier) @parameter)

; Imports and exports
(import_statement source: (string) @importPath.all)
(export_statement source: (string) @importPath.all)
(namespace_import (identifier) @namespace)
(import_specifier name: (identifier) @variable)
(import_specifier name: (identifier) @class
 (#match? @class "^[A-Z]"))
(import_clause (identifier) @variable)
(import_clause (identifier) @class
 (#match? @class "^[A-Z]"))
(export_specifier name: (identifier) @variable)

; Decorators
(decorator "@" @annotation)
(decorator (identifier) @annotation)
(decorator (member_expression) @annotation.all)
(decorator (call_expression function: (identifier) @annotation))
(decorator (call_expression function: (member_expression) @annotation.all))

; Template strings and labels
(template_string) @string
(statement_identifier) @label

; Control flow keywords
[
  "if" "else" "for" "while" "do" "switch" "case" "default" "break" "continue"
  "return" "throw" "try" "catch" "finally" "yield" "await"
] @controlKeyword
