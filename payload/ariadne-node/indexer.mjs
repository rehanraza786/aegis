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
import { loadConfigMap, loadConstants, extractKafkaEdges, extractBrokerEdges } from "./kafka.mjs";
import { isChangelog, extractChangelog, isSchemaFile, extractSchemaDefs, extractEntities, extractDbAccess, extractGenericDbAccess, extractLombokSymbols } from "./db.mjs";
import { extractJavaHttp, extractTsHttp, extractTsEndpoints, extractPyHttp, normalizePath as normalizeAssertedPath } from "./http.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { approvedFiles, approveAll, LOCK_NAME } from "./trust.mjs";
import path from "node:path";
import process from "node:process";

const SCHEMA_VERSION = 6;
// set by connect() when a pre-v6 chunks table was migrated: the FTS index is
// derived data, so the migration IS a forced full rebuild (see main).
let CHUNKS_MIGRATED = false;

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
  workers: null, // parallel extract: null = auto (cores-1, capped 8); 1 = sequential
};
let config = DEFAULTS;
try {
  const userCfg = JSON.parse(fs.readFileSync(path.join(GR_DIR, "config.json"), "utf8"));
  config = { ...DEFAULTS, ...userCfg, skipDirs: [...new Set([...DEFAULTS.skipDirs, ...(userCfg.skipDirs ?? [])])] };
  if (isMainThread) log("INFO", "Loaded .ariadne/config.json overrides");
} catch { /* no config file: defaults */ }

const LANG_BY_EXT = {
  ".py": "python", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".java": "java", ".cs": "csharp",
  ".go": "go", ".rs": "rust", ".rb": "ruby", ".php": "php", ".c": "c", ".h": "c",
  ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp", ".kt": "kotlin", ".kts": "kotlin", ".gradle": "config", ".swift": "swift",
  ".scala": "scala", ".sql": "sql", ".sh": "shell", ".yaml": "config", ".yml": "config", ".properties": "config",
  ".toml": "config", ".json": "config", ".xml": "config", ".prisma": "config", ".md": "docs", ".pdf": "docs", ...config.extraExtensions,
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

/** O(n) newline scan once, then O(log n) per lookup. The old shape —
 *  text.slice(0, idx).split("\n") per match — re-scanned the whole prefix for
 *  every match, O(text × matches) on big files. Parity: line_at (Python). */
function makeLineAt(text) {
  let offs = null;
  return (idx) => {
    if (!offs) {
      offs = [];
      for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) offs.push(i);
    }
    let lo = 0, hi = offs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offs[mid] < idx) lo = mid + 1; else hi = mid;
    }
    return lo + 1; // newlines strictly before idx, + 1
  };
}

