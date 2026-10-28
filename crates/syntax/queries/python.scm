; Overrides appended after the upstream Python query. Later patterns win.

(call function: (attribute attribute: (identifier) @method))
(attribute attribute: (identifier) @property)
(call function: (attribute attribute: (identifier) @method))

; Classes and functions
(class_definition name: (identifier) @class)
(class_definition superclasses: (argument_list (identifier) @class))
(class_definition body: (block (function_definition name: (identifier) @method)))
(class_definition body: (block (decorated_definition definition: (function_definition name: (identifier) @method))))
((identifier) @keyword
 (#match? @keyword "^(self|cls)$"))
(type (identifier) @class
 (#match? @class "^[A-Z]"))
((identifier) @constant
 (#match? @constant "^_*[A-Z][A-Z0-9_]+$"))

; Parameters
(parameters (identifier) @parameter)
(default_parameter name: (identifier) @parameter)
(typed_parameter (identifier) @parameter)
(typed_default_parameter name: (identifier) @parameter)
(lambda_parameters (identifier) @parameter)
(list_splat_pattern (identifier) @parameter)
(dictionary_splat_pattern (identifier) @parameter)
(parameters ((identifier) @keyword (#match? @keyword "^(self|cls)$")))

; Imports
(import_statement name: (dotted_name) @importPath.all)
(import_statement
  name: (aliased_import
    name: (dotted_name) @importPath.all
    alias: (identifier) @namespace))
(import_from_statement module_name: (dotted_name) @importPath.all)
(import_from_statement module_name: (relative_import) @importPath.all)
(import_from_statement name: (dotted_name) @variable)
(import_from_statement
  name: (dotted_name (identifier) @class)
 (#match? @class "^[A-Z]"))
(import_from_statement
  name: (aliased_import
    name: (dotted_name) @variable
    alias: (identifier) @variable))
(import_from_statement
  name: (aliased_import name: (dotted_name (identifier) @class))
 (#match? @class "^[A-Z]"))
(import_from_statement
  name: (aliased_import alias: (identifier) @class)
 (#match? @class "^[A-Z]"))
(wildcard_import) @operator

; Decorators
(decorator) @annotation
(decorator (identifier) @annotation)
(decorator (attribute) @annotation.all)
(decorator (call function: (identifier) @annotation))
(decorator (call function: (attribute) @annotation.all))

; Literals and docstrings
(none) @constant
[
  (true)
  (false)
] @boolean
(escape_sequence) @escape
(module . (expression_statement (string) @docComment))
(class_definition body: (block . (expression_statement (string) @docComment)))
(function_definition body: (block . (expression_statement (string) @docComment)))

; Control flow keywords
[
  "if" "elif" "else" "for" "while" "break" "continue" "return" "raise" "try"
  "except" "finally" "yield" "await" "match" "case"
] @controlKeyword
