#!/usr/bin/env node
/**
 * Ariadne (GraphRAG-style) codebase indexer (Node edition).
 * Builds a queryable graph of the repo in SQLite (.ariadne/index.db).
 * Production traits: WAL mode, cross-process lockfile, structured logging,
 * config file support, schema versioning, graceful degradation.
 *
 * Usage: node indexer.mjs --full | --incremental | --status
 */
import Database from "better-sqlite3";
import { initAst, extractAst } from "./ast.mjs";
const AST_LANGS = new Set(["java", "kotlin", "typescript", "javascript", "python"]);
let astReady = false;
import { loadConfigMap, loadConstants, extractKafkaEdges } from "./kafka.mjs";
import { isChangelog, extractChangelog, extractEntities, extractDbAccess, extractLombokSymbols } from "./db.mjs";
import { extractJavaHttp, extractTsHttp, normalizePath as normalizeAssertedPath } from "./http.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SCHEMA_VERSION = 5;

// ---------------------------------------------------------------- utilities
function git(args, opts = {}) {
  try {
    return execFileSync("git", args, { encoding: "utf8", timeout: 30_000, ...opts }).trim();
  } catch {
    return "";
  }
}

// Roots: ARIADNE_ROOTS env (comma-separated) > current git repo > child git repos (workspace parent)
function discoverRoots() {
  if (process.env.ARIADNE_ROOTS) {
    return process.env.ARIADNE_ROOTS.split(",").map((p) => path.resolve(p.trim())).filter((p) => fs.existsSync(p));
  }
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top) return [top];
  const cwd = process.cwd();
  const kids = fs.readdirSync(cwd, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && fs.existsSync(path.join(cwd, d.name, ".git")))
    .map((d) => path.join(cwd, d.name));
  return kids.length ? kids : [cwd];
}
const ROOTS = discoverRoots();
const MULTI = ROOTS.length > 1;
const REPO_ROOT = MULTI ? process.cwd() : ROOTS[0];
const prefixOf = (root) => (MULTI ? path.basename(root) : "");
const ROOT_BY_PREFIX = new Map(ROOTS.map((r) => [prefixOf(r), r]));
function absPath(rel) {
  if (!MULTI) return path.join(REPO_ROOT, rel);
  const [head, ...rest] = rel.split("/");
  const root = ROOT_BY_PREFIX.get(head);
  return root ? path.join(root, rest.join("/")) : path.join(REPO_ROOT, rel);
}
const GR_DIR = path.join(process.env.ARIADNE_HOME ?? REPO_ROOT, ".ariadne");
const DB_PATH = path.join(GR_DIR, "index.db");
const LOCK_PATH = path.join(GR_DIR, ".index.lock");
const LOG_PATH = path.join(GR_DIR, "index.log");

// rotate oversized logs once per process: keep the tail, never block
try {
  if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 5 * 1024 * 1024) {
    const buf = fs.readFileSync(LOG_PATH);
    fs.writeFileSync(LOG_PATH, "[log rotated]\n" + buf.slice(-512 * 1024).toString("utf8"));
  }
} catch { /* rotation must never crash indexing */ }

function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (level !== "DEBUG") console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + "\n"); } catch { /* logging must never crash indexing */ }
}

// Config: optional .ariadne/config.json overrides
const DEFAULTS = {
  skipDirs: [".git", ".ariadne", "node_modules", "vendor", "dist", "build", "target",
    "__pycache__", ".venv", "venv", ".next", "coverage", ".idea", ".vscode", "out", ".gradle"],
  aliasPrefixes: ["@/", "~/"],
  maxFileBytes: 1_500_000,
  chunkLines: 40,
  extraExtensions: {},
  testPathPatterns: [],
  prodPathPatterns: [],
};
let config = DEFAULTS;
try {
  const userCfg = JSON.parse(fs.readFileSync(path.join(GR_DIR, "config.json"), "utf8"));
  config = { ...DEFAULTS, ...userCfg, skipDirs: [...new Set([...DEFAULTS.skipDirs, ...(userCfg.skipDirs ?? [])])] };
  log("INFO", "Loaded .ariadne/config.json overrides");
} catch { /* no config file: defaults */ }

const LANG_BY_EXT = {
  ".py": "python", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".java": "java", ".cs": "csharp",
  ".go": "go", ".rs": "rust", ".rb": "ruby", ".php": "php", ".c": "c", ".h": "c",
  ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp", ".kt": "kotlin", ".kts": "kotlin", ".gradle": "config", ".swift": "swift",
  ".scala": "scala", ".sql": "sql", ".sh": "shell", ".yaml": "config", ".yml": "config",
  ".toml": "config", ".json": "config", ".xml": "config", ".md": "docs", ".pdf": "docs", ...config.extraExtensions,
};

