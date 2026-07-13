#!/usr/bin/env python3
"""
Ariadne (GraphRAG-style)-style codebase indexer.

Builds a queryable graph of the repository in SQLite (.ariadne/index.db):
  - files:    every source file (path, language, hash)
  - symbols:  functions/classes/methods/etc. with signatures and line numbers
  - edges:    import/dependency edges between files (module-level graph)
  - chunks:   FTS5 full-text index over code chunks for lexical retrieval

Usage:
  python3 indexer.py --full           # index everything from scratch
  python3 indexer.py --incremental    # reindex only files changed since last run (via git)
  python3 indexer.py --status         # print index stats
"""

import argparse
import hashlib
import json
import logging
import os
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

SCHEMA_VERSION = 4

def _discover_roots():
    env = os.environ.get("ARIADNE_ROOTS")
    if env:
        return [Path(p.strip()).resolve() for p in env.split(",") if Path(p.strip()).exists()]
    top = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
    if top:
        return [Path(top).resolve()]
    cwd = Path.cwd()
    kids = [d for d in cwd.iterdir() if d.is_dir() and not d.name.startswith(".") and (d / ".git").exists()]
    return kids or [cwd]


ROOTS = _discover_roots()
MULTI = len(ROOTS) > 1
REPO_ROOT = Path.cwd().resolve() if MULTI else ROOTS[0]
ROOT_BY_PREFIX = {(r.name if MULTI else ""): r for r in ROOTS}


def abs_path(rel):
    if not MULTI:
        return REPO_ROOT / rel
    head, _, rest = rel.partition("/")
    root = ROOT_BY_PREFIX.get(head)
    return (root / rest) if root else (REPO_ROOT / rel)
DB_DIR = Path(os.environ.get("ARIADNE_HOME", REPO_ROOT)) / ".ariadne"
DB_PATH = DB_DIR / "index.db"
LOCK_PATH = DB_DIR / ".index.lock"

DB_DIR.mkdir(exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(DB_DIR / "index.log"), logging.StreamHandler()])
log = logging.getLogger("ariadne")

# Optional overrides from .ariadne/config.json: skipDirs, aliasPrefixes,
# maxFileBytes, chunkLines, extraExtensions ({".vue": "javascript"})
_cfg = {}
try:
    _cfg = json.loads((DB_DIR / "config.json").read_text())
    log.info("Loaded .ariadne/config.json overrides")
except (OSError, json.JSONDecodeError):
    pass
ALIAS_PREFIXES = tuple(_cfg.get("aliasPrefixes", ["@/", "~/"]))
AST_EXTRACT = None
AST_LANGS = {"java", "kotlin", "typescript", "javascript", "python"}

LANG_BY_EXT = dict(_cfg.get("extraExtensions", {}))
LANG_BY_EXT.update({
    ".py": "python", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".java": "java", ".cs": "csharp",
    ".go": "go", ".rs": "rust", ".rb": "ruby", ".php": "php", ".c": "c", ".h": "c",
    ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp", ".kt": "kotlin", ".kts": "kotlin", ".gradle": "config", ".swift": "swift",
    ".scala": "scala", ".sql": "sql", ".sh": "shell", ".yaml": "config", ".yml": "config",
    ".toml": "config", ".json": "config", ".xml": "config", ".md": "docs", ".pdf": "docs",
})
SKIP_DIRS = {".git", ".ariadne", "node_modules", "vendor", "dist", "build", "target",
             "__pycache__", ".venv", "venv", ".next", "coverage", ".idea", ".vscode"}
SKIP_DIRS |= set(_cfg.get("skipDirs", []))
MAX_FILE_BYTES = int(_cfg.get("maxFileBytes", 1_500_000))
CHUNK_LINES = int(_cfg.get("chunkLines", 40))

# ---------------------------------------------------------------- extraction

