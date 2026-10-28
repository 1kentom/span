; Overrides appended after the upstream Rust query. Later patterns win.

; Type references and declarations
(type_identifier) @class
(primitive_type) @type
((type_identifier) @typeParameter
 (#match? @typeParameter "^[A-Z][0-9]?$"))
(type_parameter name: (type_identifier) @typeParameter)
(struct_item name: (type_identifier) @class)
(union_item name: (type_identifier) @class)
(enum_item name: (type_identifier) @enum)
(trait_item name: (type_identifier) @interface)
(type_item name: (type_identifier) @type)
(impl_item trait: (type_identifier) @interface)
(abstract_type trait: (type_identifier) @interface)
(trait_bounds (type_identifier) @interface)
(enum_variant name: (identifier) @constant)

; Constants
((identifier) @constant
 (#match? @constant "^[A-Z][A-Z0-9_]+$"))
(const_item name: (identifier) @constant)
(static_item name: (identifier) @constant)

; Paths: lower case segments are modules
(scoped_identifier path: (identifier) @namespace
 (#match? @namespace "^[a-z_]"))
(scoped_identifier path: (scoped_identifier name: (identifier) @namespace)
 (#match? @namespace "^[a-z_]"))
(scoped_type_identifier path: (identifier) @namespace
 (#match? @namespace "^[a-z_]"))
(mod_item name: (identifier) @namespace)

; Members and parameters
(field_declaration name: (field_identifier) @property)
(closure_parameters (identifier) @parameter)
(self_parameter) @keyword
(impl_item body: (declaration_list (function_item name: (identifier) @method)))
(trait_item body: (declaration_list (function_item name: (identifier) @method)))
(trait_item body: (declaration_list (function_signature_item name: (identifier) @method)))
(call_expression
  function: (field_expression field: (field_identifier) @method))

; Imports
(use_declaration argument: (identifier) @importPath)
(use_declaration
  argument: (scoped_identifier
    path: (_) @importPath.all
    name: (identifier) @importPath))
(use_declaration
  argument: (scoped_identifier
    path: (_) @importPath.all
    name: (identifier) @class)
 (#match? @class "^[A-Z]"))
(use_declaration
  argument: (scoped_use_list path: (_) @importPath.all))
(use_declaration
  argument: (use_wildcard (_) @importPath.all))
(use_list (identifier) @importPath)
(use_list (identifier) @class
 (#match? @class "^[A-Z]"))
(use_list
  (scoped_identifier
    path: (_) @importPath.all
    name: (identifier) @importPath))
(use_list
  (scoped_identifier
    path: (_) @importPath.all
    name: (identifier) @class)
 (#match? @class "^[A-Z]"))
(use_as_clause alias: (identifier) @namespace)
(use_as_clause alias: (identifier) @class
 (#match? @class "^[A-Z]"))

; Macros, attributes and lifetimes
(macro_invocation macro: (identifier) @macro "!" @macro)
(macro_invocation
  macro: (scoped_identifier name: (identifier) @macro)
  "!" @macro)
(macro_definition name: (identifier) @macro)
(attribute_item) @annotation.all
(inner_attribute_item) @annotation.all
(lifetime) @label.all
(label) @label.all
(boolean_literal) @boolean
(escape_sequence) @escape

; Control flow keywords
[
  "if" "else" "match" "for" "while" "loop" "break" "continue" "return" "yield"
  "await"
] @controlKeyword