// classifies WHERE a file lives (test vs production), decided once at index time;
// readers consume files.is_test. parity: must match is_test_path (Python edition)
const TEST_PATTERNS = config.testPathPatterns.map((p) => new RegExp(p));
const PROD_PATTERNS = config.prodPathPatterns.map((p) => new RegExp(p));
const TEST_DIRS = new Set(["test", "tests", "__tests__", "__mocks__"]);
export function isTestPath(rel) {
  if (PROD_PATTERNS.some((p) => p.test(rel))) return false;
  if (/(^|\/)src\/main\//.test(rel)) return false;
  if (/(^|\/)src\/(test|integrationTest|testFixtures)\//.test(rel)) return true;
  const segs = rel.split("/");
  if (segs.slice(0, -1).some((s) => TEST_DIRS.has(s))) return true;
  const base = segs.at(-1);
  if (/(Test|Tests|IT|ITCase)\.(java|kt|kts)$/.test(base)) return true;
  if (/\.(test|spec)\.(ts|tsx|mts|js|jsx|mjs|cjs)$/.test(base)) return true;
  if (/^test_.+\.py$/.test(base) || /_test\.py$/.test(base) || base === "conftest.py") return true;
  return TEST_PATTERNS.some((p) => p.test(rel));
}

// ------------------------------------------------------------- extraction
const S = (re) => new RegExp(re, "gm");
const SYMBOL_PATTERNS = {
  python: [
    [S(String.raw`^\s*def\s+(?<name>\w+)\s*(?<sig>\([^)]*\))`), "function"],
    [S(String.raw`^\s*class\s+(?<name>\w+)`), "class"],
  ],
  javascript: [
    [S(String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(?<name>\w+)\s*(?<sig>\([^)]*\))`), "function"],
    [S(String.raw`^\s*(?:export\s+)?class\s+(?<name>\w+)`), "class"],
    [S(String.raw`^\s*(?:export\s+)?const\s+(?<name>\w+)\s*(?::\s*[\w.<>,\[\]{}| ]+?)?=\s*(?:async\s*)?(?<sig>\([^)]*\)|\w+)\s*(?::\s*[\w.<>,\[\]| ]+)?\s*=>`), "function"],
  ],
  java: [
    [S(String.raw`^\s*(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+(?<name>\w+)`), "class"],
    [S(String.raw`^\s*(?:public|protected|private|default)\s+(?:static\s+|final\s+|abstract\s+|synchronized\s+)*[\w<>\[\], ?]+\s+(?<name>\w+)\s*(?<sig>\([^)]*\))\s*(?:throws[\w, ]+)?\s*[;{]`), "method"],
    [S(String.raw`^\s{2,}(?!new\b|return\b|throw\b|else\b|if\b|while\b|for\b|switch\b|super\b|this\b)[\w<>\[\], ?]+\s+(?<name>\w+)\s*(?<sig>\([^)]*\))\s*(?:throws[\w, ]+)?\s*;`), "method"],
  ],
  go: [
    [S(String.raw`^func\s+(?:\([^)]+\)\s+)?(?<name>\w+)\s*(?<sig>\([^)]*\))`), "function"],
    [S(String.raw`^type\s+(?<name>\w+)\s+(?:struct|interface)`), "class"],
  ],
  rust: [
    [S(String.raw`^\s*(?:pub(?:\([^)]*\))?\s+)?fn\s+(?<name>\w+)`), "function"],
    [S(String.raw`^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+(?<name>\w+)`), "class"],
  ],
  csharp: [
    [S(String.raw`^\s*(?:public|internal|protected|private)?\s*(?:static\s+|sealed\s+|abstract\s+|partial\s+)*(?:class|interface|enum|record|struct)\s+(?<name>\w+)`), "class"],
    [S(String.raw`^\s*(?:public|internal|protected|private)\s+(?:static\s+|async\s+|virtual\s+|override\s+)*[\w<>\[\], ?]+\s+(?<name>\w+)\s*(?<sig>\([^)]*\))`), "method"],
  ],
  ruby: [
    [S(String.raw`^\s*def\s+(?<name>[\w.?!=\[\]]+)`), "function"],
    [S(String.raw`^\s*(?:class|module)\s+(?<name>[\w:]+)`), "class"],
  ],
  php: [
    [S(String.raw`^\s*(?:public|protected|private)?\s*(?:static\s+)?function\s+(?<name>\w+)\s*(?<sig>\([^)]*\))`), "function"],
    [S(String.raw`^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+(?<name>\w+)`), "class"],
  ],
};
SYMBOL_PATTERNS.typescript = [
  ...SYMBOL_PATTERNS.javascript,
  [S(String.raw`^\s*(?:export\s+)?(?:interface|type|enum)\s+(?<name>\w+)`), "type"],
];

const IMPORT_PATTERNS = {
  python: [S(String.raw`^\s*(?:from\s+(?<mod>[\w.]+)\s+import|import\s+(?<mod2>[\w.]+))`)],
  javascript: [S(String.raw`(?:import\s+[^;]*?from\s+|require\s*\(\s*)['"](?<mod>[^'"]+)['"]`)],
  typescript: [S(String.raw`(?:import\s+[^;]*?from\s+|require\s*\(\s*)['"](?<mod>[^'"]+)['"]`)],
  java: [S(String.raw`^import\s+(?:static\s+)?(?<mod>[\w.]+);`)],
  csharp: [S(String.raw`^using\s+(?<mod>[\w.]+);`)],
  go: [S(String.raw`^\s*(?:import\s+)?"(?<mod>[\w./-]+)"`)],
  rust: [S(String.raw`^\s*use\s+(?<mod>[\w:]+)`)],
  ruby: [S(String.raw`^\s*require(?:_relative)?\s+['"](?<mod>[^'"]+)['"]`)],
  php: [S(String.raw`^use\s+(?<mod>[\w\\]+)`)],
};

function extractSymbols(lang, text) {
  const out = [];
  for (const [pattern, kind] of SYMBOL_PATTERNS[lang] ?? []) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      const line = text.slice(0, m.index).split("\n").length;
      out.push({ name: m.groups.name, kind, line, sig: (m.groups.sig ?? "").slice(0, 200) });
    }
  }
  return out;
}

function extractImports(lang, text) {
  const mods = new Set();
  for (const pattern of IMPORT_PATTERNS[lang] ?? []) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      const mod = m.groups.mod ?? m.groups.mod2;
      if (mod) mods.add(mod);
    }
  }
  return mods;
}

function resolveImport(mod, srcPath, allPaths) {
  if (mod.startsWith(".")) {
    const base = path.dirname(absPath(srcPath));
    const raw = path.resolve(base, mod);
    for (const suffix of ["", ".py", ".js", ".ts", ".jsx", ".tsx", ".mjs",
      "/index.js", "/index.ts", "/index.tsx", "/__init__.py"]) {
      for (const root of ROOTS) {
        const p = prefixOf(root);
        let rel = path.relative(root, raw + suffix).replaceAll("\\", "/");
        if (rel.startsWith("..")) continue;
        rel = p ? `${p}/${rel}` : rel;
        if (allPaths.has(rel)) return rel;
      }
    }
    return null;
  }
  let m = mod;
  for (const prefix of config.aliasPrefixes) if (m.startsWith(prefix)) m = m.slice(prefix.length);
  const tail = m.replaceAll(".", "/").replaceAll("::", "/").replaceAll("\\", "/");
  for (const p of allPaths) {
    const stem = p.replace(/\.[^.]+$/, "");
    if (stem.endsWith(tail)) return p;
  }
  return null;
}

// -------------------------------------------------------------------- lock
function acquireLock() {
  fs.mkdirSync(GR_DIR, { recursive: true });
  try {
    const fd = fs.openSync(LOCK_PATH, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    // stale lock (>10 min) gets broken; otherwise another indexer is running
    try {
      const age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
      if (age > 600_000) { fs.unlinkSync(LOCK_PATH); return acquireLock(); }
    } catch { /* raced */ }
    return false;
  }
}
function releaseLock() { try { fs.unlinkSync(LOCK_PATH); } catch { /* already gone */ } }

// ----------------------------------------------------------------- storage
function connect() {
  fs.mkdirSync(GR_DIR, { recursive: true });
  let db;
  try {
    db = new Database(DB_PATH);
    db.pragma("quick_check");
  } catch (e) {
    if (/SQLITE_CORRUPT|not a database|malformed|corrupt/i.test((e.message ?? "") + (e.code ?? ""))) {
      const aside = DB_PATH + ".corrupt-" + Date.now();
      try { db?.close(); } catch { /* half-open */ }
      try { fs.renameSync(DB_PATH, aside); } catch { /* best effort */ }
      for (const sfx of ["-wal", "-shm"]) { try { fs.rmSync(DB_PATH + sfx); } catch { /* absent */ } }
      log("WARN", `Index was corrupt, moved to ${path.basename(aside)}; rebuilding fresh`);
      db = new Database(DB_PATH);
    } else { throw e; }
  }
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  // WAL + NORMAL is durable across app crashes (only a power cut can lose the
  // last commit, and this is a rebuildable derived index, so that's free speed).
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -64000");   // 64 MB page cache
  db.pragma("temp_store = MEMORY");
  db.pragma("mmap_size = 268435456"); // 256 MB
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS files(
      id INTEGER PRIMARY KEY, path TEXT UNIQUE, lang TEXT, hash TEXT, lines INTEGER, indexed_at REAL);
    CREATE TABLE IF NOT EXISTS symbols(
      id INTEGER PRIMARY KEY, file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
      name TEXT, kind TEXT, line INTEGER, signature TEXT, parent TEXT);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE TABLE IF NOT EXISTS calls(
      src_symbol INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
      callee TEXT, line INTEGER);
    CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee);
    CREATE TABLE IF NOT EXISTS msg_edges(
      file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
      system TEXT DEFAULT 'kafka', topic TEXT, direction TEXT,
      line INTEGER, resolved INTEGER, via TEXT);
    CREATE INDEX IF NOT EXISTS idx_msg_topic ON msg_edges(topic);
    CREATE TABLE IF NOT EXISTS db_defs(
      file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
      tbl TEXT, op TEXT, line INTEGER, changeset TEXT);
    CREATE TABLE IF NOT EXISTS db_access(
      file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
      tbl TEXT, kind TEXT, mode TEXT, line INTEGER, detail TEXT);
    CREATE INDEX IF NOT EXISTS idx_dbdefs_tbl ON db_defs(tbl);
    CREATE INDEX IF NOT EXISTS idx_dbaccess_tbl ON db_access(tbl);
    CREATE TABLE IF NOT EXISTS http_endpoints(
      file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
      method TEXT, path TEXT, norm TEXT, line INTEGER, detail TEXT);
    CREATE TABLE IF NOT EXISTS http_calls(
      file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
      method TEXT, path TEXT, norm TEXT, line INTEGER, client TEXT);
    CREATE INDEX IF NOT EXISTS idx_http_ep ON http_endpoints(norm);
    CREATE INDEX IF NOT EXISTS idx_http_call ON http_calls(norm);
    CREATE TABLE IF NOT EXISTS assertions(
      id INTEGER PRIMARY KEY, kind TEXT, payload TEXT, file_path TEXT, line INTEGER,
      evidence TEXT, confidence TEXT, author TEXT, source_hash TEXT, created_at REAL);
    CREATE TABLE IF NOT EXISTS decisions(
      id TEXT PRIMARY KEY, title TEXT, status TEXT, decided_at TEXT,
      valid_until TEXT, superseded_by TEXT, source_path TEXT, summary TEXT);
    CREATE TABLE IF NOT EXISTS decision_links(
      decision_id TEXT, kind TEXT, target TEXT);
    CREATE INDEX IF NOT EXISTS idx_dlinks ON decision_links(target);
    CREATE TABLE IF NOT EXISTS extract_cache(
      path TEXT PRIMARY KEY, hash TEXT, constants TEXT, entities TEXT);
    CREATE TABLE IF NOT EXISTS test_cases(
      id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name TEXT NOT NULL, line INTEGER);
    CREATE TABLE IF NOT EXISTS edges(
      src INTEGER REFERENCES files(id) ON DELETE CASCADE,
      dst INTEGER REFERENCES files(id) ON DELETE CASCADE,
      kind TEXT DEFAULT 'import', UNIQUE(src, dst, kind));
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
      path, start_line UNINDEXED, content, tokenize='trigram');
  `);
  try { db.exec("ALTER TABLE symbols ADD COLUMN parent TEXT"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE files ADD COLUMN size INTEGER"); } catch { /* exists */ }
  // provenance: 'static' (parsed) vs 'asserted:<author>' (derived by an assistant).
  // These are NEVER silently mixed, every tool that reads them reports which is which.
  for (const t of ["msg_edges", "db_access", "http_endpoints", "http_calls"]) {
    try { db.exec(`ALTER TABLE ${t} ADD COLUMN source TEXT DEFAULT 'static'`); } catch { /* exists */ }
  }
  try { db.exec("ALTER TABLE files ADD COLUMN mtime REAL"); } catch { /* exists */ }
  // `source` answers WHO derived a fact (parser vs author); is_test answers WHERE
  // the code lives (production vs test). Orthogonal axes: a parsed edge in a test
  // file stays source='static'. Never write test provenance into `source`.
  let addedIsTest = false;
  try { db.exec("ALTER TABLE files ADD COLUMN is_test INTEGER DEFAULT 0"); addedIsTest = true; } catch { /* exists */ }
  if (addedIsTest) {
    // one-time in-process backfill (SQLite has no regex); new rows classify on insert
    const upd = db.prepare("UPDATE files SET is_test=1 WHERE id=?");
    for (const r of db.prepare("SELECT id, path FROM files").all()) if (isTestPath(r.path)) upd.run(r.id);
  }
  const v = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (v && Number(v.value) > SCHEMA_VERSION) {
    throw new Error(`Index schema v${v.value} is newer than this indexer (v${SCHEMA_VERSION}). Update the toolkit.`);
  }
  db.prepare("INSERT OR REPLACE INTO meta VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
  return db;
}

function repoFiles() {
  const out = [];
  for (const root of ROOTS) {
    const prefix = prefixOf(root);
    for (const line of git(["ls-files"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).split("\n")) {
      if (!line) continue;
      const parts = line.split("/");
      if (parts.some((p) => config.skipDirs.includes(p))) continue;
      if (LANG_BY_EXT[path.extname(line).toLowerCase()]) out.push(prefix ? `${prefix}/${line}` : line);
    }
  }
  return out;
}

async function indexFile(db, relpath, force = false) {
  const full = absPath(relpath);
  let text;
  let st;
  try {
    st = fs.statSync(full);
    if (st.size > config.maxFileBytes) { log("DEBUG", `skip large: ${relpath}`); return null; }
    const prev = db.prepare("SELECT hash, size, mtime FROM files WHERE path=?").get(relpath);
    // fast path 1: identical stat -> already indexed, nothing to do (PDFs seen once stay seen)
    if (!force && prev && prev.size === st.size && prev.mtime === st.mtimeMs) return "unchanged";
    // checksum of RAW BYTES, computed before any extraction: a touched-but-identical
    // file (incl. PDFs) is detected here without paying extraction cost
    const buf = fs.readFileSync(full);
    var hash = createHash("sha1").update(buf).digest("hex");
    if (!force && prev && prev.hash === hash) {
      db.prepare("UPDATE files SET size=?, mtime=? WHERE path=?").run(st.size, st.mtimeMs, relpath);
      return "unchanged";
    }
    if (relpath.toLowerCase().endsWith(".pdf")) {
      try {
        const { extractText } = await import("unpdf");
        const r = await extractText(new Uint8Array(buf), { mergePages: true });
        text = typeof r.text === "string" ? r.text : r.text.join("\n");
        if (!text?.trim()) return null;
      } catch (e) { log("DEBUG", `pdf skip ${relpath}: ${e.message}`); return null; }
    } else {
      text = buf.toString("utf8");
    }
  } catch (e) { log("DEBUG", `skip unreadable: ${relpath} (${e.code ?? e.message})`); return null; }
  const lang = LANG_BY_EXT[path.extname(full).toLowerCase()] ?? "other";
  const isTest = isTestPath(relpath) ? 1 : 0;

  db.prepare("DELETE FROM chunks WHERE path=?").run(relpath);
  const old = db.prepare("SELECT id FROM files WHERE path=?").get(relpath);
  // Non-import edges (e.g. SCIP-derived 'ref') are owned by other passes; the
  // file-row swap below cascade-deletes them, so carry them over to the new id.
  const keptEdges = old
    ? db.prepare("SELECT src, dst, kind FROM edges WHERE (src=? OR dst=?) AND kind != 'import'").all(old.id, old.id)
    : [];
  db.prepare("DELETE FROM files WHERE path=?").run(relpath);
  const fid = db.prepare(
    "INSERT INTO files(path, lang, hash, lines, indexed_at, size, mtime, is_test) VALUES(?,?,?,?,?,?,?,?)"
).run(relpath, lang, hash, text.split("\n").length, Date.now() / 1000, st.size, st.mtimeMs, isTest).lastInsertRowid;
  const insKept = db.prepare("INSERT OR IGNORE INTO edges(src, dst, kind) VALUES(?,?,?)");
  for (const e of keptEdges) insKept.run(e.src === old.id ? fid : e.src, e.dst === old.id ? fid : e.dst, e.kind);

  const insSym = db.prepare("INSERT INTO symbols(file_id, name, kind, line, signature, parent) VALUES(?,?,?,?,?,?)");
  const insCall = db.prepare("INSERT INTO calls(src_symbol, callee, line) VALUES(?,?,?)");
  const ext = path.extname(full).toLowerCase();
  let ast = null;
  if (AST_LANGS.has(lang)) {
    if (!astReady) { await initAst(log); astReady = true; }  // lazy: only when a code file actually changed
    try { ast = await extractAst(lang, ext, text); } catch (e) { log("DEBUG", `AST failed for ${relpath}: ${e.message}`); }
  }
  if (ast) {
    const idByName = new Map();
    for (const s of ast.symbols) {
      const r = insSym.run(fid, s.name, s.kind, s.line, s.sig ?? "", s.parent ?? null);
      if (!idByName.has(s.name)) idByName.set(s.name, r.lastInsertRowid);
    }
    for (const c of ast.calls) {
      const src = c.caller ? idByName.get(c.caller) : null;
      if (src) insCall.run(src, c.callee, c.line);
    }
  } else {
    for (const s of extractSymbols(lang, text)) insSym.run(fid, s.name, s.kind, s.line, s.sig, null);
  }

  if (isTest) {
    // behaviors, not helpers: annotation-gated for JUnit, so a @KafkaListener
    // method inside a test class never lands here
    const insTc = db.prepare("INSERT INTO test_cases(file_id, name, line) VALUES(?,?,?)");
    const tcRe = lang === "java" || lang === "kotlin"
      ? /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b[\s\S]{0,300}?(?:void|fun)\s+(\w+)\s*\(/g
      : lang === "typescript" || lang === "javascript"
        ? /\b(?:it|test)(?:\.each\([^)]*\))?\s*\(\s*[`'"]([^`'"]{1,200})[`'"]/g
        : lang === "python" ? /^\s*def\s+(test_\w+)\s*\(/gm : null;
    if (tcRe) for (const m of text.matchAll(tcRe)) insTc.run(fid, m[1], text.slice(0, m.index).split("\n").length);
  }

  const lines = text.split("\n");
  const insChunk = db.prepare("INSERT INTO chunks(path, start_line, content) VALUES(?,?,?)");
  for (let start = 0; start < lines.length; start += config.chunkLines) {
    const chunk = lines.slice(start, start + config.chunkLines).join("\n");
    if (chunk.trim()) insChunk.run(relpath, start + 1, chunk);
  }
  return { fid, lang, text, relpath };
}

function rebuildEdges(db, touched) {
  const allPaths = new Set(db.prepare("SELECT path FROM files").all().map((r) => r.path));
  const idByPath = new Map(db.prepare("SELECT id, path FROM files").all().map((r) => [r.path, r.id]));
  const del = db.prepare("DELETE FROM edges WHERE src=? AND kind='import'");
  const ins = db.prepare("INSERT OR IGNORE INTO edges(src, dst, kind) VALUES(?,?,'import')");
  for (const t of touched) {
    del.run(t.fid);
    for (const mod of extractImports(t.lang, t.text)) {
      const dst = resolveImport(mod, t.relpath, allPaths);
      if (dst && dst !== t.relpath && idByPath.has(dst)) ins.run(t.fid, idByPath.get(dst));
    }
  }
}

async function loadExtractors() {
  const dir = path.join(GR_DIR, "extensions");
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".extract.mjs"))) {
    try {
      const mod = await import("file://" + path.join(dir, f));
      if (mod.extractors) out.push({ name: f, x: mod.extractors });
    } catch (e) { log("WARN", `extractor ${f} failed to load: ${e.message}`); }
  }
  return out;
}

async function kafkaPass(db, scopePrefixes = null) {
  const EXTRACTORS = await loadExtractors();
  const runX = (hook, argsArr, insertFn) => {
    for (const { name, x } of EXTRACTORS) {
      if (typeof x[hook] !== "function") continue;
      try { for (const row of x[hook](...argsArr) ?? []) insertFn(row); }
      catch (e) { log("WARN", `extractor ${name}.${hook}: ${e.message}`); }
    }
  };
  const tracked = repoFiles();
  const configMap = loadConfigMap(REPO_ROOT, tracked, log);
  const idByPath = new Map(db.prepare("SELECT id, path, hash FROM files").all().map((r) => [r.path, r]));

  // ---- config fingerprint: any change to application*.yml|properties forces a full pass ----
  const cfgPaths = tracked.filter((p) => /(^|\/)(application|bootstrap)[^/]*\.(ya?ml|properties)$/.test(p)).sort();
  const cfgFp = createHash("sha1").update(cfgPaths.map((p) => p + ":" + (idByPath.get(p)?.hash ?? "")).join("|")).digest("hex");
  const prevFp = db.prepare("SELECT value FROM meta WHERE key='config_fp'").get()?.value;
  let mapsChanged = cfgFp !== prevFp;
  db.prepare("INSERT OR REPLACE INTO meta VALUES('config_fp', ?)").run(cfgFp);

  // ---- global maps (constants + entities) from per-file cache; recompute only on hash miss ----
  const javaish = tracked.filter((p) => /\.(java|kts?)$/.test(p));
  // Snapshot of what we last EXTRACTED, taken before the map loop updates it.
  // Files whose content hash has moved on since then are the ones needing re-extraction.
  // (Reindexing a file cascades its correlation rows away, so this set must be exact.)
  const extractedAt = new Map(db.prepare("SELECT path, hash FROM extract_cache").all().map((r) => [r.path, r.hash]));
  const getCache = db.prepare("SELECT hash, constants, entities FROM extract_cache WHERE path=?");
  const putCache = db.prepare("INSERT OR REPLACE INTO extract_cache(path, hash, constants, entities) VALUES(?,?,?,?)");
  const constants = new Map();
  const entityTables = new Map();
  const textMemo = new Map();
  const readText = (rel) => {
    if (!textMemo.has(rel)) {
      try { textMemo.set(rel, fs.readFileSync(absPath(rel), "utf8")); } catch { textMemo.set(rel, null); }
    }
    return textMemo.get(rel);
  };
  for (const rel of javaish) {
    const fh = idByPath.get(rel)?.hash;
    const c = getCache.get(rel);
    let consts, ents;
    if (c && fh && c.hash === fh) {
      consts = JSON.parse(c.constants); ents = JSON.parse(c.entities);
    } else {
      const text = readText(rel);
      if (text == null) continue;
      consts = Object.fromEntries(loadConstants([{ text }]));
      ents = Object.fromEntries(extractEntities(text));
      const cj = JSON.stringify(consts), ej = JSON.stringify(ents);
      // only a *semantic* delta forces the full pass; a mere hash change with
      // identical constants/entities keeps scoping intact
      if (!c || c.constants !== cj || c.entities !== ej) mapsChanged = true;
      putCache.run(rel, fh ?? "", cj, ej);
    }
    // test files are cached like any other (the semantic-delta trigger stays
    // byte-identical) but never merge into the global maps: a test constant or
    // @Entity must not shadow a prod mapping
    if (isTestPath(rel)) continue;
    for (const [k, v] of Object.entries(consts)) if (!constants.has(k)) constants.set(k, v);
    for (const [k, v] of Object.entries(ents)) entityTables.set(k, v);
  }
  db.prepare("DELETE FROM extract_cache WHERE path NOT IN (SELECT path FROM files)").run();
  for (const [k, v] of Object.entries(config.tableNameOverrides ?? {})) entityTables.set(k, String(v).toLowerCase());

  // ---- scope: re-extract only the FILES whose content actually changed ----
  // A global change (config value, topic constant, entity mapping) can alter how
  // every other file resolves, so that widens automatically to a full re-extract.
  const candidates = tracked.filter((p) => /\.(java|kts?|xml|ya?ml|sql|ts|tsx|js|jsx|mjs)$/.test(p));
  const dirty = new Set();
  if (mapsChanged) {
    for (const p of candidates) dirty.add(p);
  } else {
    for (const p of candidates) {
      const cur = idByPath.get(p)?.hash;
      const seen = extractedAt.get(p);
      if (!seen || seen !== cur) dirty.add(p);
    }
  }
  const inScope = (rel) => dirty.has(rel);
  const delRows = (table) => {
    if (mapsChanged) { db.exec(`DELETE FROM ${table}`); return; }
    const st = db.prepare(`DELETE FROM ${table} WHERE file_id IN (SELECT id FROM files WHERE path=?)`);
    for (const p of dirty) st.run(p);
  };
  const scopedDelete = delRows;
  // remember what we extracted, so an unchanged file is never re-read next time
  const markExtracted = db.prepare("INSERT OR REPLACE INTO extract_cache(path, hash, constants, entities) VALUES(?,?,COALESCE((SELECT constants FROM extract_cache WHERE path=?),'{}'),COALESCE((SELECT entities FROM extract_cache WHERE path=?),'{}'))");
  if (!mapsChanged && dirty.size < candidates.length) {
    log("INFO", `Extraction scoped to ${dirty.size}/${candidates.length} changed files`);
  }
  // a test file's own constants/entities overlay the global maps (own wins): a
  // test-local ORDERS_TOPIC resolves to the test's literal, never to the prod
  // mapping; anything the file doesn't define itself stays resolved=0
  const overlay = (globalMap, rel, col) => {
    if (!isTestPath(rel)) return globalMap;
    const own = getCache.get(rel);
    return new Map([...globalMap, ...Object.entries(JSON.parse(own?.[col] ?? "{}"))]);
  };

  // ---- Kafka ----
  scopedDelete("msg_edges");
  const ins = db.prepare("INSERT INTO msg_edges(file_id, topic, direction, line, resolved, via) VALUES(?,?,?,?,?,?)");
  let n = 0;
  for (const rel of javaish) {
    if (!inScope(rel)) continue;
    const text = readText(rel);
    const fid = idByPath.get(rel)?.id;
    if (!fid || text == null || !/Kafka|ProducerRecord|\.send\s*\(|subscribe/.test(text)) continue;
    for (const e of extractKafkaEdges(text, configMap, overlay(constants, rel, "constants"))) {
      ins.run(fid, e.topic, e.direction, e.line, e.resolved ? 1 : 0, e.via);
      n++;
    }
  }
  // plugin kafka extractors run over ALL in-scope java/kotlin files (not just built-in matches)
  for (const rel of javaish) {
    if (!inScope(rel)) continue;
    const text = readText(rel);
    const fid = idByPath.get(rel)?.id;
    if (!fid || text == null) continue;
    runX("kafka", [text, { configMap, constants, relpath: rel }],
      (e) => { ins.run(fid, e.topic, e.direction, e.line, e.resolved === false ? 0 : 1, e.via ?? null); n++; });
  }
  if (n) log("INFO", `Kafka: ${n} message edges`);

  // ---- DB definitions (changelogs) + access ----
  scopedDelete("db_defs"); scopedDelete("db_access");
  const insDef = db.prepare("INSERT INTO db_defs(file_id, tbl, op, line, changeset) VALUES(?,?,?,?,?)");
  const insAcc = db.prepare("INSERT INTO db_access(file_id, tbl, kind, mode, line, detail) VALUES(?,?,?,?,?,?)");
  let defs = 0, accs = 0;
  for (const rel of tracked) {
    if (!/\.(xml|ya?ml|sql)$/.test(rel) || !inScope(rel)) continue;
    const text = readText(rel);
    if (text == null || !isChangelog(rel, text)) continue;
    const fid = idByPath.get(rel)?.id;
    for (const d of extractChangelog(rel, text)) { insDef.run(fid ?? null, d.table, d.op, d.line, d.changeset); defs++; }
  }
  const delSynth = db.prepare("DELETE FROM symbols WHERE file_id=? AND signature LIKE '%Lombok-generated%'");
  const insSynth = db.prepare("INSERT INTO symbols(file_id, name, kind, line, signature, parent) VALUES(?,?,?,?,?,?)");
  let lombok = 0;
  for (const rel of javaish) {
    if (!inScope(rel)) continue;
    const text = readText(rel);
    const fid = idByPath.get(rel)?.id;
    if (!fid || text == null) continue;
    if (/@Entity|Repository|@Query|[Jj]dbc|Template|com\.querydsl|JPAQueryFactory/.test(text)) {
      for (const a of extractDbAccess(text, overlay(entityTables, rel, "entities"), overlay(constants, rel, "constants"))) { insAcc.run(fid, a.table, a.kind, a.mode, a.line, a.detail); accs++; }
    }
    if (/@(?:Data|Value|Getter|Setter|(?:Super)?Builder)\b/.test(text)) {
      delSynth.run(fid);
      for (const sy of extractLombokSymbols(text)) { insSynth.run(fid, sy.name, sy.kind, sy.line, sy.sig, sy.parent); lombok++; }
    }
    runX("dbAccess", [text, { entityTables, constants, relpath: rel }],
      (r) => { insAcc.run(fid, r.table, r.kind ?? "sql", r.mode ?? "rw", r.line, r.detail ?? "extension"); accs++; });
  }
  if (defs || accs) log("INFO", `DB: ${defs} schema ops (Liquibase), ${accs} access sites, ${entityTables.size} entities`);
  if (lombok) log("INFO", `Lombok: ${lombok} generated members synthesized`);

  // ---- HTTP seam ----
  scopedDelete("http_endpoints"); scopedDelete("http_calls");
  const insEp = db.prepare("INSERT INTO http_endpoints(file_id, method, path, norm, line, detail) VALUES(?,?,?,?,?,?)");
  const insCall = db.prepare("INSERT INTO http_calls(file_id, method, path, norm, line, client) VALUES(?,?,?,?,?,?)");
  let eps = 0, hcalls = 0;
  for (const rel of javaish) {
    if (!inScope(rel)) continue;
    const text = readText(rel);
    const fid = idByPath.get(rel)?.id;
    if (!fid || text == null || !/Mapping|RestTemplate|WebClient|FeignClient/.test(text)) continue;
    const r = extractJavaHttp(text);
    for (const e of r.endpoints) { insEp.run(fid, e.method, e.path, e.norm, e.line, e.detail); eps++; }
    for (const c of r.calls) { insCall.run(fid, c.method, c.path, c.norm, c.line, c.client); hcalls++; }
    runX("httpEndpoints", [text, { relpath: rel }],
      (e) => { insEp.run(fid, e.method, e.path, e.norm ?? e.path, e.line, e.detail ?? "extension"); eps++; });
    runX("httpCalls", [text, { relpath: rel }],
      (c) => { insCall.run(fid, c.method, c.path, c.norm ?? c.path, c.line, c.client ?? "extension"); hcalls++; });
  }
  for (const rel of tracked) {
    if (!/\.(ts|tsx|js|jsx|mjs)$/.test(rel) || !inScope(rel)) continue;
    const text = readText(rel);
    const fid = idByPath.get(rel)?.id;
    if (!fid || text == null) continue;
    if (!/fetch\s*\(|axios|\.(get|post|put|delete|patch)\s*(<[^>]*>)?\s*\(\s*[\x60"']/.test(text)) continue;
    for (const c of extractTsHttp(text)) { insCall.run(fid, c.method, c.path, c.norm, c.line, c.client); hcalls++; }
  }
  if (eps || hcalls) log("INFO", `HTTP: ${eps} endpoints, ${hcalls} client calls`);
  for (const p of dirty) {
    const h = idByPath.get(p)?.hash;
    if (h) markExtracted.run(p, h, p, p);
  }

  // ---- Assertions: facts an assistant derived where static analysis is blind ----
  // Source of truth is docs/graph-assertions.json, committed, reviewed in PRs, shared.
  // The index is derived from it, exactly like ADRs.
  {
    db.exec("DELETE FROM assertions");
    db.exec("DELETE FROM msg_edges WHERE source LIKE 'asserted%'");
    db.exec("DELETE FROM db_access WHERE source LIKE 'asserted%'");
    db.exec("DELETE FROM http_endpoints WHERE source LIKE 'asserted%'");
    db.exec("DELETE FROM http_calls WHERE source LIKE 'asserted%'");
    const af = path.join(REPO_ROOT, "docs", "graph-assertions.json");
    let list = [];
    try { list = JSON.parse(fs.readFileSync(af, "utf8")); } catch { /* none yet */ }
    if (Array.isArray(list) && list.length) {
      const insA = db.prepare(`INSERT INTO assertions(kind, payload, file_path, line, evidence, confidence, author, source_hash, created_at)
                               VALUES(?,?,?,?,?,?,?,?,?)`);
      const fid = db.prepare("SELECT id, hash FROM files WHERE path=?");
      let loaded = 0, stale = 0;
      for (const a of list) {
        const f = fid.get(a.file);
        const src = `asserted:${a.author ?? "assistant"}`;
        insA.run(a.kind, JSON.stringify(a), a.file ?? null, a.line ?? null, a.evidence ?? null,
                 a.confidence ?? "medium", a.author ?? "assistant", a.source_hash ?? null, Date.now() / 1000);
        if (a.source_hash && f && f.hash !== a.source_hash) stale++;
        if (!f) continue;
        if (a.kind === "kafka" && a.topic && a.direction) {
          db.prepare("INSERT INTO msg_edges(file_id, topic, direction, line, resolved, via, source) VALUES(?,?,?,?,1,?,?)")
            .run(f.id, a.topic, a.direction, a.line ?? 0, "assertion", src);
        } else if (a.kind === "db" && a.table) {
          db.prepare("INSERT INTO db_access(file_id, tbl, kind, mode, line, detail, source) VALUES(?,?,?,?,?,?,?)")
            .run(f.id, a.table, "sql", a.mode ?? "rw", a.line ?? 0, "assertion", src);
        } else if (a.kind === "http_endpoint" && a.path) {
          db.prepare("INSERT INTO http_endpoints(file_id, method, path, norm, line, detail, source) VALUES(?,?,?,?,?,?,?)")
            .run(f.id, a.method ?? "GET", a.path, normalizeAssertedPath(a.path), a.line ?? 0, "assertion", src);
        } else if (a.kind === "http_call" && a.path) {
          db.prepare("INSERT INTO http_calls(file_id, method, path, norm, line, client, source) VALUES(?,?,?,?,?,?,?)")
            .run(f.id, a.method ?? "GET", a.path, normalizeAssertedPath(a.path), a.line ?? 0, "assertion", src);
        }
        loaded++;
      }
      log("INFO", `Assertions: ${loaded} loaded into the graph${stale ? `, ${stale} STALE (evidence file changed since)` : ""}`);
    }
  }

  // ---- Mnemosyne: decision memory from ADR files (temporal, deterministic) ----
  {
    db.exec("DELETE FROM decisions; DELETE FROM decision_links;");
    const insD = db.prepare(`INSERT OR REPLACE INTO decisions(id, title, status, decided_at, valid_until, superseded_by, source_path, summary) VALUES(?,?,?,?,?,?,?,?)`);
    const insL = db.prepare("INSERT INTO decision_links(decision_id, kind, target) VALUES(?,?,?)");
    const topics = new Set(db.prepare("SELECT DISTINCT topic FROM msg_edges").all().map((r) => r.topic));
    const tables = new Set(db.prepare("SELECT DISTINCT tbl FROM db_defs UNION SELECT DISTINCT tbl FROM db_access").all().map((r) => r.tbl ?? r[0]));
    const modules = new Set(tracked.map((p) => p.split("/")[0]));
    const recs = [];
    for (const rel of tracked) {
      if (!/(^|\/)adr\/.*\.md$/i.test(rel) && !/ADR-[\w-]+\.md$/i.test(rel)) continue;
      const text = readText(rel);
      if (text == null) continue;
      const idm = rel.match(/(ADR-[\w.]+?)(?:[-_][\w-]*)?\.md$/i) ?? text.match(/#\s*(ADR-[\w.]+)/i);
      if (!idm) continue;
      const id = idm[1].toUpperCase();
      const title = (text.match(/^#\s*ADR-[\w.]+\s*[:, -]\s*(.+)$/im)?.[1]
        ?? text.match(/^#\s*(.+)$/m)?.[1] ?? id).trim();
      const status = (text.match(/^\s*Status\s*:\s*(\w+)/im)?.[1] ?? "accepted").toLowerCase();
      let decided = text.match(/^\s*Date\s*:\s*([\d]{4}-[\d]{2}-[\d]{2})/im)?.[1];
      if (!decided) { try { decided = new Date(fs.statSync(absPath(rel)).mtimeMs).toISOString().slice(0, 10); } catch { decided = null; } }
      const supersedes = text.match(/Supersedes\s*:?\s*(ADR-[\w.]+)/i)?.[1]?.toUpperCase() ?? null;
      const summary = (text.match(/^\s*(?:##\s*)?Decision\s*:?\s*\n+([\s\S]{0,400}?)(?:\n#|\n\n#|$)/im)?.[1]
        ?? text.split("\n").slice(1, 5).join(" ")).replace(/\s+/g, " ").trim().slice(0, 400);
      const links = [];
      for (const t of topics) if (t && text.includes(t)) links.push(["topic", t]);
      for (const t of tables) if (t && new RegExp(`\\b${t}\\b`, "i").test(text)) links.push(["table", t]);
      for (const m of modules) if (m && text.includes(m)) links.push(["module", m]);
      recs.push({ id, title, status, decided, supersedes, rel, summary, links });
    }
    // supersession chain -> temporal validity
    const byId = new Map(recs.map((r) => [r.id, r]));
    for (const r of recs) {
      if (r.supersedes && byId.has(r.supersedes)) {
        const old = byId.get(r.supersedes);
        old.valid_until = r.decided;
        old.superseded_by = r.id;
        if (old.status === "accepted") old.status = "superseded";
      }
    }
    for (const r of recs) {
      insD.run(r.id, r.title, r.status, r.decided, r.valid_until ?? null, r.superseded_by ?? null, r.rel, r.summary);
      for (const [k, t] of r.links) insL.run(r.id, k, t);
    }
    if (recs.length) log("INFO", `Mnemosyne: ${recs.length} decisions (${recs.filter((r) => !r.valid_until).length} active)`);
  }

  // ---- plugin passes: .ariadne/extensions/*.pass.mjs export run(ctx) ----
  return runExtensionPasses(db, { tracked, readText, idByPath, inScope, log });
}

async function runExtensionPasses(db, ctx) {
  const dir = path.join(GR_DIR, "extensions");
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".pass.mjs"))) {
    try {
      const mod = await import("file://" + path.join(dir, f));
      if (typeof mod.run === "function") { await mod.run({ db, ...ctx }); log("INFO", `extension pass: ${f}`); }
    } catch (e) { log("WARN", `extension ${f} failed: ${e.message}`); }
  }
}

function stamp(db) {
  for (const root of ROOTS) {
    db.prepare("INSERT OR REPLACE INTO meta VALUES(?, ?)").run(
      `last_sha:${prefixOf(root) || "."}`, git(["rev-parse", "HEAD"], { cwd: root }));
  }
  db.prepare("INSERT OR REPLACE INTO meta VALUES('last_sha', ?)").run(git(["rev-parse", "HEAD"], { cwd: ROOTS[0] }));
  db.prepare("INSERT OR REPLACE INTO meta VALUES('last_run', ?)").run(String(Date.now() / 1000));
}

/** Run body inside a single write transaction. Without this, better-sqlite3
 *  auto-commits every INSERT, an fsync per row, which dominates large indexes. */
async function inTx(db, body) {
  db.exec("BEGIN");
  try { const r = await body(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch { /* already unwound */ } throw e; }
}

async function fullIndex(db, rebuild = false) {
  const t0 = Date.now();
  const files = repoFiles();
  return inTx(db, async () => {
  if (rebuild) {
    // Deleting files cascade-wipes every correlation row, so the extraction cache
    // MUST go too, otherwise the passes compare hashes, conclude "nothing changed",
    // and rebuild into an empty graph.
    db.exec("DELETE FROM files; DELETE FROM chunks;");
    try { db.exec("DELETE FROM extract_cache"); db.exec("DELETE FROM meta WHERE key='config_fp'"); } catch { /* fresh db */ }
  }
  const tracked = new Set(files);
  // prune files no longer tracked
  let removed = 0;
  for (const { path: p } of db.prepare("SELECT path FROM files").all()) {
    if (!tracked.has(p)) {
      db.prepare("DELETE FROM files WHERE path=?").run(p);
      db.prepare("DELETE FROM chunks WHERE path=?").run(p);
      removed++;
    }
  }
  const touched = [];
  let skipped = 0;
  for (const rel of files) {
    const r = await indexFile(db, rel, rebuild);
    if (r === "unchanged") skipped++;
    else if (r) touched.push(r);
  }
  rebuildEdges(db, touched);
  await kafkaPass(db, null);
  stamp(db);
  log("INFO", `Full index: ${touched.length} (re)indexed, ${skipped} unchanged (cached), ${removed} removed of ${files.length} tracked in ${Date.now() - t0}ms`);
  });
}

async function incrementalIndex(db) {
  const changed = [], deleted = [];
  for (const root of ROOTS) {
    const p = prefixOf(root);
    const row = db.prepare("SELECT value FROM meta WHERE key=?").get(`last_sha:${p || "."}`)
      ?? db.prepare("SELECT value FROM meta WHERE key='last_sha'").get();
    if (!row?.value) return fullIndex(db);
    let diff;
    try {
      diff = execFileSync("git", ["diff", "--name-status", row.value, "HEAD"],
        { encoding: "utf8", cwd: root, timeout: 30_000 });
    } catch { log("WARN", `Stamped SHA unreachable in ${p || "repo"}; doing full index`); return fullIndex(db); }
    for (const line of diff.split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      const status = parts[0];
      const pref = (x) => (p ? `${p}/${x}` : x);
      if (status.startsWith("R") && parts.length === 3) { deleted.push(pref(parts[1])); changed.push(pref(parts[2])); }
      else if (status === "D") deleted.push(pref(parts[1]));
      else changed.push(pref(parts[parts.length - 1]));
    }
  }
  const relevant = changed.filter((p) => LANG_BY_EXT[path.extname(p).toLowerCase()]
    && !p.split("/").some((s) => config.skipDirs.includes(s)));
  const total = db.prepare("SELECT COUNT(*) c FROM files").get().c || 1;
  if (relevant.length > Math.max(50, 0.4 * total)) { log("INFO", "Diff too large; full reindex"); return fullIndex(db); }

  return inTx(db, async () => {
  for (const p of deleted) {
    db.prepare("DELETE FROM files WHERE path=?").run(p);
    db.prepare("DELETE FROM chunks WHERE path=?").run(p);
  }
  const touched = [];
  for (const p of relevant) { const r = await indexFile(db, p); if (r) touched.push(r); }
  rebuildEdges(db, touched);
  await kafkaPass(db, null);
  stamp(db);
  log("INFO", `Incremental index: ${relevant.length} changed, ${deleted.length} deleted`);
  });
}

function status(db) {
  const q = (sql) => db.prepare(sql).get();
  const sha = db.prepare("SELECT value FROM meta WHERE key='last_sha'").get()?.value ?? "-";
  console.log(`files=${q("SELECT COUNT(*) c FROM files").c} symbols=${q("SELECT COUNT(*) c FROM symbols").c} ` +
    `edges=${q("SELECT COUNT(*) c FROM edges").c} last_sha=${sha.slice(0, 12)} db=${DB_PATH}`);
}

// -------------------------------------------------------------------- main
if (MULTI) log("INFO", `Workspace mode: ${ROOTS.length} repos: ${ROOTS.map(r=>path.basename(r)).join(", ")}`);
const mode = process.argv[2] ?? "--status";
if (mode === "--status") {
  status(connect());
} else if (mode === "--full" || mode === "--incremental" || mode === "--rebuild") {
  if (!acquireLock()) { log("INFO", "Another indexer run is in progress; exiting cleanly."); process.exit(0); }
  try {
    const db = connect();
    mode === "--incremental" ? await incrementalIndex(db) : await fullIndex(db, mode === "--rebuild");
  } catch (e) {
    log("ERROR", e.stack ?? String(e));
    process.exitCode = 1;
  } finally {
    releaseLock();
  }
} else {
  console.log("Usage: node indexer.mjs --full | --incremental | --rebuild | --status");
  process.exitCode = 2;
}