SYMBOL_PATTERNS = {
    "python": [
        (re.compile(r"^(?P<indent>\s*)def\s+(?P<name>\w+)\s*(?P<sig>\([^)]*\))", re.M), "function"),
        (re.compile(r"^(?P<indent>\s*)class\s+(?P<name>\w+)\s*(?P<sig>\([^)]*\))?", re.M), "class"),
    ],
    "javascript": [
        (re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(?P<name>\w+)\s*(?P<sig>\([^)]*\))", re.M), "function"),
        (re.compile(r"^\s*(?:export\s+)?class\s+(?P<name>\w+)", re.M), "class"),
        (re.compile(r"^\s*(?:export\s+)?const\s+(?P<name>\w+)\s*(?::\s*[\w.<>,\[\]{}| ]+?)?=\s*(?:async\s*)?(?P<sig>\([^)]*\)|\w+)\s*(?::\s*[\w.<>,\[\]| ]+)?\s*=>", re.M), "function"),
    ],
    "java": [
        (re.compile(r"^\s*(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+(?P<name>\w+)", re.M), "class"),
        (re.compile(r"^\s*(?:public|protected|private|default)\s+(?:static\s+|final\s+|abstract\s+|synchronized\s+)*[\w<>\[\], ?]+\s+(?P<name>\w+)\s*(?P<sig>\([^)]*\))\s*(?:throws[\w, ]+)?\s*[;{]", re.M), "method"),
        # interface/abstract declarations: no modifier, semicolon-terminated
        (re.compile(r"^\s{2,}(?!new\b|return\b|throw\b|else\b|if\b|while\b|for\b|switch\b|super\b|this\b)[\w<>\[\], ?]+\s+(?P<name>\w+)\s*(?P<sig>\([^)]*\))\s*(?:throws[\w, ]+)?\s*;", re.M), "method"),
    ],
    "csharp": [
        (re.compile(r"^\s*(?:public|internal|protected|private)?\s*(?:static\s+|sealed\s+|abstract\s+|partial\s+)*(?:class|interface|enum|record|struct)\s+(?P<name>\w+)", re.M), "class"),
        (re.compile(r"^\s*(?:public|internal|protected|private)\s+(?:static\s+|async\s+|virtual\s+|override\s+)*[\w<>\[\], ?]+\s+(?P<name>\w+)\s*(?P<sig>\([^)]*\))", re.M), "method"),
    ],
    "go": [
        (re.compile(r"^func\s+(?:\((?P<recv>[^)]+)\)\s+)?(?P<name>\w+)\s*(?P<sig>\([^)]*\))", re.M), "function"),
        (re.compile(r"^type\s+(?P<name>\w+)\s+(?:struct|interface)", re.M), "class"),
    ],
    "rust": [
        (re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?fn\s+(?P<name>\w+)\s*(?:<[^>]*>)?\s*(?P<sig>\([^)]*\))", re.M), "function"),
        (re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+(?P<name>\w+)", re.M), "class"),
    ],
    "ruby": [
        (re.compile(r"^\s*def\s+(?P<name>[\w.?!=\[\]]+)", re.M), "function"),
        (re.compile(r"^\s*(?:class|module)\s+(?P<name>[\w:]+)", re.M), "class"),
    ],
    "php": [
        (re.compile(r"^\s*(?:public|protected|private)?\s*(?:static\s+)?function\s+(?P<name>\w+)\s*(?P<sig>\([^)]*\))", re.M), "function"),
        (re.compile(r"^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+(?P<name>\w+)", re.M), "class"),
    ],
}

IMPORT_PATTERNS = {
    "python": [re.compile(r"^\s*(?:from\s+(?P<mod>[\w.]+)\s+import|import\s+(?P<mod2>[\w.]+))", re.M)],
    "javascript": [re.compile(r"""(?:import\s+.*?from\s+|require\s*\(\s*)['"](?P<mod>[^'"]+)['"]""", re.M)],
    "typescript": [re.compile(r"""(?:import\s+.*?from\s+|require\s*\(\s*)['"](?P<mod>[^'"]+)['"]""", re.M)],
    "go": [re.compile(r'^\s*(?:import\s+)?"(?P<mod>[\w./-]+)"', re.M)],
    "java": [re.compile(r"^import\s+(?:static\s+)?(?P<mod>[\w.]+);", re.M)],
    "csharp": [re.compile(r"^using\s+(?P<mod>[\w.]+);", re.M)],
    "rust": [re.compile(r"^\s*use\s+(?P<mod>[\w:]+)", re.M)],
    "ruby": [re.compile(r"""^\s*require(?:_relative)?\s+['"](?P<mod>[^'"]+)['"]""", re.M)],
    "php": [re.compile(r"^use\s+(?P<mod>[\w\\]+)", re.M)],
}
SYMBOL_PATTERNS["typescript"] = SYMBOL_PATTERNS["javascript"] + [
    (re.compile(r"^\s*(?:export\s+)?(?:interface|type|enum)\s+(?P<name>\w+)", re.M), "type"),
]


def extract_symbols(lang, text):
    out = []
    for pattern, kind in SYMBOL_PATTERNS.get(lang, []):
        for m in pattern.finditer(text):
            line = text.count("\n", 0, m.start()) + 1
            sig = (m.groupdict().get("sig") or "").strip()[:200]
            out.append((m.group("name"), kind, line, sig))
    return out


def extract_imports(lang, text):
    mods = set()
    for pattern in IMPORT_PATTERNS.get(lang, []):
        for m in pattern.finditer(text):
            mod = m.groupdict().get("mod") or m.groupdict().get("mod2")
            if mod:
                mods.add(mod)
    return mods


def resolve_import(mod, src_path, all_paths):
    """Heuristically resolve an import string to a file path in the repo."""
    candidates = set()
    if mod.startswith("."):  # relative import (js/ts/py styles)
        base = abs_path(src_path).parent
        raw = (base / mod).resolve()
        for suffix in ["", ".py", ".js", ".ts", ".jsx", ".tsx", "/index.js", "/index.ts", "/__init__.py"]:
            candidates.add(str(raw) + suffix)
    # TS path aliases (@/x, ~/x) -> treat as repo-relative tails
    for prefix in ALIAS_PREFIXES:
        if mod.startswith(prefix):
            mod = mod[len(prefix):]
            break
    tail = mod.replace(".", "/").replace("::", "/").replace("\\", "/")
    for p in all_paths:
        ap = str(REPO_ROOT / p)
        if ap in candidates:
            return p
        stem = p.rsplit(".", 1)[0]
        if stem.endswith(tail) or stem.endswith(tail.replace("/", os.sep)):
            return p
    return None

# ------------------------------------------------------------------ storage

SCHEMA = """
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
CREATE TABLE IF NOT EXISTS decision_links(decision_id TEXT, kind TEXT, target TEXT);
CREATE INDEX IF NOT EXISTS idx_dlinks ON decision_links(target);
CREATE TABLE IF NOT EXISTS extract_cache(
  path TEXT PRIMARY KEY, hash TEXT, constants TEXT, entities TEXT);
CREATE TABLE IF NOT EXISTS edges(
  src INTEGER REFERENCES files(id) ON DELETE CASCADE,
  dst INTEGER REFERENCES files(id) ON DELETE CASCADE,
  kind TEXT DEFAULT 'import', UNIQUE(src, dst, kind));
CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
  path, start_line UNINDEXED, content, tokenize='trigram');
"""


def _rotate_log():
    try:
        lp = DB_DIR / "index.log"
        if lp.exists() and lp.stat().st_size > 5 * 1024 * 1024:
            tail = lp.read_bytes()[-512 * 1024:]
            lp.write_bytes(b"[log rotated]\n" + tail)
    except OSError:
        pass


_rotate_log()


def connect():
    try:
        con = sqlite3.connect(DB_PATH, timeout=10)
        con.execute("PRAGMA quick_check")
    except sqlite3.DatabaseError as e:
        msg = str(e).lower()
        if "malformed" in msg or "not a database" in msg or "corrupt" in msg:
            aside = str(DB_PATH) + f".corrupt-{int(time.time())}"
            try:
                con.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                os.replace(DB_PATH, aside)
            except OSError:
                pass
            for sfx in ("-wal", "-shm"):
                try:
                    os.remove(str(DB_PATH) + sfx)
                except OSError:
                    pass
            log.warning("Index was corrupt, moved to %s; rebuilding fresh", Path(aside).name)
            con = sqlite3.connect(DB_PATH, timeout=10)
        else:
            raise
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=5000")
    con.execute("PRAGMA foreign_keys=ON")
    # This is a rebuildable derived index: NORMAL is durable across app crashes and
    # much faster. The rest are pure speed.
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA cache_size=-64000")
    con.execute("PRAGMA temp_store=MEMORY")
    con.execute("PRAGMA mmap_size=268435456")
    con.executescript(SCHEMA)
    try:
        con.execute("ALTER TABLE symbols ADD COLUMN parent TEXT")
    except sqlite3.OperationalError:
        pass  # column exists
    for col, typ in (("size", "INTEGER"), ("mtime", "REAL")):
        try:
            con.execute(f"ALTER TABLE files ADD COLUMN {col} {typ}")
        except sqlite3.OperationalError:
            pass
    # provenance: 'static' (parsed) vs 'asserted:<author>' (derived). Never silently mixed.
    for t in ("msg_edges", "db_access", "http_endpoints", "http_calls"):
        try:
            con.execute(f"ALTER TABLE {t} ADD COLUMN source TEXT DEFAULT 'static'")
        except sqlite3.OperationalError:
            pass
    row = con.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    if row and int(row[0]) > SCHEMA_VERSION:
        raise SystemExit(f"Index schema v{row[0]} is newer than this indexer (v{SCHEMA_VERSION}). Update the toolkit.")
    con.execute("INSERT OR REPLACE INTO meta VALUES('schema_version', ?)", (str(SCHEMA_VERSION),))
    return con


def acquire_lock():
    try:
        fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    except FileExistsError:
        try:
            if time.time() - LOCK_PATH.stat().st_mtime > 600:  # stale >10min
                LOCK_PATH.unlink()
                return acquire_lock()
        except OSError:
            pass
        return False


def release_lock():
    try:
        LOCK_PATH.unlink()
    except OSError:
        pass

# ----------------------------------------------------------------- indexing


def repo_files():
    for root in ROOTS:
        prefix = root.name if MULTI else ""
        r = subprocess.run(["git", "ls-files"], capture_output=True, text=True, cwd=root)
        for line in r.stdout.splitlines():
            p = Path(line)
            if any(part in SKIP_DIRS for part in p.parts):
                continue
            if p.suffix.lower() in LANG_BY_EXT:
                yield f"{prefix}/{line}" if prefix else line


def index_file(con, relpath, force=False):
    full = abs_path(relpath)
    if not full.exists():
        return None
    st = full.stat()
    if st.st_size > MAX_FILE_BYTES:
        return None
    prev = con.execute("SELECT hash, size, mtime FROM files WHERE path=?", (relpath,)).fetchone()
    # fast path 1: identical stat -> nothing to do (PDFs seen once stay seen)
    if not force and prev and prev[1] == st.st_size and prev[2] == st.st_mtime:
        return "unchanged"
    try:
        buf = full.read_bytes()
    except OSError:
        return None
    # fast path 2: raw-byte checksum, BEFORE any extraction, a touched-but-identical
    # file (incl. PDFs) is caught here without paying extraction cost
    h = hashlib.sha1(buf).hexdigest()
    if not force and prev and prev[0] == h:
        con.execute("UPDATE files SET size=?, mtime=? WHERE path=?", (st.st_size, st.st_mtime, relpath))
        return "unchanged"
    if full.suffix.lower() == ".pdf":
        try:
            import io
            from pypdf import PdfReader
            text = "\n".join((pg.extract_text() or "") for pg in PdfReader(io.BytesIO(buf)).pages)
            if not text.strip():
                return None
        except Exception as e:  # noqa: BLE001
            log.debug("pdf skip %s: %s", relpath, e)
            return None
    else:
        text = buf.decode("utf-8", errors="replace")
    lang = LANG_BY_EXT.get(full.suffix.lower(), "other")

    con.execute("DELETE FROM chunks WHERE path=?", (relpath,))
    old = con.execute("SELECT id FROM files WHERE path=?", (relpath,)).fetchone()
    if old:
        con.execute("DELETE FROM files WHERE id=?", (old[0],))
    cur = con.execute(
        "INSERT INTO files(path, lang, hash, lines, indexed_at, size, mtime) VALUES(?,?,?,?,?,?,?)",
        (relpath, lang, h, text.count("\n") + 1, time.time(), st.st_size, st.st_mtime))
    fid = cur.lastrowid

    ast_result = None
    if lang in AST_LANGS and AST_EXTRACT is None and not globals().get("_ast_tried"):
        globals()["_ast_tried"] = True          # lazy: skip WASM/grammar load on docs-only commits
        from ast_extract import get_ast_extractor
        globals()["AST_EXTRACT"] = get_ast_extractor()
    if AST_EXTRACT is not None:
        try:
            ast_result = AST_EXTRACT(lang, full.suffix.lower(), text)
        except Exception as e:  # noqa: BLE001 - AST must never break indexing
            log.debug("AST failed for %s: %s", relpath, e)
    if ast_result:
        id_by_name = {}
        for s_ in ast_result["symbols"]:
            cur2 = con.execute(
                "INSERT INTO symbols(file_id, name, kind, line, signature, parent) VALUES(?,?,?,?,?,?)",
                (fid, s_["name"], s_["kind"], s_["line"], s_.get("sig", ""), s_.get("parent")))
            id_by_name.setdefault(s_["name"], cur2.lastrowid)
        for c in ast_result["calls"]:
            src = id_by_name.get(c["caller"]) if c["caller"] else None
            if src:
                con.execute("INSERT INTO calls(src_symbol, callee, line) VALUES(?,?,?)",
                            (src, c["callee"], c["line"]))
    else:
        for name, kind, line, sig in extract_symbols(lang, text):
            con.execute("INSERT INTO symbols(file_id, name, kind, line, signature, parent) VALUES(?,?,?,?,?,NULL)",
                        (fid, name, kind, line, sig))

    lines = text.splitlines()
    for start in range(0, len(lines), CHUNK_LINES):
        chunk = "\n".join(lines[start:start + CHUNK_LINES])
        if chunk.strip():
            con.execute("INSERT INTO chunks(path, start_line, content) VALUES(?,?,?)",
                        (relpath, start + 1, chunk))
    return fid, lang, text


def rebuild_edges(con, touched):
    """(Re)build import edges for the given file records (fid, lang, text)."""
    all_paths = [r[0] for r in con.execute("SELECT path FROM files")]
    id_by_path = {r[1]: r[0] for r in con.execute("SELECT id, path FROM files")}
    for fid, lang, text in touched:
        con.execute("DELETE FROM edges WHERE src=?", (fid,))
        src_path = con.execute("SELECT path FROM files WHERE id=?", (fid,)).fetchone()[0]
        for mod in extract_imports(lang, text):
            dst = resolve_import(mod, src_path, all_paths)
            if dst and dst != src_path and dst in id_by_path:
                con.execute("INSERT OR IGNORE INTO edges(src, dst) VALUES(?,?)",
                            (fid, id_by_path[dst]))


def _load_extractors():
    ext = DB_DIR / "extensions"
    out = []
    if not ext.exists():
        return out
    import importlib.util
    for f in sorted(ext.glob("*.extract.py")):
        try:
            spec = importlib.util.spec_from_file_location(f.stem.replace(".", "_").replace("-", "_"), f)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            if hasattr(mod, "extractors"):
                out.append((f.name, mod.extractors))
        except Exception as e:  # noqa: BLE001
            log.warning("extractor %s failed to load: %s", f.name, e)
    return out


def kafka_pass(con, scope_prefixes=None):
    import json as _json
    EXTRACTORS = _load_extractors()

    def run_x(hook, args, insert):
        for name, x in EXTRACTORS:
            fn = x.get(hook)
            if not callable(fn):
                continue
            try:
                for row in fn(*args) or []:
                    insert(row)
            except Exception as e:  # noqa: BLE001
                log.warning("extractor %s.%s: %s", name, hook, e)
    from kafka_extract import load_config_map, load_constants, extract_kafka_edges
    from db_extract import (is_changelog, extract_changelog, extract_entities,
                            extract_db_access, extract_lombok_symbols)
    from http_extract import extract_java_http, extract_ts_http
    tracked = list(repo_files())
    cfg = load_config_map(REPO_ROOT, tracked, log)
    rows = con.execute("SELECT id, path, hash FROM files").fetchall()
    id_by_path = {r[1]: r[0] for r in rows}
    hash_by_path = {r[1]: r[2] for r in rows}

    cfg_paths = sorted(p for p in tracked if re.search(r"(^|/)(application|bootstrap)[^/]*\.(ya?ml|properties)$", p))
    cfg_fp = hashlib.sha1("|".join(f"{p}:{hash_by_path.get(p,'')}" for p in cfg_paths).encode()).hexdigest()
    prev = con.execute("SELECT value FROM meta WHERE key='config_fp'").fetchone()
    maps_changed = (not prev) or prev[0] != cfg_fp
    con.execute("INSERT OR REPLACE INTO meta VALUES('config_fp', ?)", (cfg_fp,))

    javaish = [p for p in tracked if p.endswith((".java", ".kt", ".kts"))]
    # Snapshot of what we last EXTRACTED, taken before the map loop updates it. Files whose
    # content hash has moved on are the ones needing re-extraction. Reindexing a file cascades
    # its correlation rows away, so this set must be exact.
    extracted_at = {r[0]: r[1] for r in con.execute("SELECT path, hash FROM extract_cache")}
    constants, entity_tables = {}, {}
    text_memo = {}

    def read_text(rel):
        if rel not in text_memo:
            try:
                text_memo[rel] = abs_path(rel).read_text(encoding="utf-8", errors="replace")
            except OSError:
                text_memo[rel] = None
        return text_memo[rel]

    for rel in javaish:
        fh = hash_by_path.get(rel)
        c = con.execute("SELECT hash, constants, entities FROM extract_cache WHERE path=?", (rel,)).fetchone()
        if c and fh and c[0] == fh:
            consts, ents = _json.loads(c[1]), _json.loads(c[2])
        else:
            text = read_text(rel)
            if text is None:
                continue
            consts = load_constants([(rel, text)])
            ents = extract_entities(text)
            cj, ej = _json.dumps(consts, sort_keys=True), _json.dumps(ents, sort_keys=True)
            if not c or c[1] != cj or c[2] != ej:
                maps_changed = True
            con.execute("INSERT OR REPLACE INTO extract_cache(path, hash, constants, entities) VALUES(?,?,?,?)",
                        (rel, fh or "", cj, ej))
        for k, v in consts.items():
            constants.setdefault(k, v)
        entity_tables.update(ents)
    con.execute("DELETE FROM extract_cache WHERE path NOT IN (SELECT path FROM files)")
    for k, v in _cfg.get("tableNameOverrides", {}).items():
        entity_tables[k] = str(v).lower()

    candidates = [p for p in tracked if re.search(r"\.(java|kts?|xml|ya?ml|sql|ts|tsx|js|jsx|mjs)$", p)]
    if maps_changed:
        dirty = set(candidates)
    else:
        dirty = {p for p in candidates if extracted_at.get(p) != hash_by_path.get(p)}

    def in_scope(rel):
        return rel in dirty

    def scoped_delete(table):
        if maps_changed:
            con.execute(f"DELETE FROM {table}")
        else:
            for p in dirty:
                con.execute(f"DELETE FROM {table} WHERE file_id IN (SELECT id FROM files WHERE path=?)", (p,))
    if not maps_changed and len(dirty) < len(candidates):
        log.info("Extraction scoped to %d/%d changed files", len(dirty), len(candidates))

    scoped_delete("msg_edges")
    n = 0
    for rel in javaish:
        if not in_scope(rel):
            continue
        text = read_text(rel)
        fid = id_by_path.get(rel)
        if not fid or text is None or not any(k in text for k in ("Kafka", "ProducerRecord", ".send(", "subscribe")):
            continue
        for e in extract_kafka_edges(text, cfg, constants):
            con.execute("INSERT INTO msg_edges(file_id, topic, direction, line, resolved, via) VALUES(?,?,?,?,?,?)",
                        (fid, e["topic"], e["direction"], e["line"], 1 if e["resolved"] else 0, e["via"]))
            n += 1
    for rel in javaish:
        if not in_scope(rel):
            continue
        text = read_text(rel)
        fid = id_by_path.get(rel)
        if not fid or text is None:
            continue
        def _ins_kafka(e, fid=fid):
            nonlocal n
            con.execute("INSERT INTO msg_edges(file_id, topic, direction, line, resolved, via) VALUES(?,?,?,?,?,?)",
                        (fid, e["topic"], e["direction"], e["line"],
                         0 if e.get("resolved") is False else 1, e.get("via")))
            n += 1
        run_x("kafka", (text, {"config": cfg, "constants": constants, "relpath": rel}), _ins_kafka)
    if n:
        log.info("Kafka: %d message edges", n)

    scoped_delete("db_defs")
    scoped_delete("db_access")
    defs = accs = lombok = 0
    for rel in tracked:
        if not rel.endswith((".xml", ".yml", ".yaml", ".sql")) or not in_scope(rel):
            continue
        text = read_text(rel)
        if text is None or not is_changelog(rel, text):
            continue
        fid = id_by_path.get(rel)
        for d in extract_changelog(rel, text):
            con.execute("INSERT INTO db_defs(file_id, tbl, op, line, changeset) VALUES(?,?,?,?,?)",
                        (fid, d["table"], d["op"], d["line"], d["changeset"]))
            defs += 1
    for rel in javaish:
        if not in_scope(rel):
            continue
        text = read_text(rel)
        fid = id_by_path.get(rel)
        if not fid or text is None:
            continue
        if re.search(r"@Entity|Repository|@Query|[Jj]dbc|Template|com\.querydsl|JPAQueryFactory", text):
            for a in extract_db_access(text, entity_tables, constants):
                con.execute("INSERT INTO db_access(file_id, tbl, kind, mode, line, detail) VALUES(?,?,?,?,?,?)",
                            (fid, a["table"], a["kind"], a["mode"], a["line"], a["detail"]))
                accs += 1
        if re.search(r"@(?:Data|Value|Getter|Setter|(?:Super)?Builder)\b", text):
            con.execute("DELETE FROM symbols WHERE file_id=? AND signature LIKE '%Lombok-generated%'", (fid,))
            for sy in extract_lombok_symbols(text):
                con.execute("INSERT INTO symbols(file_id, name, kind, line, signature, parent) VALUES(?,?,?,?,?,?)",
                            (fid, sy["name"], sy["kind"], sy["line"], sy["sig"], sy["parent"]))
                lombok += 1
        def _ins_acc(r, fid=fid):
            nonlocal accs
            con.execute("INSERT INTO db_access(file_id, tbl, kind, mode, line, detail) VALUES(?,?,?,?,?,?)",
                        (fid, r["table"], r.get("kind", "sql"), r.get("mode", "rw"), r["line"], r.get("detail", "extension")))
            accs += 1
        run_x("dbAccess", (text, {"entity_tables": entity_tables, "constants": constants, "relpath": rel}), _ins_acc)
    if defs or accs:
        log.info("DB: %d schema ops, %d access sites, %d entities", defs, accs, len(entity_tables))
    if lombok:
        log.info("Lombok: %d generated members synthesized", lombok)

    scoped_delete("http_endpoints")
    scoped_delete("http_calls")
    eps = hcalls = 0
    for rel in javaish:
        if not in_scope(rel):
            continue
        text = read_text(rel)
        fid = id_by_path.get(rel)
        if not fid or text is None or not re.search(r"Mapping|RestTemplate|WebClient|FeignClient", text):
            continue
        e_list, c_list = extract_java_http(text)
        for e in e_list:
            con.execute("INSERT INTO http_endpoints(file_id, method, path, norm, line, detail) VALUES(?,?,?,?,?,?)",
                        (fid, e["method"], e["path"], e["norm"], e["line"], e["detail"]))
            eps += 1
        for c in c_list:
            con.execute("INSERT INTO http_calls(file_id, method, path, norm, line, client) VALUES(?,?,?,?,?,?)",
                        (fid, c["method"], c["path"], c["norm"], c["line"], c["client"]))
            hcalls += 1
        def _ins_ep(e2, fid=fid):
            nonlocal eps
            con.execute("INSERT INTO http_endpoints(file_id, method, path, norm, line, detail) VALUES(?,?,?,?,?,?)",
                        (fid, e2["method"], e2["path"], e2.get("norm", e2["path"]), e2["line"], e2.get("detail", "extension")))
            eps += 1
        def _ins_call(c2, fid=fid):
            nonlocal hcalls
            con.execute("INSERT INTO http_calls(file_id, method, path, norm, line, client) VALUES(?,?,?,?,?,?)",
                        (fid, c2["method"], c2["path"], c2.get("norm", c2["path"]), c2["line"], c2.get("client", "extension")))
            hcalls += 1
        run_x("httpEndpoints", (text, {"relpath": rel}), _ins_ep)
        run_x("httpCalls", (text, {"relpath": rel}), _ins_call)
    for rel in tracked:
        if not re.search(r"\.(ts|tsx|js|jsx|mjs)$", rel) or not in_scope(rel):
            continue
        text = read_text(rel)
        fid = id_by_path.get(rel)
        if not fid or text is None:
            continue
        if not re.search(r"fetch\s*\(|axios|\.(get|post|put|delete|patch)\s*(<[^>]*>)?\s*\(\s*[\x60'\"]", text):
            continue
        for c in extract_ts_http(text):
            con.execute("INSERT INTO http_calls(file_id, method, path, norm, line, client) VALUES(?,?,?,?,?,?)",
                        (fid, c["method"], c["path"], c["norm"], c["line"], c["client"]))
            hcalls += 1
    if eps or hcalls:
        log.info("HTTP: %d endpoints, %d client calls", eps, hcalls)
    for p in dirty:
        h = hash_by_path.get(p)
        if h:
            con.execute(
                "INSERT OR REPLACE INTO extract_cache(path, hash, constants, entities) VALUES(?,?,"
                "COALESCE((SELECT constants FROM extract_cache WHERE path=?),'{}'),"
                "COALESCE((SELECT entities FROM extract_cache WHERE path=?),'{}'))", (p, h, p, p))

    # ---- Assertions: facts an assistant derived where static analysis is blind ----
    from http_extract import normalize_path as _np
    con.execute("DELETE FROM assertions")
    for t in ("msg_edges", "db_access", "http_endpoints", "http_calls"):
        con.execute(f"DELETE FROM {t} WHERE source LIKE 'asserted%'")
    af = REPO_ROOT / "docs" / "graph-assertions.json"
    try:
        alist = json.loads(af.read_text())
    except Exception:  # noqa: BLE001
        alist = []
    if isinstance(alist, list) and alist:
        loaded = stale = 0
        for a in alist:
            fr = con.execute("SELECT id, hash FROM files WHERE path=?", (a.get("file"),)).fetchone()
            src = f"asserted:{a.get('author', 'assistant')}"
            con.execute("INSERT INTO assertions(kind, payload, file_path, line, evidence, confidence, author, source_hash, created_at) "
                        "VALUES(?,?,?,?,?,?,?,?,?)",
                        (a.get("kind"), json.dumps(a), a.get("file"), a.get("line"), a.get("evidence"),
                         a.get("confidence", "medium"), a.get("author", "assistant"), a.get("source_hash"), time.time()))
            if a.get("source_hash") and fr and fr[1] != a["source_hash"]:
                stale += 1
            if not fr:
                continue
            k = a.get("kind")
            if k == "kafka" and a.get("topic") and a.get("direction"):
                con.execute("INSERT INTO msg_edges(file_id, topic, direction, line, resolved, via, source) VALUES(?,?,?,?,1,?,?)",
                            (fr[0], a["topic"], a["direction"], a.get("line", 0), "assertion", src))
            elif k == "db" and a.get("table"):
                con.execute("INSERT INTO db_access(file_id, tbl, kind, mode, line, detail, source) VALUES(?,?,?,?,?,?,?)",
                            (fr[0], a["table"], "sql", a.get("mode", "rw"), a.get("line", 0), "assertion", src))
            elif k == "http_endpoint" and a.get("path"):
                con.execute("INSERT INTO http_endpoints(file_id, method, path, norm, line, detail, source) VALUES(?,?,?,?,?,?,?)",
                            (fr[0], a.get("method", "GET"), a["path"], _np(a["path"]), a.get("line", 0), "assertion", src))
            elif k == "http_call" and a.get("path"):
                con.execute("INSERT INTO http_calls(file_id, method, path, norm, line, client, source) VALUES(?,?,?,?,?,?,?)",
                            (fr[0], a.get("method", "GET"), a["path"], _np(a["path"]), a.get("line", 0), "assertion", src))
            loaded += 1
        log.info("Assertions: %d loaded into the graph%s", loaded,
                 f", {stale} STALE (evidence file changed since)" if stale else "")

    # ---- Mnemosyne: decision memory from ADR files ----
    con.execute("DELETE FROM decisions")
    con.execute("DELETE FROM decision_links")
    topics_all = {r[0] for r in con.execute("SELECT DISTINCT topic FROM msg_edges")}
    tables_all = {r[0] for r in con.execute("SELECT DISTINCT tbl FROM db_defs UNION SELECT DISTINCT tbl FROM db_access")}
    modules_all = {p.split("/")[0] for p in tracked}
    recs = []
    for rel in tracked:
        if not (re.search(r"(^|/)adr/.*\.md$", rel, re.I) or re.search(r"ADR-[\w-]+\.md$", rel, re.I)):
            continue
        text = read_text(rel)
        if text is None:
            continue
        idm = re.search(r"(ADR-[\w.]+?)(?:[-_][\w-]*)?\.md$", rel, re.I) or re.search(r"#\s*(ADR-[\w.]+)", text, re.I)
        if not idm:
            continue
        did = idm.group(1).upper()
        tm = re.search(r"^#\s*ADR-[\w.]+\s*[:, -]\s*(.+)$", text, re.M) or re.search(r"^#\s*(.+)$", text, re.M)
        title = (tm.group(1) if tm else did).strip()
        sm = re.search(r"^\s*Status\s*:\s*(\w+)", text, re.I | re.M)
        status = (sm.group(1) if sm else "accepted").lower()
        dm = re.search(r"^\s*Date\s*:\s*(\d{4}-\d{2}-\d{2})", text, re.I | re.M)
        decided = dm.group(1) if dm else None
        if not decided:
            try:
                import datetime
                decided = datetime.date.fromtimestamp(abs_path(rel).stat().st_mtime).isoformat()
            except OSError:
                decided = None
        sup = re.search(r"Supersedes\s*:?\s*(ADR-[\w.]+)", text, re.I)
        supersedes = sup.group(1).upper() if sup else None
        sm2 = re.search(r"^\s*(?:##\s*)?Decision\s*:?\s*\n+([\s\S]{0,400}?)(?:\n#|\n\n#|$)", text, re.I | re.M)
        summary = re.sub(r"\s+", " ", (sm2.group(1) if sm2 else " ".join(text.split("\n")[1:5]))).strip()[:400]
        links = [("topic", t) for t in topics_all if t and t in text]
        links += [("table", t) for t in tables_all if t and re.search(rf"\b{re.escape(t)}\b", text, re.I)]
        links += [("module", m) for m in modules_all if m and m in text]
        recs.append({"id": did, "title": title, "status": status, "decided": decided,
                     "supersedes": supersedes, "rel": rel, "summary": summary, "links": links,
                     "valid_until": None, "superseded_by": None})
    by_id = {r["id"]: r for r in recs}
    for r in recs:
        old = by_id.get(r["supersedes"]) if r["supersedes"] else None
        if old:
            old["valid_until"] = r["decided"]
            old["superseded_by"] = r["id"]
            if old["status"] == "accepted":
                old["status"] = "superseded"
    for r in recs:
        con.execute("INSERT OR REPLACE INTO decisions(id, title, status, decided_at, valid_until, superseded_by, source_path, summary) VALUES(?,?,?,?,?,?,?,?)",
                    (r["id"], r["title"], r["status"], r["decided"], r["valid_until"], r["superseded_by"], r["rel"], r["summary"]))
        for k, t in r["links"]:
            con.execute("INSERT INTO decision_links(decision_id, kind, target) VALUES(?,?,?)", (r["id"], k, t))
    if recs:
        log.info("Mnemosyne: %d decisions (%d active)", len(recs), sum(1 for r in recs if not r["valid_until"]))

    # ---- plugin passes: .ariadne/extensions/*.pass.py with run(ctx) ----
    ext = DB_DIR / "extensions"
    if ext.exists():
        import importlib.util
        for f in sorted(ext.glob("*.pass.py")):
            try:
                spec = importlib.util.spec_from_file_location(f.stem.replace(".", "_"), f)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                if hasattr(mod, "run"):
                    mod.run({"con": con, "tracked": tracked, "read_text": read_text,
                             "id_by_path": id_by_path, "in_scope": in_scope, "log": log})
                    log.info("extension pass: %s", f.name)
            except Exception as e:  # noqa: BLE001
                log.warning("extension %s failed: %s", f.name, e)


def current_sha(root=None):
    return subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True,
                          text=True, cwd=root or ROOTS[0]).stdout.strip()


