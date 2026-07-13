/**
 * AST-grade extraction via WASM tree-sitter (no native binaries, devpod-safe).
 * Extracts symbols with class nesting + signatures, and call sites for a
 * heuristic call graph. Gracefully returns null if WASM init fails, letting
 * the indexer fall back to regex extraction.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM_DIR = path.join(HERE, "node_modules", "tree-sitter-wasms", "out");

const GRAMMAR_BY_LANG = {
  javascript: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  java: "tree-sitter-java.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  python: "tree-sitter-python.wasm",
};

let ParserCls = null;
const langCache = new Map();

export async function initAst(log = () => {}) {
  try {
    const TS = await import("web-tree-sitter");
    ParserCls = TS.Parser ?? TS.default;
    await (ParserCls.init?.() ?? TS.default.init());
    ParserCls._LanguageCls = TS.Language ?? ParserCls.Language;
    log("INFO", "AST engine: WASM tree-sitter active");
    return true;
  } catch (e) {
    log("WARN", `AST engine unavailable (${e.message}); falling back to regex extraction`);
    ParserCls = null;
    return false;
  }
}

async function languageFor(lang, ext) {
  const key = lang === "typescript" && (ext === ".tsx" || ext === ".jsx") ? "tsx" : lang;
  const wasm = GRAMMAR_BY_LANG[key];
  if (!ParserCls || !wasm) return null;
  if (!langCache.has(key)) {
    const file = path.join(WASM_DIR, wasm);
    if (!fs.existsSync(file)) return null;
    langCache.set(key, await ParserCls._LanguageCls.load(file));
  }
  return langCache.get(key);
}

// node-type → symbol kind, per language family
const DEFS = {
  js: {
    function_declaration: "function", generator_function_declaration: "function",
    method_definition: "method", class_declaration: "class",
    abstract_class_declaration: "class", interface_declaration: "type",
    type_alias_declaration: "type", enum_declaration: "type",
  },
  java: {
    class_declaration: "class", interface_declaration: "class",
    enum_declaration: "class", record_declaration: "class",
    method_declaration: "method", constructor_declaration: "method",
    annotation_type_declaration: "class",
  },
  python: {
    function_definition: "function", class_definition: "class",
  },
  kotlin: {
    class_declaration: "class", object_declaration: "class",
    function_declaration: "function",
  },
};
const CALL_NODES = new Set(["call_expression", "method_invocation", "call", "object_creation_expression", "new_expression"]);
// language builtins that are near-never user-defined; keeps the call table signal-dense
const NOISE = new Set(["print", "len", "str", "int", "float", "range", "isinstance", "super",
  "require", "console", "Boolean", "String", "Number", "Object", "Array", "Symbol",
  "append", "extend", "splitlines", "startswith", "endswith", "strip", "join", "split",
  "replace", "format", "items", "keys", "values", "encode", "decode", "lower", "upper",
  "push", "pop", "shift", "slice", "splice", "indexOf", "includes", "toString", "hasOwnProperty"]);
const CLASS_KINDS = new Set(["class", "type"]);

function familyOf(lang) {
  return lang === "java" ? "java" : lang === "python" ? "python" : lang === "kotlin" ? "kotlin" : "js";
}

function nameOf(node) {
  const n = node.childForFieldName?.("name");
  if (n) return n.text;
  // kotlin grammar (and some others) doesn't use a 'name' field
  for (const c of node.namedChildren) {
    if (c.type === "simple_identifier" || c.type === "type_identifier" || c.type === "identifier") return c.text;
  }
  return null;
}

function calleeName(node) {
  // call_expression: function field is identifier or member_expression
  const fn = node.childForFieldName?.("function") ?? node.childForFieldName?.("name")
    ?? node.childForFieldName?.("constructor") ?? node.childForFieldName?.("type");
  if (!fn) {
    // kotlin: call_expression has no field names, first child is the callee expr
    const first = node.namedChildren[0];
    if (!first) return null;
    if (first.type === "simple_identifier") return first.text;
    if (first.type === "navigation_expression") {
      const ids = first.descendantsOfType?.("simple_identifier") ?? [];
      return ids.length ? ids[ids.length - 1].text : null;
    }
    return null;
  }
  if (fn.type === "identifier" || fn.type === "type_identifier") return fn.text;
  const prop = fn.childForFieldName?.("property") ?? fn.childForFieldName?.("field")
    ?? fn.childForFieldName?.("name");
  if (prop) return prop.text;
  if (fn.type === "member_expression" || fn.type === "field_access") {
    const last = fn.namedChildren[fn.namedChildren.length - 1];
    return last?.text ?? null;
  }
  return fn.text?.split(".").pop() ?? null;
}

function sigOf(node) {
  const p = node.childForFieldName?.("parameters") ?? node.childForFieldName?.("formal_parameters");
  return p ? p.text.replace(/\s+/g, " ").slice(0, 200) : "";
}

/** Extract arrow/function components assigned to consts: `const X = () => ...` */
function arrowSymbols(node, out, parentName) {
  if (node.type !== "lexical_declaration" && node.type !== "variable_declaration") return false;
  let found = false;
  for (const decl of node.namedChildren) {
    if (decl.type !== "variable_declarator") continue;
    const value = decl.childForFieldName("value");
    if (value && (value.type === "arrow_function" || value.type === "function_expression" || value.type === "function")) {
      out.push({
        name: decl.childForFieldName("name")?.text ?? "?",
        kind: "function", line: node.startPosition.row + 1,
        sig: sigOf(value), parent: parentName, node: value,
      });
      found = true;
    }
  }
  return found;
}

