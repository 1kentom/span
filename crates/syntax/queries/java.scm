; Complete Java highlight query. Later patterns win over earlier ones on the
; same node. Captures named `<token>.all` repaint their whole node.

(identifier) @variable
(type_identifier) @class
((type_identifier) @typeParameter
 (#match? @typeParameter "^[A-Z][0-9]?$"))
(type_parameter (type_identifier) @typeParameter)

; Keywords
[
  "abstract" "assert" "class" "default" "enum" "exports" "extends" "final"
  "implements" "import" "instanceof" "interface" "module" "native" "new"
  "non-sealed" "open" "opens" "package" "permits" "private" "protected"
  "provides" "public" "requires" "record" "sealed" "static" "strictfp"
  "synchronized" "throws" "to" "transient" "transitive" "uses" "volatile"
  "with"
] @keyword
[
  "break" "case" "catch" "continue" "do" "else" "finally" "for" "if"
  "return" "switch" "throw" "try" "when" "while" "yield"
] @controlKeyword

; Operators and punctuation
[
  "=" "==" "!=" "<" ">" "<=" ">=" "+" "-" "*" "/" "%" "&" "|" "^" "~" "!"
  "&&" "||" "++" "--" "+=" "-=" "*=" "/=" "%=" "&=" "|=" "^=" "<<" ">>"
  ">>>" "<<=" ">>=" ">>>=" "->" "::" "?" ":"
] @operator
[
  "(" ")" "[" "]" "{" "}" ";" "," "."
] @punctuation

[
  (boolean_type)
  (integral_type)
  (floating_point_type)
  (void_type)
] @type

; Class references used as expression qualifiers
((field_access object: (identifier) @class)
 (#match? @class "^[A-Z][A-Za-z0-9_]*[a-z]"))
((method_invocation object: (identifier) @class)
 (#match? @class "^[A-Z][A-Za-z0-9_]*[a-z]"))
((method_reference . (identifier) @class)
 (#match? @class "^[A-Z][A-Za-z0-9_]*[a-z]"))
((scoped_identifier scope: (identifier) @class)
 (#match? @class "^[A-Z][A-Za-z0-9_]*[a-z]"))

; Declarations
(class_declaration name: (identifier) @class)
(record_declaration name: (identifier) @class)
(interface_declaration name: (identifier) @interface)
(enum_declaration name: (identifier) @enum)
(annotation_type_declaration name: (identifier) @annotation)
(constructor_declaration name: (identifier) @class)
(enum_constant name: (identifier) @constant)
(super_interfaces (type_list (type_identifier) @interface))
(extends_interfaces (type_list (type_identifier) @interface))

; Members, locals and parameters
(variable_declarator name: (identifier) @variable)
(field_declaration declarator: (variable_declarator name: (identifier) @property))
(field_access field: (identifier) @property)
(formal_parameter name: (identifier) @parameter)
(spread_parameter (variable_declarator name: (identifier) @parameter))
(catch_formal_parameter name: (identifier) @parameter)
(inferred_parameters (identifier) @parameter)
(lambda_expression parameters: (identifier) @parameter)
((identifier) @constant
 (#match? @constant "^_*[A-Z][A-Z0-9_]+$"))
(field_declaration
  (modifiers "static" "final")
  declarator: (variable_declarator name: (identifier) @constant))
(field_declaration
  (modifiers "final" "static")
  declarator: (variable_declarator name: (identifier) @constant))

; Methods: declarations and calls
(method_declaration name: (identifier) @method)
(method_invocation name: (identifier) @method)
(method_reference (identifier) @method .)

(this) @keyword
(super) @keyword

; Labels
(labeled_statement . (identifier) @label)
(break_statement (identifier) @label)
(continue_statement (identifier) @label)

; Packages and imports
(package_declaration (scoped_identifier) @namespace.all)
(package_declaration (identifier) @namespace)
(import_declaration
  "import" .
  (scoped_identifier
    scope: (_) @importPath.all
    name: (identifier) @class))
(import_declaration (identifier) @importPath)
(import_declaration
  (scoped_identifier) @importPath.all
  (asterisk))
(import_declaration
  "static"
  (scoped_identifier
    scope: (scoped_identifier
      scope: (_) @importPath.all
      name: (identifier) @class)
    name: (identifier) @method))
(import_declaration
  "static"
  (scoped_identifier
    scope: (scoped_identifier
      scope: (_) @importPath.all
      name: (identifier) @class)
    name: (identifier) @constant
    (#match? @constant "^_*[A-Z][A-Z0-9_]*$")))
(import_declaration
  "static"
  (scoped_identifier
    scope: (_) @importPath.all
    name: (identifier) @class)
  (asterisk))
(asterisk) @operator

; Annotations
(marker_annotation) @annotation.all
(annotation "@" @annotation)
(annotation name: (_) @annotation.all)

; Literals
[
  (hex_integer_literal)
  (decimal_integer_literal)
  (octal_integer_literal)
  (binary_integer_literal)
  (decimal_floating_point_literal)
  (hex_floating_point_literal)
] @number
[
  (character_literal)
  (string_literal)
] @string
(escape_sequence) @escape
[
  (true)
  (false)
] @boolean
(null_literal) @constant

; Comments
[
  (line_comment)
  (block_comment)
] @comment
((block_comment) @docComment
 (#match? @docComment "^/\\*\\*"))