def stamp_all(con):
    for root in ROOTS:
        key = f"last_sha:{root.name if MULTI else '.'}"
        con.execute("INSERT OR REPLACE INTO meta VALUES(?, ?)", (key, current_sha(root)))
    con.execute("INSERT OR REPLACE INTO meta VALUES('last_sha', ?)", (current_sha(),))


def full_index(con, rebuild=False):
    t0 = time.time()
    if rebuild:
        # Deleting files cascade-wipes every correlation row, so the extraction cache
        # must go too, otherwise the passes compare hashes, conclude "nothing changed",
        # and rebuild into an empty graph.
        con.execute("DELETE FROM files")
        con.execute("DELETE FROM chunks")
        try:
            con.execute("DELETE FROM extract_cache")
            con.execute("DELETE FROM meta WHERE key='config_fp'")
        except sqlite3.OperationalError:
            pass
    files = list(repo_files())
    tracked = set(files)
    removed = 0
    for (p,) in con.execute("SELECT path FROM files").fetchall():
        if p not in tracked:
            con.execute("DELETE FROM files WHERE path=?", (p,))
            con.execute("DELETE FROM chunks WHERE path=?", (p,))
            removed += 1
    touched, skipped = [], 0
    for rel in files:
        rec = index_file(con, rel, force=rebuild)
        if rec == "unchanged":
            skipped += 1
        elif rec:
            touched.append(rec)
    rebuild_edges(con, touched)
    kafka_pass(con, None)
    stamp_all(con)
    con.execute("INSERT OR REPLACE INTO meta VALUES('last_run', ?)", (str(time.time()),))
    con.commit()
    log.info("Full index: %d (re)indexed, %d unchanged (cached), %d removed of %d tracked in %dms",
             len(touched), skipped, removed, len(files), int((time.time() - t0) * 1000))


