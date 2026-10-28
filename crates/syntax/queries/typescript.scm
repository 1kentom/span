; TypeScript specific overrides, appended after the JavaScript overrides.

(predefined_type) @type
(type_identifier) @class
((type_identifier) @typeParameter
 (#match? @typeParameter "^[A-Z][0-9]?$"))
(type_parameter name: (type_identifier) @typeParameter)

(class_declaration name: (type_identifier) @class)
(abstract_class_declaration name: (type_identifier) @class)
(interface_declaration name: (type_identifier) @interface)
(enum_declaration name: (identifier) @enum)
(type_alias_declaration name: (type_identifier) @type)
(internal_module name: (identifier) @namespace)
(module name: (identifier) @namespace)
(nested_type_identifier module: (identifier) @namespace)
(nested_identifier (identifier) @namespace)
(enum_body name: (property_identifier) @constant)
(enum_assignment name: (property_identifier) @constant)
(implements_clause (type_identifier) @interface)
(extends_type_clause type: (type_identifier) @interface)

(required_parameter (identifier) @parameter)
(required_parameter (rest_pattern (identifier) @parameter))
(optional_parameter (identifier) @parameter)
(public_field_definition name: (property_identifier) @property)
(property_signature name: (property_identifier) @property)
(method_signature name: (property_identifier) @method)
