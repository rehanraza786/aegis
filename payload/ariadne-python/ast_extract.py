"""AST-grade extraction via tree-sitter (prebuilt wheels; graceful regex fallback).
Mirror of the Node edition's ast.mjs: symbols with class nesting + a heuristic
call graph. get_ast_extractor() returns None if tree-sitter is unavailable."""
import logging

log = logging.getLogger("ariadne")

DEFS = {
    "java": {"class_declaration": "class", "interface_declaration": "class",
             "enum_declaration": "class", "record_declaration": "class",
             "method_declaration": "method", "constructor_declaration": "method"},
    "js": {"function_declaration": "function", "generator_function_declaration": "function",
           "method_definition": "method", "class_declaration": "class",
           "abstract_class_declaration": "class", "interface_declaration": "type",
           "type_alias_declaration": "type", "enum_declaration": "type"},
    "python": {"function_definition": "function", "class_definition": "class"},
    "kotlin": {"class_declaration": "class", "object_declaration": "class",
               "function_declaration": "function"},
}
CALL_NODES = {"call_expression", "method_invocation", "call",
              "object_creation_expression", "new_expression"}
CLASS_KINDS = {"class", "type"}
NOISE = {"print", "len", "str", "int", "float", "range", "isinstance", "super", "require",
         "console", "append", "extend", "splitlines", "startswith", "endswith", "strip",
         "join", "split", "replace", "format", "items", "keys", "values", "encode",
         "decode", "lower", "upper", "push", "pop", "slice", "indexOf", "includes"}
GRAMMAR = {"java": "java", "python": "python", "javascript": "javascript",
           "typescript": "typescript", "kotlin": "kotlin"}  # tsx handled by ext below


def _walk_ids(node):
    if node.type == "simple_identifier":
        yield node.text.decode()
    for c in node.named_children:
        yield from _walk_ids(c)


def get_ast_extractor():
    try:
        from tree_sitter_language_pack import get_parser
    except Exception as e:  # noqa: BLE001 - any import failure means fallback
        log.warning("AST engine unavailable (%s); using regex extraction", e)
        return None
    parsers = {}

    def family(lang):
        if lang in ("java", "python", "kotlin"):
            return lang
        return "js"

    def _name(node):
        n = node.child_by_field_name("name")
        if n is not None:
            return n.text.decode()
        for c in node.named_children:  # kotlin: no 'name' field
            if c.type in ("simple_identifier", "type_identifier", "identifier"):
                return c.text.decode()
        return None

    def _callee(node):
        fn = (node.child_by_field_name("function") or node.child_by_field_name("name")
              or node.child_by_field_name("type"))
        if fn is None:
            first = node.named_children[0] if node.named_children else None
            if first is None:
                return None
            if first.type == "simple_identifier":
                return first.text.decode()
            if first.type == "navigation_expression":
                ids = [c for c in _walk_ids(first)]
                return ids[-1] if ids else None
            return None
        if fn.type in ("identifier", "type_identifier"):
            return fn.text.decode()
        prop = (fn.child_by_field_name("property") or fn.child_by_field_name("field")
                or fn.child_by_field_name("attribute") or fn.child_by_field_name("name"))
        if prop is not None:
            return prop.text.decode()
        return fn.text.decode().split(".")[-1][:80]

    def _sig(node):
        p = node.child_by_field_name("parameters") or node.child_by_field_name("formal_parameters")
        return " ".join(p.text.decode().split())[:200] if p is not None else ""

    def extract(lang, ext, text):
        key = "tsx" if lang == "typescript" and ext in (".tsx", ".jsx") else GRAMMAR.get(lang)
        if key is None:
            return None
        if key not in parsers:
            try:
                parsers[key] = get_parser(key)
            except Exception:  # grammar missing in the pack
                parsers[key] = None
        parser = parsers[key]
        if parser is None:
            return None
        tree = parser.parse(text.encode())
        fam, defs = family(lang), DEFS[family(lang)]
        symbols, calls = [], []

        def walk(node, enclosing, parent_class):
            new_enclosing, new_parent = enclosing, parent_class
            kind = defs.get(node.type)
            if kind:
                name = _name(node)
                if name:
                    k = kind
                    if fam in ("python", "kotlin") and kind == "function" and parent_class:
                        k = "method"
                    symbols.append({"name": name, "kind": k, "line": node.start_point[0] + 1,
                                    "sig": _sig(node), "parent": parent_class})
                    if kind in ("function", "method"):
                        new_enclosing = name
                    if kind in CLASS_KINDS:
                        new_parent = name
            elif fam == "js" and node.type in ("lexical_declaration", "variable_declaration"):
                handled = False
                for decl in node.named_children:
                    if decl.type != "variable_declarator":
                        continue
                    value = decl.child_by_field_name("value")
                    if value is not None and value.type in ("arrow_function", "function_expression", "function"):
                        nm = decl.child_by_field_name("name")
                        nm = nm.text.decode() if nm is not None else "?"
                        symbols.append({"name": nm, "kind": "function",
                                        "line": node.start_point[0] + 1,
                                        "sig": _sig(value), "parent": parent_class})
                        for ch in value.named_children:
                            walk(ch, nm, parent_class)
                        handled = True
                if handled:
                    return
            if node.type in CALL_NODES:
                callee = _callee(node)
                if callee and callee != new_enclosing and callee not in NOISE:
                    calls.append({"caller": new_enclosing, "callee": callee,
                                  "line": node.start_point[0] + 1})
            for child in node.named_children:
                walk(child, new_enclosing, new_parent)

        walk(tree.root_node, None, None)
        return {"symbols": symbols, "calls": calls}

    log.info("AST engine: tree-sitter active")
    return extract