def incremental_index(con):
    changed, deleted = [], []
    for root in ROOTS:
        prefix = root.name if MULTI else ""
        key = f"last_sha:{prefix or '.'}"
        row = con.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone() \
            or con.execute("SELECT value FROM meta WHERE key='last_sha'").fetchone()
        if not row or not row[0]:
            return full_index(con)
        r = subprocess.run(["git", "diff", "--name-status", row[0], "HEAD"],
                           capture_output=True, text=True, cwd=root)
        if r.returncode != 0:
            return full_index(con)
        pref = (lambda x: f"{prefix}/{x}" if prefix else x)
        for line in r.stdout.splitlines():
            parts = line.split("\t")
            status = parts[0]
            if status.startswith("R") and len(parts) == 3:
                deleted.append(pref(parts[1])); changed.append(pref(parts[2]))
            elif status == "D":
                deleted.append(pref(parts[1]))
            else:
                changed.append(pref(parts[-1]))
    changed = [p for p in changed if Path(p).suffix.lower() in LANG_BY_EXT
               and not any(s in Path(p).parts for s in SKIP_DIRS)]
    if len(changed) > max(50, 0.4 * (con.execute("SELECT COUNT(*) FROM files").fetchone()[0] or 1)):
        return full_index(con)
    for p in deleted:
        con.execute("DELETE FROM files WHERE path=?", (p,))
        con.execute("DELETE FROM chunks WHERE path=?", (p,))
    touched = []
    for p in changed:
        rec = index_file(con, p)
        if rec and rec != "unchanged":
            touched.append(rec)
    rebuild_edges(con, touched)
    changed_prefixes = {(p.split("/")[0] if MULTI else "") for p in (changed + deleted)}
    kafka_pass(con, changed_prefixes)
    stamp_all(con)
    con.execute("INSERT OR REPLACE INTO meta VALUES('last_run', ?)", (str(time.time()),))
    con.commit()
    log.info("Incremental index: %d changed, %d deleted.", len(changed), len(deleted))


def status(con):
    f = con.execute("SELECT COUNT(*) FROM files").fetchone()[0]
    s = con.execute("SELECT COUNT(*) FROM symbols").fetchone()[0]
    e = con.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
    sha = (con.execute("SELECT value FROM meta WHERE key='last_sha'").fetchone() or ["-"])[0]
    print(f"files={f} symbols={s} edges={e} last_sha={sha[:12]} db={DB_PATH}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--incremental", action="store_true")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--rebuild", action="store_true")
    args = ap.parse_args()
    if MULTI:
        log.info("Workspace mode: %d repos: %s", len(ROOTS), ", ".join(r.name for r in ROOTS))
    if args.full or args.incremental or args.rebuild:
        pass  # AST engine is initialized lazily, on the first code file that needs it
        if not acquire_lock():
            log.info("Another indexer run is in progress; exiting cleanly.")
            sys.exit(0)
        try:
            con = connect()
            incremental_index(con) if args.incremental else full_index(con, rebuild=args.rebuild)
        except Exception:
            log.exception("Indexing failed")
            sys.exit(1)
        finally:
            release_lock()
    else:
        status(connect())
