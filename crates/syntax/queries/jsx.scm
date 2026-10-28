; JSX: component names are classes, intrinsic elements stay tags.

(jsx_opening_element name: (identifier) @class
 (#match? @class "^[A-Z]"))
(jsx_closing_element name: (identifier) @class
 (#match? @class "^[A-Z]"))
(jsx_self_closing_element name: (identifier) @class
 (#match? @class "^[A-Z]"))
(jsx_opening_element name: (member_expression) @class.all)
(jsx_closing_element name: (member_expression) @class.all)
(jsx_self_closing_element name: (member_expression) @class.all)
(jsx_attribute (property_identifier) @attribute)