/**
 * Walk the tree; return { symbols: [{name,kind,line,sig,parent}], calls: [{caller,callee,line}] }.
 * `caller` is the name of the innermost enclosing symbol (function/method), or null at top level.
 */
export async function extractAst(lang, ext, text) {
  const language = await languageFor(lang, ext);
  if (!language) return null;
  const parser = new ParserCls();
  parser.setLanguage(language);
  const tree = parser.parse(text);
  const family = familyOf(lang);
  const defs = DEFS[family];
  const symbols = [];
  const calls = [];

  function walk(node, enclosing, parentClass) {
    let newEnclosing = enclosing;
    let newParentClass = parentClass;

    const kind = defs[node.type];
    if (kind) {
      const name = nameOf(node);
      if (name) {
        symbols.push({ name, kind, line: node.startPosition.row + 1, sig: sigOf(node), parent: parentClass ?? null });
        if (kind === "function" || kind === "method") newEnclosing = name;
        if (CLASS_KINDS.has(kind)) newParentClass = name;
        // python/kotlin: functions nested in classes are methods
        if ((family === "python" || family === "kotlin") && kind === "function" && parentClass) symbols[symbols.length - 1].kind = "method";
      }
    } else if (family === "js") {
      const before = symbols.length;
      const arrows = [];
      if (arrowSymbols(node, arrows, parentClass)) {
        for (const a of arrows) {
          const { node: fnNode, ...sym } = a;
          symbols.push(sym);
          // walk the arrow body with this name as the enclosing symbol
          walk(fnNode, sym.name, parentClass);
        }
        // still walk non-declarator children? declarators covered above; skip re-walk
        return;
      }
      void before;
    }

    if (CALL_NODES.has(node.type)) {
      const callee = calleeName(node);
      if (callee && callee !== newEnclosing && !NOISE.has(callee)) {
        calls.push({ caller: newEnclosing ?? null, callee, line: node.startPosition.row + 1 });
      }
    }

    for (const child of node.namedChildren) walk(child, newEnclosing, newParentClass);
  }

  walk(tree.rootNode, null, null);
  tree.delete();
  return { symbols, calls };
}