function extractSymbols(lang, text) {
  const out = [];
  const lineAt = makeLineAt(text);
  for (const [pattern, kind] of SYMBOL_PATTERNS[lang] ?? []) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      out.push({ name: m.groups.name, kind, line: lineAt(m.index), sig: (m.groups.sig ?? "").slice(0, 200) });
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

/** Precomputed index for resolveImport: built ONCE per edge rebuild instead of
 *  scanning every path per import (the old O(imports × paths) hot spot). For a
 *  stem a/b/c it registers every segment-boundary suffix (c, b/c, a/b/c); the
 *  first path in iteration order claims a suffix, preserving first-match
 *  semantics. Boundary-only matching also stops the old false edges where
 *  tail "foo/bar" matched mid-segment inside "xfoo/bar". Parity: build_import_index. */
function buildImportIndex(allPaths) {
  const bySuffix = new Map();
  for (const p of allPaths) {
    const segs = p.replace(/\.[^.]+$/, "").split("/");
    let suf = "";
    for (let i = segs.length - 1; i >= 0; i--) {
      suf = suf ? `${segs[i]}/${suf}` : segs[i];
      if (!bySuffix.has(suf)) bySuffix.set(suf, p);
    }
  }
  return { paths: allPaths, bySuffix };
}

function resolveImport(mod, srcPath, index) {
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
        if (index.paths.has(rel)) return rel;
      }
    }
    return null;
  }
  let m = mod;
  for (const prefix of config.aliasPrefixes) if (m.startsWith(prefix)) m = m.slice(prefix.length);
  const tail = m.replaceAll(".", "/").replaceAll("::", "/").replaceAll("\\", "/");
  return (tail && index.bySuffix.get(tail)) || null;
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
function connect(forIndexing = false) {
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
    -- topics DECLARED in application config: the seam's source of truth, so the
    -- graph can validate code against it (declared-but-unused, hardcoded-literal)
    CREATE TABLE IF NOT EXISTS msg_topics(
      file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
      topic TEXT, config_key TEXT, line INTEGER);
    CREATE INDEX IF NOT EXISTS idx_msgtopics_topic ON msg_topics(topic);
    CREATE INDEX IF NOT EXISTS idx_msgtopics_file ON msg_topics(file_id);
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
    -- FK indexes: every child table is cascade-deleted per changed file on every
    -- reindex; without these each DELETE FROM files full-scans each child table,
    -- making incremental reindex quadratic in changed files. edges(dst) also
    -- carries blast_radius/hotspots/imported_by, which BFS over reverse deps.
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
    CREATE INDEX IF NOT EXISTS idx_calls_src ON calls(src_symbol);
    CREATE INDEX IF NOT EXISTS idx_msg_file ON msg_edges(file_id);
    CREATE INDEX IF NOT EXISTS idx_dbdefs_file ON db_defs(file_id);
    CREATE INDEX IF NOT EXISTS idx_dbaccess_file ON db_access(file_id);
    CREATE INDEX IF NOT EXISTS idx_httpep_file ON http_endpoints(file_id);
    CREATE INDEX IF NOT EXISTS idx_httpcall_file ON http_calls(file_id);
    CREATE INDEX IF NOT EXISTS idx_testcases_file ON test_cases(file_id);
    CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
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
  // ---- schema v6: FTS moves to external content. chunk_text holds the corpus
  // ONCE; the chunks FTS table keeps only the trigram index and reads row
  // content through content= on demand (snippet()/rank keep working) — roughly
  // halving index.db. Per-file chunk deletes become a plain B-tree DELETE on
  // chunk_text (the triggers emit the FTS 'delete' ops). The old contentful
  // table is detected by its DDL, migrated only when actually INDEXING (a
  // status open of a pre-v6 DB must not wipe the search index), and the
  // migration forces a one-time full rebuild: chunks are derived data, so the
  // rebuild IS the migration. Parity: SCHEMA/CHUNK_SCHEMA (Python edition).
  const chunksSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks'").get()?.sql ?? "";
  const oldChunks = !!chunksSql && !chunksSql.includes("content='chunk_text'");
  if (oldChunks && !forIndexing) return db; // read-side open of a pre-v6 DB: leave shapes and version alone
  if (oldChunks) {
    db.exec("DROP TABLE chunks;");
    CHUNKS_MIGRATED = true;
    log("INFO", `Index schema v${v?.value ?? "?"} -> v${SCHEMA_VERSION}: chunks move to FTS external content; one-time full rebuild`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_text(
      id INTEGER PRIMARY KEY, path TEXT, start_line INTEGER, content TEXT);
    CREATE INDEX IF NOT EXISTS idx_chunktext_path ON chunk_text(path);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
      path, start_line UNINDEXED, content, tokenize='trigram',
      content='chunk_text', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS chunk_text_ai AFTER INSERT ON chunk_text BEGIN
      INSERT INTO chunks(rowid, path, start_line, content) VALUES (new.id, new.path, new.start_line, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS chunk_text_ad AFTER DELETE ON chunk_text BEGIN
      INSERT INTO chunks(chunks, rowid, path, start_line, content) VALUES('delete', old.id, old.path, old.start_line, old.content);
    END;
  `);
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

// Prepared statements at connection lifetime. indexFile used to db.prepare()
// ~10 statements per FILE — a SQL compile each, dominating small-file cost.
const STMT_CACHE = new WeakMap();
function stmts(db) {
  let s = STMT_CACHE.get(db);
  if (!s) {
    s = {
      selPrev: db.prepare("SELECT hash, size, mtime FROM files WHERE path=?"),
      updStat: db.prepare("UPDATE files SET size=?, mtime=? WHERE path=?"),
      // v6 external content: deletes ride a plain B-tree index on chunk_text
      // (exact by construction — no LIKE, no wildcard hazard); the AFTER DELETE
      // trigger emits the matching FTS 'delete' ops. This replaces the v5
      // trigram-LIKE fast path, which existed because FTS5 could not index a
      // plain WHERE path=? on a contentful table.
      delChunksByPath: db.prepare("DELETE FROM chunk_text WHERE path=?"),
      selOldId: db.prepare("SELECT id FROM files WHERE path=?"),
      // Carry ALL edge kinds across the file-row swap. Outgoing import edges
      // are cleared and rebuilt from fresh imports by rebuildEdges right after;
      // INCOMING import edges (their src file unchanged, so still valid) have
      // no other owner — the old `kind != 'import'` filter dropped them, so
      // every incremental quietly thinned reverse dependencies (blast_radius,
      // context_pack's tests, hotspots) for any file that got reindexed.
      selKeptEdges: db.prepare("SELECT src, dst, kind FROM edges WHERE src=? OR dst=?"),
      delFileByPath: db.prepare("DELETE FROM files WHERE path=?"),
      insFile: db.prepare("INSERT INTO files(path, lang, hash, lines, indexed_at, size, mtime, is_test) VALUES(?,?,?,?,?,?,?,?)"),
      insEdge: db.prepare("INSERT OR IGNORE INTO edges(src, dst, kind) VALUES(?,?,?)"),
      insSym: db.prepare("INSERT INTO symbols(file_id, name, kind, line, signature, parent) VALUES(?,?,?,?,?,?)"),
      insCall: db.prepare("INSERT INTO calls(src_symbol, callee, line) VALUES(?,?,?)"),
      insTc: db.prepare("INSERT INTO test_cases(file_id, name, line) VALUES(?,?,?)"),
      insChunk: db.prepare("INSERT INTO chunk_text(path, start_line, content) VALUES(?,?,?)"),
    };
    STMT_CACHE.set(db, s);
  }
  return s;
}

// ------------------------------------------------------------- file pipeline
// Split on the single-writer boundary: computeFile does I/O + hash + parse +
// extract with NO database access (so it can run in worker threads), and
// applyFile owns every write. The sequential path and the worker pool share
// computeFile, so parallel mode cannot drift from sequential mode.
async function computeFile(relpath, prev, force = false) {
  const full = absPath(relpath);
  let text;
  let st;
  let hash;
  try {
    st = fs.statSync(full);
    if (st.size > config.maxFileBytes) { log("DEBUG", `skip large: ${relpath}`); return null; }
    // fast path 1: identical stat -> already indexed, nothing to do (PDFs seen once stay seen)
    if (!force && prev && prev.size === st.size && prev.mtime === st.mtimeMs) return { relpath, status: "unchanged" };
    // checksum of RAW BYTES, computed before any extraction: a touched-but-identical
    // file (incl. PDFs) is detected here without paying extraction cost
    const buf = fs.readFileSync(full);
    hash = createHash("sha1").update(buf).digest("hex");
    if (!force && prev && prev.hash === hash) return { relpath, status: "statOnly", size: st.size, mtime: st.mtimeMs };
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
  const lines = text.split("\n"); // split once; reused for the line count and chunking

  const ext = path.extname(full).toLowerCase();
  let ast = null;
  if (AST_LANGS.has(lang)) {
    if (!astReady) { await initAst(log); astReady = true; }  // lazy: only when a code file actually changed (per thread)
    try { ast = await extractAst(lang, ext, text); } catch (e) { log("DEBUG", `AST failed for ${relpath}: ${e.message}`); }
  }
  let symbols;
  let calls = [];
  if (ast) {
    symbols = ast.symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.line, sig: s.sig ?? "", parent: s.parent ?? null }));
    calls = ast.calls.map((c) => ({ caller: c.caller ?? null, callee: c.callee, line: c.line }));
  } else {
    symbols = extractSymbols(lang, text).map((s) => ({ name: s.name, kind: s.kind, line: s.line, sig: s.sig, parent: null }));
  }

  const testCases = [];
  if (isTest) {
    // behaviors, not helpers: annotation-gated for JUnit, so a @KafkaListener
    // method inside a test class never lands here
    const tcRe = lang === "java" || lang === "kotlin"
      ? /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b[\s\S]{0,300}?(?:void|fun)\s+(\w+)\s*\(/g
      : lang === "typescript" || lang === "javascript"
        ? /\b(?:it|test)(?:\.each\([^)]*\))?\s*\(\s*[`'"]([^`'"]{1,200})[`'"]/g
        : lang === "python" ? /^\s*def\s+(test_\w+)\s*\(/gm : null;
    if (tcRe) {
      const lineAt = makeLineAt(text);
      for (const m of text.matchAll(tcRe)) testCases.push({ name: m[1], line: lineAt(m.index) });
    }
  }

  const chunks = [];
  for (let start = 0; start < lines.length; start += config.chunkLines) {
    const chunk = lines.slice(start, start + config.chunkLines).join("\n");
    if (chunk.trim()) chunks.push({ start: start + 1, content: chunk });
  }
  return { relpath, status: "indexed", hash, size: st.size, mtime: st.mtimeMs, lang, isTest,
    lineCount: lines.length, symbols, calls, testCases, chunks, imports: [...extractImports(lang, text)] };
}

function applyFile(db, r) {
  const S = stmts(db);
  if (r.status === "statOnly") { S.updStat.run(r.size, r.mtime, r.relpath); return null; }
  S.delChunksByPath.run(r.relpath);
  const old = S.selOldId.get(r.relpath);
  // The file-row swap below cascade-deletes every edge touching the old id;
  // carry them ALL to the new id (see selKeptEdges for why import edges too).
  const keptEdges = old ? S.selKeptEdges.all(old.id, old.id) : [];
  S.delFileByPath.run(r.relpath);
  const fid = S.insFile.run(r.relpath, r.lang, r.hash, r.lineCount, Date.now() / 1000, r.size, r.mtime, r.isTest).lastInsertRowid;
  for (const e of keptEdges) S.insEdge.run(e.src === old.id ? fid : e.src, e.dst === old.id ? fid : e.dst, e.kind);
  const idByName = new Map();
  for (const s of r.symbols) {
    const res = S.insSym.run(fid, s.name, s.kind, s.line, s.sig, s.parent);
    if (!idByName.has(s.name)) idByName.set(s.name, res.lastInsertRowid);
  }
  for (const c of r.calls) {
    const src = c.caller ? idByName.get(c.caller) : null;
    if (src) S.insCall.run(src, c.callee, c.line);
  }
  for (const t of r.testCases) S.insTc.run(fid, t.name, t.line);
  for (const ch of r.chunks) S.insChunk.run(r.relpath, ch.start, ch.content);
  return { fid, relpath: r.relpath, imports: r.imports };
}

const WORKERS_FLAG = (() => {
  const i = process.argv.indexOf("--workers");
  return i > -1 ? Math.max(1, Number(process.argv[i + 1]) || 1) : null;
})();

function decideWorkers(nFiles) {
  const explicit = WORKERS_FLAG ?? config.workers ?? null;
  const auto = Math.max(1, Math.min((os.availableParallelism?.() ?? os.cpus().length) - 1, 8));
  const n = explicit ?? auto;
  if (n <= 1) return 1;
  // pool startup (a WASM parser set per worker) beats its win on small batches;
  // an EXPLICIT --workers/config value engages regardless (the suite relies on it)
  if (explicit == null && nFiles < 100) return 1;
  return n;
}

/** Compute every file — in worker threads when it pays — and apply results on
 *  THIS thread in submission order: the single-writer rule and deterministic
 *  insertion order both survive parallelism. onApplied sees each computeFile
 *  result exactly once, in the order of `files`. A worker failure degrades to
 *  sequential for the unapplied remainder — correctness never depends on the
 *  pool. Parity: compute_and_apply (Python edition, ProcessPoolExecutor there
 *  because py-tree-sitter holds the GIL during parse). */
async function computeAndApply(db, files, force, onApplied) {
  const prev = new Map(db.prepare("SELECT path, hash, size, mtime FROM files").all().map((r) => [r.path, r]));
  const n = decideWorkers(files.length);
  if (n <= 1 || !files.length) {
    for (const rel of files) onApplied(await computeFile(rel, prev.get(rel) ?? null, force));
    return;
  }
  log("INFO", `Parallel extract: ${n} workers over ${files.length} files`);
  await new Promise((resolve, reject) => {
    const workers = [];
    const pending = new Map(); // result index -> rec, held until its turn
    let next = 0;              // next file to hand out
    let applied = 0;           // next result index to apply (in submission order)
    let dead = false;
    const finish = () => { for (const w of workers) w.terminate().catch?.(() => {}); };
    const drain = () => {
      try {
        while (pending.has(applied)) {
          const rec = pending.get(applied);
          pending.delete(applied);
          applied++;
          onApplied(rec);
        }
      } catch (e) { dead = true; finish(); reject(e); return; }
      if (applied >= files.length) { finish(); resolve(); }
    };
    const sequentialRemainder = async () => {
      try {
        for (; applied < files.length; applied++) {
          onApplied(await computeFile(files[applied], prev.get(files[applied]) ?? null, force));
        }
        resolve();
      } catch (e) { reject(e); }
    };
    const assign = (w) => {
      if (dead || next >= files.length) return;
      const i = next++;
      w.postMessage({ i, rel: files[i], prev: prev.get(files[i]) ?? null, force });
    };
    for (let k = 0; k < Math.min(n, files.length); k++) {
      const w = new Worker(new URL(import.meta.url), { workerData: { ariadneExtractWorker: true } });
      workers.push(w);
      w.on("message", (m) => { if (dead) return; pending.set(m.i, m.rec); assign(w); drain(); });
      w.on("error", (err) => {
        if (dead) return;
        dead = true;
        log("WARN", `parallel extract worker failed (${err.message}); finishing sequentially`);
        finish();
        pending.clear();
        sequentialRemainder();
      });
      assign(w);
    }
  });
}

function rebuildEdges(db, touched) {
  const rows = db.prepare("SELECT id, path FROM files").all();
  const allPaths = new Set(rows.map((r) => r.path));
  const idByPath = new Map(rows.map((r) => [r.path, r.id]));
  const index = buildImportIndex(allPaths); // once per rebuild, not per import
  const del = db.prepare("DELETE FROM edges WHERE src=? AND kind='import'");
  const ins = db.prepare("INSERT OR IGNORE INTO edges(src, dst, kind) VALUES(?,?,'import')");
  for (const t of touched) {
    del.run(t.fid);
    for (const mod of t.imports) { // precomputed by computeFile (possibly in a worker)
      const dst = resolveImport(mod, t.relpath, index);
      if (dst && dst !== t.relpath && idByPath.has(dst)) ins.run(t.fid, idByPath.get(dst));
    }
  }
}

async function loadExtractors() {
  const dir = path.join(GR_DIR, "extensions");
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of approvedFiles(dir, /\.extract\.mjs$/, log)) {
    try {
      // pathToFileURL, not "file://"+join: bare concatenation yields file://C:\…
      // on Windows, which the ESM loader rejects, silently skipping extensions.
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      if (mod.extractors) out.push({ name: f, x: normalizeHooks(mod.extractors) });
    } catch (e) { log("WARN", `extractor ${f} failed to load: ${e.message}`); }
  }
  return out;
}

/** A hook is either a bare function (runs over the default java/kotlin set) or
 *  { fn, files: /regex/ } — a FILE-SCOPED hook that runs over every tracked file
 *  its regex matches. This is what lets a Go/Rails/TS-only stack feed the native
 *  tables through the same extractor contract. */
function normalizeHooks(extractors) {
  const norm = {};
  for (const [hook, v] of Object.entries(extractors)) {
    if (typeof v === "function") norm[hook] = { fn: v, files: null };
    else if (v && typeof v.fn === "function") norm[hook] = { fn: v.fn, files: v.files ?? null };
  }
  return norm;
}

async function kafkaPass(db, scopePrefixes = null) {
  const EXTRACTORS = await loadExtractors();
  const runX = (hook, argsArr, insertFn) => {
    for (const { name, x } of EXTRACTORS) {
      const h = x[hook];
      if (!h || h.files) continue; // file-scoped hooks run via runXFiltered instead
      try { for (const row of h.fn(...argsArr) ?? []) insertFn(row); }
      catch (e) { log("WARN", `extractor ${name}.${hook}: ${e.message}`); }
    }
  };
  // Files claimed by file-scoped hooks join the extraction candidates below, so
  // scoping, per-file deletes, and the extract cache all apply to them too.
  const extFileREs = EXTRACTORS.flatMap(({ x }) => Object.values(x).map((h) => h.files).filter(Boolean));
  const inExtFiles = (p) => extFileREs.some((re) => re.test(p));
  const tracked = repoFiles();
  const configMap = loadConfigMap(REPO_ROOT, tracked, log);
  const idByPath = new Map(db.prepare("SELECT id, path, hash FROM files").all().map((r) => [r.path, r]));

  // ---- config fingerprint: any change to application*.yml|properties forces a full pass ----
  const cfgPaths = tracked.filter((p) => /(^|\/)(application|bootstrap)[^/]*\.(ya?ml|properties)$/.test(p)).sort();
  const cfgFp = createHash("sha1").update(cfgPaths.map((p) => p + ":" + (idByPath.get(p)?.hash ?? "")).join("|")).digest("hex");
  const prevFp = db.prepare("SELECT value FROM meta WHERE key='config_fp'").get()?.value;
  let mapsChanged = cfgFp !== prevFp;
  db.prepare("INSERT OR REPLACE INTO meta VALUES('config_fp', ?)").run(cfgFp);

  // ---- config-delta scoping: a semantic change used to widen extraction to
  // EVERY candidate file (one edited topic constant re-extracted a whole 50k
  // repo). Instead, collect the changed KEYS — config keys, constant names,
  // entity names — and widen only to files whose text mentions one, plus the
  // hash-changed files themselves. Falls back to the full widen when the
  // changed-key set is large (>50) or the previous config map is unknown, so
  // correctness never depends on the optimization. Parity: kafka_pass (py).
  const changedTokens = new Set();
  let widen = false;
  if (mapsChanged) {
    const prevMapJson = db.prepare("SELECT value FROM meta WHERE key='config_map'").get()?.value;
    if (prevMapJson) {
      try {
        const prevMap = JSON.parse(prevMapJson);
        const curMap = Object.fromEntries(configMap);
        for (const k of new Set([...Object.keys(prevMap), ...Object.keys(curMap)])) {
          if (prevMap[k] !== curMap[k]) changedTokens.add(k);
        }
      } catch { widen = true; }
    } else { widen = true; } // no previous map to diff against (first v6 run)
  }
  {
    const mapJson = JSON.stringify(Object.fromEntries(configMap));
    if (mapJson.length <= 200_000) db.prepare("INSERT OR REPLACE INTO meta VALUES('config_map', ?)").run(mapJson);
    else { db.prepare("DELETE FROM meta WHERE key='config_map'").run(); if (mapsChanged) widen = true; }
  }

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
  // LRU-bounded text cache. Unbounded (the old shape), the whole tracked corpus
  // lives in RSS for the entire pass — a 100 MB SQL dump included. Over the cap,
  // the least-recently-used texts fall out and are re-read on next use.
  const TEXT_MEMO_CAP = 64 * 1024 * 1024; // chars ≈ bytes for code
  const textMemo = new Map();
  let memoChars = 0;
  const readText = (rel) => {
    if (textMemo.has(rel)) {
      const v = textMemo.get(rel);
      textMemo.delete(rel); textMemo.set(rel, v); // refresh recency
      return v;
    }
    let t = null;
    try { t = fs.readFileSync(absPath(rel), "utf8"); } catch { t = null; }
    textMemo.set(rel, t);
    memoChars += t?.length ?? 0;
    while (memoChars > TEXT_MEMO_CAP && textMemo.size > 1) {
      const [k, v] = textMemo.entries().next().value; // oldest = least recently used
      textMemo.delete(k);
      memoChars -= v?.length ?? 0;
    }
    return t;
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
      // only a *semantic* delta forces the wider pass; a mere hash change with
      // identical constants/entities keeps scoping intact
      if (!c || c.constants !== cj || c.entities !== ej) {
        mapsChanged = true;
        // the changed KEYS drive token-scoped widening below
        const oldC = c ? JSON.parse(c.constants) : {};
        const oldE = c ? JSON.parse(c.entities) : {};
        for (const k of new Set([...Object.keys(oldC), ...Object.keys(consts)])) if (oldC[k] !== consts[k]) changedTokens.add(k);
        for (const k of new Set([...Object.keys(oldE), ...Object.keys(ents)])) if (oldE[k] !== ents[k]) changedTokens.add(k);
      }
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
  const candidates = tracked.filter((p) => /\.(java|kts?|xml|ya?ml|sql|ts|tsx|js|jsx|mjs|py|rb|prisma)$/.test(p) || inExtFiles(p));
  // token-scoped: a semantic change with a small, known key set widens only to
  // files that MENTION a changed key — extraction output for a file that never
  // references any changed constant/entity/config key is invariant under the
  // map change, so it keeps its rows and its cache stamp
  const tokenScoped = mapsChanged && !widen && changedTokens.size <= 50;
  const fullWiden = mapsChanged && !tokenScoped;
  const dirty = new Set();
  for (const p of candidates) {
    const cur = idByPath.get(p)?.hash;
    const seen = extractedAt.get(p);
    if (!seen || seen !== cur) dirty.add(p);
  }
  if (fullWiden) {
    for (const p of candidates) dirty.add(p);
  } else if (tokenScoped && changedTokens.size) {
    const toks = [...changedTokens];
    for (const p of candidates) {
      if (dirty.has(p)) continue;
      const t = readText(p);
      if (t != null && toks.some((k) => t.includes(k))) dirty.add(p);
    }
    log("INFO", `Config-delta scoping: ${changedTokens.size} changed key(s) widened extraction to ${dirty.size}/${candidates.length} files`);
  }
  const inScope = (rel) => dirty.has(rel);
  const delRows = (table) => {
    if (fullWiden) { db.exec(`DELETE FROM ${table}`); return; }
    const st = db.prepare(`DELETE FROM ${table} WHERE file_id IN (SELECT id FROM files WHERE path=?)`);
    for (const p of dirty) st.run(p);
  };
  const scopedDelete = delRows;
  // remember what we extracted, so an unchanged file is never re-read next time
  const markExtracted = db.prepare("INSERT OR REPLACE INTO extract_cache(path, hash, constants, entities) VALUES(?,?,COALESCE((SELECT constants FROM extract_cache WHERE path=?),'{}'),COALESCE((SELECT entities FROM extract_cache WHERE path=?),'{}'))");
  if (!fullWiden && dirty.size < candidates.length) {
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
  // file-scoped hooks: run each { fn, files } extractor over every in-scope
  // tracked file its regex matches — the unlock that makes non-JVM stacks
  // first-class citizens of message_flow/db_map/http_map and the drift math
  const runXFiltered = (hook, mkCtx, insertFn) => {
    for (const { name, x } of EXTRACTORS) {
      const h = x[hook];
      if (!h?.files) continue;
      for (const rel of tracked) {
        if (!h.files.test(rel) || !inScope(rel)) continue;
        const text = readText(rel);
        const fid = idByPath.get(rel)?.id;
        if (!fid || text == null) continue;
        try { for (const row of h.fn(text, mkCtx(rel)) ?? []) insertFn(row, fid); }
        catch (e) { log("WARN", `extractor ${name}.${hook} on ${rel}: ${e.message}`); }
      }
    }
  };

  // ---- Messaging (Kafka + Rabbit/JMS/SQS/NATS via the same table) ----
  scopedDelete("msg_edges");
  // config-DECLARED topics: application config is the seam's source of truth;
  // recording declarations lets tools flag topics declared but never used and
  // code that hardcodes a name its config already declares
  scopedDelete("msg_topics");
  const insDecl = db.prepare("INSERT INTO msg_topics(file_id, topic, config_key, line) VALUES(?,?,?,?)");
  for (const rel of cfgPaths) {
    if (!inScope(rel)) continue;
    const fid = idByPath.get(rel)?.id;
    const text = readText(rel);
    if (!fid || text == null) continue;
    for (const [key, value] of loadConfigMap(REPO_ROOT, [rel], () => {})) {
      if (!/topic|queue|destination|subject/i.test(key) || !value) continue;
      const tail = key.split(".").pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const lm = text.match(new RegExp(`(?:^|\\n)[^\\n]*${tail}\\s*[:=][^\\n]*`));
      const line = lm ? text.slice(0, lm.index + 1).split("\n").length : 1;
      insDecl.run(fid, String(value), key, line);
    }
  }
  const ins = db.prepare("INSERT INTO msg_edges(file_id, topic, direction, line, resolved, via, system) VALUES(?,?,?,?,?,?,?)");
  let n = 0;
  for (const rel of javaish) {
    if (!inScope(rel)) continue;
    const text = readText(rel);
    const fid = idByPath.get(rel)?.id;
    if (!fid || text == null || !/Kafka|ProducerRecord|\.send\s*\(|subscribe|convertAndSend|RabbitListener|JmsListener/.test(text)) continue;
    for (const e of extractKafkaEdges(text, configMap, overlay(constants, rel, "constants"))) {
      ins.run(fid, e.topic, e.direction, e.line, e.resolved ? 1 : 0, e.via, e.system ?? "kafka");
      n++;
    }
  }
  // broker clients outside the JVM: amqplib/pika/boto3/nats in TS/JS/Python
  for (const rel of tracked) {
    if (!/\.(ts|tsx|js|jsx|mjs|py)$/.test(rel) || !inScope(rel)) continue;
    const text = readText(rel);
    const fid = idByPath.get(rel)?.id;
    if (!fid || text == null || !/sendToQueue|assertQueue|basic_publish|basic_consume|QueueUrl|amqplib|amqp:\/\/|\bnats\b|import\s+pika/.test(text)) continue;
    for (const e of extractBrokerEdges(text)) {
      ins.run(fid, e.topic, e.direction, e.line, 1, e.via, e.system);
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
      (e) => { ins.run(fid, e.topic, e.direction, e.line, e.resolved === false ? 0 : 1, e.via ?? null, e.system ?? "kafka"); n++; });
  }
  runXFiltered("kafka", (rel) => ({ configMap, constants, relpath: rel }),
    (e, fid) => { ins.run(fid, e.topic, e.direction, e.line, e.resolved === false ? 0 : 1, e.via ?? null, e.system ?? "kafka"); n++; });
  if (n) log("INFO", `Messaging: ${n} edges`);

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
  // schema definitions beyond Liquibase/Flyway: Prisma, Rails, Alembic
  for (const rel of tracked) {
    if (!/\.(prisma|rb|py)$/.test(rel) || !inScope(rel)) continue;
    const text = readText(rel);
    if (text == null || !isSchemaFile(rel, text)) continue;
    const fid = idByPath.get(rel)?.id;
    for (const d of extractSchemaDefs(rel, text)) { insDef.run(fid ?? null, d.table, d.op, d.line, d.changeset); defs++; }
  }
  // DB access beyond the JVM: SQLAlchemy models + literal driver SQL
  for (const rel of tracked) {
    if (!/\.(py|ts|tsx|js|jsx|mjs|rb)$/.test(rel) || !inScope(rel)) continue;
    const text = readText(rel);
    const fid = idByPath.get(rel)?.id;
    if (!fid || text == null || !/__tablename__|\bTable\s*\(|execute|exec_driver_sql|\.query\s*\(|\.raw\s*\(/.test(text)) continue;
    for (const a of extractGenericDbAccess(text)) { insAcc.run(fid, a.table, a.kind, a.mode, a.line, a.detail); accs++; }
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
  runXFiltered("dbAccess", (rel) => ({ entityTables, constants, relpath: rel }),
    (r, fid) => { insAcc.run(fid, r.table, r.kind ?? "sql", r.mode ?? "rw", r.line, r.detail ?? "extension"); accs++; });
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
  runXFiltered("httpEndpoints", (rel) => ({ relpath: rel }),
    (e, fid) => { insEp.run(fid, e.method, e.path, e.norm ?? e.path, e.line, e.detail ?? "extension"); eps++; });
  runXFiltered("httpCalls", (rel) => ({ relpath: rel }),
    (c, fid) => { insCall.run(fid, c.method, c.path, c.norm ?? c.path, c.line, c.client ?? "extension"); hcalls++; });
  for (const rel of tracked) {
    if (!/\.(ts|tsx|js|jsx|mjs)$/.test(rel) || !inScope(rel)) continue;
    const text = readText(rel);
    const fid = idByPath.get(rel)?.id;
    if (!fid || text == null) continue;
    if (/fetch\s*\(|axios|\.(get|post|put|delete|patch)\s*(<[^>]*>)?\s*\(\s*[\x60"']/.test(text)) {
      for (const c of extractTsHttp(text)) { insCall.run(fid, c.method, c.path, c.norm, c.line, c.client); hcalls++; }
    }
    // Express/Fastify/Router registrations + Nest controllers as ENDPOINTS
    if (/\b(?:app|router|server|fastify)\s*\.\s*(?:get|post|put|delete|patch|head|all)\s*\(|@Controller/.test(text)) {
      for (const e of extractTsEndpoints(text)) { insEp.run(fid, e.method, e.path, e.norm, e.line, e.detail); eps++; }
    }
  }
  // Python HTTP seam: Flask/FastAPI endpoints + requests/httpx calls
  for (const rel of tracked) {
    if (!rel.endsWith(".py") || !inScope(rel)) continue;
    const text = readText(rel);
    const fid = idByPath.get(rel)?.id;
    if (!fid || text == null || !/@\w+\.(?:route|get|post|put|delete|patch|head)\s*\(|requests\.|httpx/.test(text)) continue;
    const r = extractPyHttp(text);
    for (const e of r.endpoints) { insEp.run(fid, e.method, e.path, e.norm, e.line, e.detail); eps++; }
    for (const c of r.calls) { insCall.run(fid, c.method, c.path, c.norm, c.line, c.client); hcalls++; }
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
    if (fs.existsSync(af)) {
      try { list = JSON.parse(fs.readFileSync(af, "utf8")); }
      catch (e) { log("WARN", `docs/graph-assertions.json is not valid JSON (${e.message}); assertions stay out of the graph until it is fixed`); }
    }
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
  for (const f of approvedFiles(dir, /\.pass\.mjs$/, log)) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
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
  // A transient git failure (held index.lock, timeout, git missing) makes
  // repoFiles() return [] — without this guard the prune loop below would then
  // silently delete every row in the index. --rebuild still forces through.
  if (!files.length && !rebuild) {
    const existing = db.prepare("SELECT COUNT(*) c FROM files").get().c;
    if (existing > 0) {
      log("WARN", `git returned 0 tracked files but the index holds ${existing}; refusing to prune (transient git failure?). Run --rebuild to force.`);
      return;
    }
  }
  const r = await inTx(db, async () => {
  if (rebuild) {
    // Deleting files cascade-wipes every correlation row, so the extraction cache
    // MUST go too, otherwise the passes compare hashes, conclude "nothing changed",
    // and rebuild into an empty graph.
    db.exec("DELETE FROM files; DELETE FROM chunk_text;");
    try { db.exec("DELETE FROM extract_cache"); db.exec("DELETE FROM meta WHERE key='config_fp'"); } catch { /* fresh db */ }
  }
  const tracked = new Set(files);
  const S = stmts(db);
  // prune files no longer tracked
  let removed = 0;
  for (const { path: p } of db.prepare("SELECT path FROM files").all()) {
    if (!tracked.has(p)) {
      S.delFileByPath.run(p);
      S.delChunksByPath.run(p);
      removed++;
    }
  }
  const touched = [];
  let skipped = 0;
  await computeAndApply(db, files, rebuild, (rec) => {
    if (!rec) return;
    if (rec.status === "unchanged") { skipped++; return; }
    if (rec.status === "statOnly") { applyFile(db, rec); skipped++; return; }
    touched.push(applyFile(db, rec));
  });
  rebuildEdges(db, touched);
  await kafkaPass(db, null);
  stamp(db);
  if (touched.length > 200) {
    // merge FTS b-trees after a bulk load; per-file inserts leave many small
    // segments that slow every MATCH until merged
    try { db.exec("INSERT INTO chunks(chunks) VALUES('optimize')"); } catch { /* never fatal */ }
  }
  log("INFO", `Full index: ${touched.length} (re)indexed, ${skipped} unchanged (cached), ${removed} removed of ${files.length} tracked in ${Date.now() - t0}ms`);
  });
  // outside the tx (a checkpoint inside one is a no-op): the mega-transaction
  // balloons the -wal file to ~DB size and it then sits on disk indefinitely
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* never fatal */ }
  return r;
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
  const S = stmts(db);
  for (const p of deleted) {
    S.delFileByPath.run(p);
    S.delChunksByPath.run(p);
  }
  const touched = [];
  // (also aligns with the Python edition: "unchanged" results never enter
  // `touched` — the old loop pushed the bare string in)
  await computeAndApply(db, relevant, false, (rec) => {
    if (!rec || rec.status === "unchanged") return;
    if (rec.status === "statOnly") { applyFile(db, rec); return; }
    touched.push(applyFile(db, rec));
  });
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

// ---------------------------------------------------------- worker entry
// Parallel extract workers re-import this module; they only ever compute
// (computeFile has no DB access) and post results back. The CLI block below
// is main-thread-only, so a worker never tries to index on its own.
if (!isMainThread && workerData?.ariadneExtractWorker) {
  parentPort.on("message", async (t) => {
    let rec = null;
    try { rec = await computeFile(t.rel, t.prev, t.force); }
    catch (e) { log("DEBUG", `worker compute failed for ${t.rel}: ${e.message}`); rec = null; }
    parentPort.postMessage({ i: t.i, rec });
  });
}

// -------------------------------------------------------------------- main
if (isMainThread) {
if (MULTI) log("INFO", `Workspace mode: ${ROOTS.length} repos: ${ROOTS.map(r=>path.basename(r)).join(", ")}`);
const mode = process.argv[2] ?? "--status";
if (mode === "--status") {
  status(connect());
} else if (mode === "--approve-extensions") {
  const { approved, changed } = approveAll(path.join(GR_DIR, "extensions"));
  console.log(approved.length
    ? `Approved ${approved.length} extension file(s)${changed.length ? ` (${changed.length} new/changed: ${changed.join(", ")})` : " (no changes)"}. Commit .ariadne/${LOCK_NAME} to share the approval.`
    : "No extension files found in .ariadne/extensions/.");
} else if (mode === "--full" || mode === "--incremental" || mode === "--rebuild") {
  if (!acquireLock()) { log("INFO", "Another indexer run is in progress; exiting cleanly."); process.exit(0); }
  try {
    const db = connect(true);
    if (CHUNKS_MIGRATED) await fullIndex(db, true); // derived index: rebuild IS the migration
    else mode === "--incremental" ? await incrementalIndex(db) : await fullIndex(db, mode === "--rebuild");
    // keep the query planner's stats current as the graph grows; near-zero cost
    try { db.pragma("optimize"); } catch { /* never fatal */ }
  } catch (e) {
    log("ERROR", e.stack ?? String(e));
    process.exitCode = 1;
  } finally {
    releaseLock();
  }
} else {
  console.log("Usage: node indexer.mjs --full | --incremental | --rebuild | --status | --approve-extensions [--workers N]");
  process.exitCode = 2;
}
}
