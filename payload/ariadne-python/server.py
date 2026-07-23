#!/usr/bin/env python3
"""
Ariadne (GraphRAG-style)-style MCP server over the codebase index built by indexer.py.

Exposes compact, token-efficient tools for retrieving code knowledge:
graph traversal (dependencies, dependents, blast radius), symbol lookup,
and lexical full-text search, so agents pull a few precise rows instead
of reading whole files.

Run (stdio): python3 server.py
Requires: pip install "mcp[cli]"
"""

import asyncio
import functools
import inspect
import json
import hashlib
import os
import re
import sqlite3
import sys
import subprocess
import threading
import time
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from mcp.server.lowlevel import NotificationOptions
from mcp.types import ToolAnnotations
from pydantic import AnyUrl

REPO_ROOT = Path(
    subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
    or "."
).resolve()
DB_PATH = Path(os.environ.get("ARIADNE_HOME", REPO_ROOT)) / ".ariadne" / "index.db"

mcp = FastMCP("ariadne")

# ---- MCP tool annotations: free metadata that lets hosts parallelize reads
# and gate writes. RO/WR mirror the Node edition exactly (suite-pinned).
# Extension tools are NOT annotated: their read/write behavior is unknown here,
# and a wrong hint is worse than no hint.
RO = ToolAnnotations(readOnlyHint=True)
WR = ToolAnnotations(readOnlyHint=False, destructiveHint=False)

# ---- result budget: no single tool call may flood the model's context ----
try:
    _cfg = json.loads((DB_PATH.parent / "config.json").read_text(encoding="utf-8"))
except Exception:  # noqa: BLE001
    _cfg = {}
MAX_ROWS = _cfg.get("maxToolRows", 50)
MAX_BYTES = _cfg.get("maxToolBytes", 24000)
SUMMARY_THRESHOLD = _cfg.get("summaryThreshold", 40)


def _has_warning(r):
    return isinstance(r, dict) and any(k in r for k in
                                       ("warning", "warnings", "unresolved_expressions", "unmatched_calls"))


def budget(result):
    """Cap rows and bytes. Warning-bearing entries are kept FIRST and never dropped.
    a truncated dump that silently discards the drift warning is worse than useless."""
    if isinstance(result, list) and len(result) > MAX_ROWS:
        total = len(result)
        warned = [r for r in result if _has_warning(r)]
        plain = [r for r in result if not _has_warning(r)]
        kept = (warned + plain)[:MAX_ROWS]
        result = {"showing": len(kept), "of": total,
                  "note": "Truncated to protect context (warnings kept first, never dropped). "
                          "Narrow with a filter argument, or raise 'limit'.",
                  "results": kept}
    out = result if isinstance(result, str) else json.dumps(result, indent=1)
    if len(out) > MAX_BYTES:
        out = out[:MAX_BYTES] + (f"\n\n… [truncated at {MAX_BYTES} chars to protect context. "
                                 "Narrow the query, pass a filter argument, or query one item at a time.]")
    return out


_raw_tool = mcp.tool


def _budgeted_tool(*a, **k):
    deco = _raw_tool(*a, **k)

    def wrap(fn):
        if inspect.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def ainner(*args, **kwargs):
                return budget(await fn(*args, **kwargs))
            return deco(ainner)

        @functools.wraps(fn)
        def inner(*args, **kwargs):
            return budget(fn(*args, **kwargs))
        return deco(inner)
    return wrap


mcp.tool = _budgeted_tool

_orig_tool = mcp.tool
def _safe_tool(*d_args, **d_kwargs):
    deco = _orig_tool(*d_args, **d_kwargs)
    def wrapper(fn):
        import functools
        if inspect.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def aguarded(*args, **kwargs):
                try:
                    return await fn(*args, **kwargs)
                except Exception as e:  # surface errors to the agent, never crash
                    return f"Error in {fn.__name__}: {e}"
            return deco(aguarded)
        @functools.wraps(fn)
        def guarded(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except Exception as e:  # surface errors to the agent, never crash
                return f"Error in {fn.__name__}: {e}"
        return deco(guarded)
    return wrapper
mcp.tool = _safe_tool


# Read-only connections cached per thread (FastMCP runs sync tools in a worker
# pool, and sqlite3 objects default to single-thread use). WAL readers see every
# indexer commit through a long-lived handle, so per-call reopen+pragma (the old
# shape) bought nothing — except after corruption recovery, when the indexer
# REPLACES the db file; the (st_ino, st_dev) check catches that, and a failing
# handle is dropped and reopened. Mirror of Node's withDb reopen-on-error.
_ro_local = threading.local()


def db():
    """Cached read-only connection; reopened when the index file is replaced or
    the handle errors. All tools catch exceptions and return messages, so the
    agent can adapt instead of the server crashing."""
    if not DB_PATH.exists():
        _ro_local.con = None
        raise RuntimeError("Index not found. Run: python3 .ariadne/indexer.py --full (or indexer.mjs for the Node edition)")
    st = DB_PATH.stat()
    sig = (st.st_ino, st.st_dev)
    con = getattr(_ro_local, "con", None)
    if con is not None and getattr(_ro_local, "sig", None) == sig:
        try:
            con.execute("SELECT 1")
            return con
        except sqlite3.Error:
            try:
                con.close()
            except sqlite3.Error:
                pass
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=10)
    con.execute("PRAGMA busy_timeout=5000")
    con.row_factory = sqlite3.Row
    _ro_local.con, _ro_local.sig = con, sig
    return con


def wdb():
    """Writer connection for the save_* tools. Refuses to implicitly create a
    missing index (a bare sqlite3.connect would), and waits out the indexer's
    write lock like the Node edition (10s) instead of failing instantly with
    SQLITE_BUSY (sqlite3's default busy timeout is 0)."""
    if not DB_PATH.exists():
        raise RuntimeError("Index not found. Run: python3 .ariadne/indexer.py --full (or indexer.mjs for the Node edition)")
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.execute("PRAGMA busy_timeout=10000")
    return con


def fmt(rows):
    # Structured on purpose: the budget() wrapper row-caps lists (warnings first)
    # and serializes; pre-serializing here would bypass that protection entirely.
    return [dict(r) for r in rows]


def _payload_version():
    """The payload's version identity (from pyproject.toml beside this file),
    surfaced by index_status so 'which Ariadne is this workspace running?' is
    a tool call, not archaeology."""
    try:
        m = re.search(r'^version\s*=\s*"([^"]+)"',
                      (Path(__file__).resolve().parent / "pyproject.toml").read_text(encoding="utf-8"), re.M)
        return m.group(1) if m else "unknown"
    except OSError:
        return "unknown"


def _status_data():
    """Shared with the ariadne://status resource and the release-check prompt:
    one implementation of "how fresh is the graph", never three drifting copies."""
    con = db()
    f = con.execute("SELECT COUNT(*) c FROM files").fetchone()["c"]
    s = con.execute("SELECT COUNT(*) c FROM symbols").fetchone()["c"]
    e = con.execute("SELECT COUNT(*) c FROM edges").fetchone()["c"]
    sha = con.execute("SELECT value FROM meta WHERE key='last_sha'").fetchone()
    head = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=REPO_ROOT).stdout.strip()
    indexed = sha["value"] if sha else None
    return {"files": f, "symbols": s, "edges": e,
            "indexed_sha": indexed, "head_sha": head,
            "fresh": indexed == head, "payload_version": _payload_version()}


@mcp.tool(annotations=RO)
def index_status() -> str:
    """Check index freshness: file/symbol/edge counts and the git SHA the index was built at. Call this first if results seem stale."""
    return _status_data()


@mcp.tool(annotations=RO)
def search_code(query: str, limit: int = 8) -> str:
    """Full-text search over all code. Returns matching chunks with path and start line. Use for 'where is X handled/configured/used' questions instead of reading files."""
    con = db()
    safe = '"' + query.replace('"', '""') + '"'
    rows = con.execute(
        "SELECT path, start_line, snippet(chunks, 2, '>>>', '<<<', ' … ', 24) AS snippet "
        "FROM chunks WHERE chunks MATCH ? ORDER BY rank LIMIT ?",
        (safe, min(limit, 25))).fetchall()
    encl = con.execute
    out = []
    for r in rows:
        e = con.execute("SELECT s.name, s.parent FROM symbols s JOIN files f ON f.id=s.file_id "
                        "WHERE f.path=? AND s.line<=? ORDER BY s.line DESC LIMIT 1",
                        (r["path"], r["start_line"])).fetchone()
        d2 = dict(r)
        if e:
            d2["in_symbol"] = (e["parent"] + "." if e["parent"] else "") + e["name"]
        out.append(d2)
    return out if out else "No matches."


def _resolve_target(con, target):
    """Resolve a target (file path, symbol name, or fragment) to a file row —
    shared by context_pack and the /aegis-impact prompt."""
    file = con.execute("SELECT id, path FROM files WHERE path=?", (target,)).fetchone()
    symbol = None
    if not file:
        sym = con.execute(
            "SELECT s.name, s.parent, s.kind, s.line, f.id fid, f.path FROM symbols s JOIN files f ON f.id=s.file_id "
            "WHERE s.name=? OR (s.parent || '.' || s.name)=? ORDER BY (s.kind='class') DESC LIMIT 1",
            (target, target)).fetchone()
        if sym:
            symbol = sym
            file = {"id": sym["fid"], "path": sym["path"]}
    if not file:
        file = con.execute("SELECT id, path FROM files WHERE path LIKE ? LIMIT 1", (f"%{target}%",)).fetchone()
    return (file, symbol) if file else None


@mcp.tool(annotations=RO)
def context_pack(target: str) -> str:
    """ONE call that assembles everything relevant to working on a target (file path, class, or method): outline, callers, blast radius, the Kafka topics / DB tables / HTTP endpoints it touches, the decisions governing those, and any cached insight. Use INSTEAD of six separate lookups when starting work."""
    con = db()
    hit = _resolve_target(con, target)
    if not hit:
        return f"Target '{target}' not found. Try find_symbol or search_code first."
    file, symbol = hit

    fid, fpath = file["id"], file["path"]
    mod = fpath.split("/")[0]
    cap = lambda a, n: (a[:n] + [f"…and {len(a) - n} more"]) if len(a) > n else a  # noqa: E731

    outline = [f"{(r['parent'] + '.') if r['parent'] else ''}{r['name']}:{r['kind']}@{r['line']}"
               for r in con.execute("SELECT name, kind, line, parent FROM symbols WHERE file_id=? ORDER BY line LIMIT 25", (fid,))]
    callers = []
    if symbol:
        callers = [f"{r['caller']} ({r['path']}:{r['line']})" for r in con.execute(
            "SELECT s.name caller, f.path, c.line FROM calls c JOIN symbols s ON s.id=c.src_symbol "
            "JOIN files f ON f.id=s.file_id WHERE c.callee=? LIMIT 15", (symbol["name"],))]
    dep_count = con.execute("SELECT COUNT(*) c FROM edges WHERE dst=?", (fid,)).fetchone()["c"]
    dependents = [r[0] for r in con.execute(
        "SELECT f2.path FROM edges e JOIN files f2 ON f2.id=e.src WHERE e.dst=? LIMIT 15", (fid,))]
    topics = [f"{r['direction']} {r['topic']}" for r in con.execute(
        "SELECT DISTINCT topic, direction FROM msg_edges WHERE file_id=?", (fid,))]
    tables = [f"{r['mode']} {r['tbl']}" for r in con.execute(
        "SELECT DISTINCT tbl, mode FROM db_access WHERE file_id=?", (fid,))]
    defines = [f"{r['method']} {r['path']}" for r in con.execute(
        "SELECT method, path FROM http_endpoints WHERE file_id=? LIMIT 15", (fid,))]
    hcalls = [f"{r['method']} {r['path']}" for r in con.execute(
        "SELECT method, path FROM http_calls WHERE file_id=? LIMIT 15", (fid,))]

    govern = []
    try:
        tgts = [t.split(" ", 1)[1] for t in topics] + [t.split(" ", 1)[1] for t in tables] + [mod]
        if tgts:
            marks = ",".join("?" * len(tgts))
            govern = [f"{r['id']}: {r['title']}" for r in con.execute(
                f"SELECT DISTINCT dc.id, dc.title FROM decision_links dl JOIN decisions dc ON dc.id=dl.decision_id "
                f"WHERE dl.target IN ({marks}) AND dc.valid_until IS NULL", tgts)]
    except sqlite3.Error:
        pass
    insight = None
    try:
        row = con.execute("SELECT summary FROM insights WHERE target=? OR target=? LIMIT 1", (fpath, mod)).fetchone()
        insight = row["summary"] if row else None
    except sqlite3.Error:
        pass

    # which tests import this target, and the behaviors they assert
    tests = "none found — no test imports this target"
    try:
        tf = [r["path"] for r in con.execute(
            "SELECT DISTINCT f2.path FROM edges e JOIN files f2 ON f2.id=e.src "
            "WHERE e.dst=? AND f2.is_test=1 LIMIT 5", (fid,))]
        if tf:
            marks = ",".join("?" * len(tf))
            # jest strings are already prose; camelCase/snake_case method names get decamelized
            decamel = lambda s: s if " " in s else re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s).replace("_", " ").lower()  # noqa: E731
            behaviors = [decamel(r["name"]) for r in con.execute(
                f"SELECT tc.name FROM test_cases tc JOIN files f2 ON f2.id=tc.file_id "
                f"WHERE f2.path IN ({marks}) LIMIT 5", tf)]
            tests = {"files": tf, "behaviors": behaviors}
    except sqlite3.Error:
        pass  # files.is_test / test_cases may predate this index build

    return {
        "target": (f"{(symbol['parent'] + '.') if symbol and symbol['parent'] else ''}{symbol['name']} ({symbol['kind']})"
                   if symbol else fpath),
        "file": fpath + (f":{symbol['line']}" if symbol else ""),
        "module": mod,
        "outline": cap(outline, 25),
        "callers": callers or "none recorded (heuristic; use find_references for certainty)",
        "blast_radius": {"direct_dependents": dep_count, "sample": dependents},
        "kafka": topics or "none",
        "database": tables or "none",
        "http": {"defines": defines, "calls": hcalls},
        "governing_decisions": govern or "none recorded",
        "cached_insight": insight or "none, run enrichment, or synthesize and save_insight",
        "tests": tests,
        "next": "Focused context for this target. Go deeper only where needed: find_references (certainty), "
                "blast_radius (full list), message_flow/db_map/http_map (the other side of a seam).",
    }


@mcp.tool(annotations=RO)
def find_symbol(name: str, exact: bool = False) -> str:
    """Look up functions/classes/types by name (substring by default). Returns kind, signature, file, and line, enough to reference or jump to it without reading the file."""
    con = db()
    q = name if exact else f"%{name}%"
    op = "=" if exact else "LIKE"
    rows = con.execute(
        f"SELECT s.name, s.kind, s.signature, s.parent, f.path, s.line FROM symbols s "
        f"JOIN files f ON f.id=s.file_id WHERE s.name {op} ? ORDER BY s.name LIMIT 30",
        (q,)).fetchall()
    return fmt(rows) if rows else "No symbol found."


@mcp.tool(annotations=RO)
def file_outline(path: str) -> str:
    """Get a file's skeleton: language, line count, all symbols with signatures, plus its imports and importers. Use INSTEAD of reading the file when you only need its structure."""
    con = db()
    f = con.execute("SELECT * FROM files WHERE path=?", (path,)).fetchone()
    if not f:
        return "File not in index."
    syms = con.execute("SELECT name, kind, line, signature, parent FROM symbols WHERE file_id=? ORDER BY line",
                       (f["id"],)).fetchall()
    deps = con.execute("SELECT f2.path FROM edges e JOIN files f2 ON f2.id=e.dst WHERE e.src=?",
                       (f["id"],)).fetchall()
    dependents = con.execute("SELECT f2.path FROM edges e JOIN files f2 ON f2.id=e.src WHERE e.dst=?",
                             (f["id"],)).fetchall()
    return {"path": path, "lang": f["lang"], "lines": f["lines"],
            "symbols": [dict(s) for s in syms],
            "imports": [d["path"] for d in deps],
            "imported_by": [d["path"] for d in dependents]}


def _blast_data(con, path, depth):
    """Reverse-dependency BFS — shared by the blast_radius tool, the
    /aegis-impact prompt, and change_check. None when the file is not indexed."""
    f = con.execute("SELECT id FROM files WHERE path=?", (path,)).fetchone()
    if not f:
        return None
    has_test = con.execute("SELECT COUNT(*) FROM pragma_table_info('files') WHERE name='is_test'").fetchone()[0]
    frontier, seen, levels = {f["id"]}, {f["id"]}, []
    tests_affected = set()
    for _ in range(depth):
        if not frontier:
            break
        marks = ",".join("?" * len(frontier))
        rows = con.execute(
            f"SELECT DISTINCT e.src, f2.path{', f2.is_test' if has_test else ''} FROM edges e JOIN files f2 ON f2.id=e.src "
            f"WHERE e.dst IN ({marks})", tuple(frontier)).fetchall()
        frontier = {r["src"] for r in rows} - seen
        seen |= frontier
        # tests ride along in the traversal but stay out of the production counts
        for r in rows:
            if has_test and r["is_test"]:
                tests_affected.add(r["path"])
        prod = [r for r in rows if not (has_test and r["is_test"])]
        if prod:
            levels.append(sorted({r["path"] for r in prod}))
    total = sum(len(x) for x in levels)
    out = {"file": path, "affected_total": total, "by_depth": levels}
    if has_test:
        out["tests_affected"] = sorted(tests_affected)
        out["tests_affected_total"] = len(tests_affected)
    return out


@mcp.tool(annotations=RO)
def blast_radius(path: str, depth: int = 2) -> str:
    """Find everything that transitively depends on a file (reverse dependency BFS up to `depth`). Call BEFORE modifying shared code to know what to re-test."""
    con = db()
    return _blast_data(con, path, max(1, min(depth, 5))) or "File not in index."


@mcp.tool(annotations=RO)
def dependencies(path: str) -> str:
    """List what a file imports (its direct dependencies in this repo)."""
    con = db()
    rows = con.execute(
        "SELECT f2.path FROM files f JOIN edges e ON e.src=f.id JOIN files f2 ON f2.id=e.dst "
        "WHERE f.path=?", (path,)).fetchall()
    return [r["path"] for r in rows] if rows else "No in-repo dependencies found."


@mcp.tool(annotations=RO)
def module_map(prefix: str = "") -> str:
    """Directory-level overview: for each top-level directory (or under `prefix`), file count, main languages, and symbol count. Use as the first call to orient in an unfamiliar repo."""
    con = db()
    rows = con.execute("SELECT path, lang FROM files WHERE path LIKE ?", (f"{prefix}%",)).fetchall()
    agg = {}
    strip = len(prefix)
    for r in rows:
        rest = r["path"][strip:].lstrip("/")
        top = rest.split("/")[0] if "/" in rest else "(root files)"
        a = agg.setdefault(top, {"files": 0, "langs": {}})
        a["files"] += 1
        a["langs"][r["lang"]] = a["langs"].get(r["lang"], 0) + 1
    return [{"dir": (prefix + "/" + k).strip("/") or k, "files": v["files"],
             "langs": sorted(v["langs"], key=v["langs"].get, reverse=True)[:3]}
            for k, v in sorted(agg.items())]


@mcp.tool(annotations=RO)
def hotspots(limit: int = 10) -> str:
    """The most-depended-on files in the repo (highest in-degree). These are the highest-risk files to change and the best places to start understanding the architecture."""
    con = db()
    rows = con.execute(
        "SELECT f.path, COUNT(e.src) dependents FROM files f JOIN edges e ON e.dst=f.id "
        "GROUP BY f.id ORDER BY dependents DESC LIMIT ?", (min(limit, 30),)).fetchall()
    return fmt(rows)


@mcp.tool(annotations=RO)
def find_callers(name: str, limit: int = 40) -> str:
    """AST-based: who calls this function/method? Heuristic (matched by name); for compiler-resolved precision use find_references (SCIP)."""
    con = db()
    rows = con.execute(
        "SELECT s.name AS caller, s.parent, f.path, c.line FROM calls c "
        "JOIN symbols s ON s.id=c.src_symbol JOIN files f ON f.id=s.file_id "
        "WHERE c.callee=? ORDER BY f.path, c.line LIMIT ?", (name, min(limit, 100))).fetchall()
    return fmt(rows) if rows else "No callers recorded (AST may not cover this language; try find_references)."


@mcp.tool(annotations=RO)
def find_callees(name: str) -> str:
    """AST-based: what does this function/method call? Heuristic (by name)."""
    con = db()
    rows = con.execute(
        "SELECT DISTINCT c.callee, c.line FROM calls c JOIN symbols s ON s.id=c.src_symbol "
        "WHERE s.name=? ORDER BY c.line LIMIT 60", (name,)).fetchall()
    return fmt(rows) if rows else "No callees recorded for that symbol."


@mcp.tool(annotations=RO)
def find_references(name: str, limit: int = 40) -> str:
    """COMPILER-GRADE (requires SCIP ingest): find every place a symbol is actually used, resolved by the compiler, not text matching. Give a function/class/method name. Returns definition site + all reference sites."""
    con = db()
    if not con.execute("SELECT name FROM sqlite_master WHERE name='scip_refs'").fetchone():
        return "SCIP data not ingested. Run scip-typescript/scip-java then .ariadne/scip_ingest.py (see README). Falling back: use search_code instead."
    defs = con.execute(
        "SELECT symbol, path, line, docs FROM scip_defs WHERE symbol LIKE ? LIMIT 5",
        (f"%{name}%",)).fetchall()
    if not defs:
        return f"No compiler-resolved definition matching '{name}'. Try find_symbol (regex index) instead."
    out = []
    for d in defs:
        refs = con.execute(
            "SELECT path, line FROM scip_refs WHERE symbol=? ORDER BY path, line LIMIT ?",
            (d["symbol"], min(limit, 100))).fetchall()
        out.append({"symbol": d["symbol"], "defined": f"{d['path']}:{d['line']}",
                    "doc": (d["docs"] or "")[:150],
                    "reference_count": len(refs),
                    "references": [f"{r['path']}:{r['line']}" for r in refs]})
    return out


@mcp.tool(annotations=RO)
def goto_definition(name: str) -> str:
    """COMPILER-GRADE (requires SCIP ingest): jump to the exact definition of a symbol, with its doc comment. More precise than find_symbol for overloaded/common names."""
    con = db()
    if not con.execute("SELECT name FROM sqlite_master WHERE name='scip_defs'").fetchone():
        return "SCIP data not ingested; use find_symbol instead."
    rows = con.execute(
        "SELECT symbol, path, line, docs FROM scip_defs WHERE symbol LIKE ? ORDER BY length(symbol) LIMIT 10",
        (f"%{name}%",)).fetchall()
    return fmt(rows) if rows else "Not found in SCIP index; try find_symbol."


@mcp.tool(annotations=RO)
def explain(target: str) -> str:
    """Cached LLM insight for a module or file: intent, responsibilities, system connections, gotchas. Hash-cached, regenerated only when content changes."""
    con = db()
    if not con.execute("SELECT name FROM sqlite_master WHERE name='insights'").fetchone():
        return ("No insights yet. Run enrichment: python3 .ariadne/enrich.py "
                "(opt-in, supports fully-local models via OPENAI_BASE_URL, see PRIVACY.md).")
    row = con.execute("SELECT * FROM insights WHERE target=? OR target LIKE ? LIMIT 1",
                      (target, f"%{target}%")).fetchone()
    if not row:
        return f"No cached insight for '{target}'. Ask Hermes to derive one from the graph, or run enrich."
    stale = ""
    if row["kind"] == "file":
        f = con.execute("SELECT hash FROM files WHERE path=?", (row["target"],)).fetchone()
        if f and f["hash"] != row["hash"]:
            stale = " [STALE: file changed since this was generated, re-run enrich]"
    return f"{row['kind']} {row['target']} (model: {row['model']}){stale}\n\n{row['summary']}"


@mcp.tool(annotations=RO)
def decisions(query: str = "", target: str = "", status: str = "", as_of: str = "") -> str:
    """Decision memory (Mnemosyne): query architectural decisions with temporal validity. Filter by text, governed target (topic/table/module), status, or as_of (YYYY-MM-DD) for time-travel."""
    con = db()
    if not con.execute("SELECT name FROM sqlite_master WHERE name='decisions'").fetchone():
        return "No decision data; reindex with the current Ariadne"
    rows = con.execute("SELECT * FROM decisions ORDER BY decided_at DESC").fetchall()
    if target:
        ids = {r[0] for r in con.execute("SELECT decision_id FROM decision_links WHERE target LIKE ?", (f"%{target}%",))}
        rows = [r for r in rows if r["id"] in ids]
    if query:
        rows = [r for r in rows if query.lower() in (r["title"] + " " + (r["summary"] or "")).lower()]
    if status:
        rows = [r for r in rows if r["status"] == status.lower()]
    if as_of:
        rows = [r for r in rows if r["decided_at"] and r["decided_at"] <= as_of and (not r["valid_until"] or r["valid_until"] > as_of)]
    if not rows:
        return "No matching decisions. To capture one from this conversation, use save_decision."
    out = []
    for r in rows[:20]:
        governs = [f"{l[0]}:{l[1]}" for l in con.execute("SELECT kind, target FROM decision_links WHERE decision_id=?", (r["id"],))]
        e = {"id": r["id"], "title": r["title"],
             "status": f"valid as of {as_of}" if as_of else r["status"],
             "decided": r["decided_at"], "governs": governs,
             "summary": r["summary"], "source": r["source_path"]}
        if r["valid_until"]:
            e["valid_until"], e["superseded_by"] = r["valid_until"], r["superseded_by"]
        out.append(e)
    return out


@mcp.tool(annotations=RO)
def decision_trace(id: str) -> str:
    """Full lineage of one decision: supersession chain plus governed artifacts with existence check (flags decision drift)."""
    con = db()
    rec = con.execute("SELECT * FROM decisions WHERE id=?", (id.upper(),)).fetchone()
    if not rec:
        return f"No decision '{id}'."
    chain, cur = [], rec
    while cur:
        chain.append(cur)
        cur = con.execute("SELECT * FROM decisions WHERE id=?", (cur["superseded_by"],)).fetchone() if cur["superseded_by"] else None
    back = con.execute("SELECT * FROM decisions WHERE superseded_by=?", (rec["id"],)).fetchone()
    while back:
        chain.insert(0, back)
        back = con.execute("SELECT * FROM decisions WHERE superseded_by=?", (back["id"],)).fetchone()
    topics_all = {r[0] for r in con.execute("SELECT DISTINCT topic FROM msg_edges")}
    tables_all = {r[0] for r in con.execute("SELECT DISTINCT tbl FROM db_access UNION SELECT DISTINCT tbl FROM db_defs")}
    governs = []
    for l in con.execute("SELECT kind, target FROM decision_links WHERE decision_id=?", (rec["id"],)):
        exists = l[1] in topics_all if l[0] == "topic" else l[1] in tables_all if l[0] == "table" else True
        governs.append(f"{l[0]}:{l[1]}" + ("" if exists else "  ⚠️ no longer exists in the graph (decision drift)"))
    return {
        "chain": [f"{c['id']} [{c['status']}] {c['decided_at'] or '?'}" +
                  (f" → until {c['valid_until']}" if c["valid_until"] else " → current") + f": {c['title']}" for c in chain],
        "governs": governs, "summary": rec["summary"], "source": rec["source_path"]}


@mcp.tool(annotations=WR)
def save_decision(title: str, decision: str, rationale: str, alternatives: str = "", supersedes: str = "") -> str:
    """Capture a decision made in this conversation: writes a git-versioned ADR file (docs/adr/) AND indexes it immediately. Use when an architectural/design choice is settled."""
    import datetime
    root = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip() or Path.cwd())
    adr_dir = root / "docs" / "adr"
    adr_dir.mkdir(parents=True, exist_ok=True)
    mx = 0
    for f in adr_dir.iterdir():
        m = re.match(r"ADR-(\d+)", f.name, re.I)
        if m:
            mx = max(mx, int(m.group(1)))
    did = f"ADR-{mx + 1:03d}"
    today = datetime.date.today().isoformat()
    slug = re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", title.lower()))[:60]
    file = adr_dir / f"{did}-{slug}.md"
    body = (f"# {did}: {title}\n\nStatus: Accepted\nDate: {today}\n"
            + (f"Supersedes: {supersedes.upper()}\n" if supersedes else "")
            + f"\n## Decision\n\n{decision}\n\n## Rationale\n\n{rationale}\n"
            + (f"\n## Alternatives considered\n\n{alternatives}\n" if alternatives else "")
            + "\n<!-- captured via AEGIS save_decision -->\n")
    file.write_text(body, encoding="utf-8")
    wcon = wdb()
    try:
        wcon.execute("""CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY, title TEXT, status TEXT,
                        decided_at TEXT, valid_until TEXT, superseded_by TEXT, source_path TEXT, summary TEXT)""")
        wcon.execute("CREATE TABLE IF NOT EXISTS decision_links(decision_id TEXT, kind TEXT, target TEXT)")
        wcon.execute("INSERT OR REPLACE INTO decisions(id, title, status, decided_at, valid_until, superseded_by, source_path, summary) VALUES(?,?,?,?,NULL,NULL,?,?)",
                     (did, title, "accepted", today, str(file.relative_to(root)), decision[:400]))
        if supersedes:
            wcon.execute("UPDATE decisions SET valid_until=?, superseded_by=?, status='superseded' WHERE id=?",
                         (today, did, supersedes.upper()))
        wcon.commit()
    finally:
        wcon.close()
    return f"{did} saved to {file.relative_to(root)} (git-versioned) and indexed; commit the file to share it."


@mcp.tool(annotations=WR)
def save_insight(target: str, kind: str, summary: str) -> str:
    """Persist a derived insight for a module or file into the graph (served by explain, hash-keyed so it auto-stales when content changes). kind: 'module' or 'file'. Use after synthesizing understanding from the graph tools."""
    if kind not in ("module", "file") or len(summary) < 40:
        return "kind must be module|file and summary at least 40 chars."
    wcon = wdb()
    try:
        wcon.execute("""CREATE TABLE IF NOT EXISTS insights(target TEXT PRIMARY KEY, kind TEXT,
                        hash TEXT, summary TEXT, model TEXT, generated_at REAL)""")
        if kind == "file":
            r = wcon.execute("SELECT hash FROM files WHERE path=?", (target,)).fetchone()
            h = (r[0] if r else "") or ""
        else:
            hs = [x[0] or "" for x in wcon.execute("SELECT hash FROM files WHERE path LIKE ? ORDER BY path", (target + "/%",))]
            h = hashlib.sha1("|".join(hs).encode()).hexdigest()
        wcon.execute("INSERT OR REPLACE INTO insights(target, kind, hash, summary, model, generated_at) VALUES(?,?,?,?,?,?)",
                     (target, kind, h, summary[:4000], "assistant", time.time()))
        wcon.commit()
    finally:
        wcon.close()
    return f"Insight saved for {kind} '{target}'."


def _gaps_data(con, n):
    """The gap worklist — shared by the graph_gaps tool and the
    /aegis-resolve-gap and /aegis-release-check prompts (one computation)."""
    from http_extract import paths_match as _pm

    def q(sql, *a):
        try:
            return con.execute(sql, a).fetchall()
        except sqlite3.Error:
            return []

    # gap math is production-only: a test consumer must not cure a dead topic.
    # test coverage surfaces as a `note` on the entry, never as a fix
    has_test = bool(q("SELECT COUNT(*) c FROM pragma_table_info('files') WHERE name='is_test'")[0]["c"])
    prod = " AND f.is_test=0" if has_test else ""

    gaps = {}
    gaps["unresolved_topic_expressions"] = [
        {"expression": r["topic"], "path": r["path"], "line": r["line"],
         "why": "topic name is assembled at runtime, static analysis cannot evaluate it"}
        for r in q("SELECT m.topic, f.path, m.line FROM msg_edges m JOIN files f ON f.id=m.file_id "
                   f"WHERE m.resolved=0{prod} LIMIT ?", n)]
    if has_test:
        per = q("SELECT m.topic, SUM(m.direction='produce') p, SUM(m.direction='consume') c FROM msg_edges m "
                "JOIN files f ON f.id=m.file_id WHERE f.is_test=0 GROUP BY m.topic")
        test_per = {r["topic"]: dict(r) for r in q(
            "SELECT m.topic, SUM(m.direction='produce') p, SUM(m.direction='consume') c FROM msg_edges m "
            "JOIN files f ON f.id=m.file_id WHERE f.is_test=1 GROUP BY m.topic")}
    else:
        per = q("SELECT topic, SUM(direction='produce') p, SUM(direction='consume') c FROM msg_edges GROUP BY topic")
        test_per = {}
    gaps["topics_produced_but_never_consumed"] = [
        {"topic": r["topic"], "why": "no consumer found, dead topic, a consumer outside the workspace, "
                                     "or a dynamic listener the parser missed",
         **({"note": "exercised only by tests"} if test_per.get(r["topic"], {}).get("c") else {})}
        for r in per if r["p"] and not r["c"]][:n]
    gaps["topics_consumed_but_never_produced"] = [
        {"topic": r["topic"], "why": "no producer found, an upstream repo not indexed, or a dynamic producer",
         **({"note": "exercised only by tests"} if test_per.get(r["topic"], {}).get("p") else {})}
        for r in per if r["c"] and not r["p"]][:n]
    # drift and unresolved entries carry no test note: test access neither causes nor cures them
    gaps["tables_accessed_but_undefined"] = [
        {"table_name": r["tbl"], "path": r["path"], "line": r["line"],
         "why": "DRIFT, code touches it but no Liquibase changeset defines it here"}
        for r in q("SELECT DISTINCT a.tbl, f.path, a.line FROM db_access a JOIN files f ON f.id=a.file_id "
                   f"WHERE a.tbl NOT IN (SELECT tbl FROM db_defs){prod} LIMIT ?", n)]
    eps = q("SELECT e.method, e.path, e.norm FROM http_endpoints e"
            + (" JOIN files f ON f.id=e.file_id WHERE f.is_test=0" if has_test else ""))
    calls = q("SELECT c.method, c.norm FROM http_calls c"
              + (" JOIN files f ON f.id=c.file_id WHERE f.is_test=0" if has_test else ""))
    test_calls = q("SELECT c.method, c.norm FROM http_calls c JOIN files f ON f.id=c.file_id WHERE f.is_test=1") if has_test else []
    gaps["endpoints_with_no_caller"] = [
        {"endpoint": f"{e['method']} {e['path']}",
         "why": "nobody in the workspace calls it, dead route, external consumer, or a gateway rewrite",
         **({"note": "exercised only by tests"} if any(
             c["method"] == e["method"] and _pm(c["norm"], e["norm"]) for c in test_calls) else {})}
        for e in eps
        if not any(c["method"] == e["method"] and _pm(c["norm"], e["norm"]) for c in calls)][:n]

    if con.execute("SELECT name FROM sqlite_master WHERE name='msg_topics'").fetchone():
        gaps["topics_declared_in_config_but_unused"] = [
            {"topic": r["topic"], "config_key": r["config_key"],
             "why": f"declared at {r['path']}:{r['line']} but no producer or consumer references it"}
            for r in q("SELECT t.topic, t.config_key, f.path, t.line FROM msg_topics t "
                       "JOIN files f ON f.id=t.file_id "
                       "WHERE t.topic NOT IN (SELECT topic FROM msg_edges) LIMIT ?", n)]
    total = sum(len(v) for v in gaps.values())
    return {
        "summary": (f"{total} things static analysis could not resolve. Investigate the code at each "
                    "location; when you work out the answer, record it with assert_edge so the whole "
                    "team's graph improves.") if total else
                   "No gaps found, static analysis resolved everything it looked at.",
        **gaps}


@mcp.tool(annotations=RO)
def graph_gaps(limit: int = 20) -> str:
    """Where static analysis is BLIND, the graph's own to-do list. Returns dynamic topic/SQL expressions it could not resolve, orphan topics and endpoints, and drift tables, each with file:line. Investigate, then record what you work out with assert_edge. This is how the graph gets better instead of staying wrong."""
    return _gaps_data(db(), min(max(limit, 1), 60))


@mcp.tool(annotations=WR)
def assert_edge(kind: str, file: str, line: int, evidence: str, confidence: str = "medium",
                topic: str = "", direction: str = "", table: str = "", mode: str = "rw",
                method: str = "GET", path: str = "") -> str:
    """Record a fact you DERIVED by reading code that static analysis could not resolve, a runtime-assembled Kafka topic, dynamic SQL, a gateway-rewritten route. kind: kafka|db|http_endpoint|http_call. Writes docs/graph-assertions.json (git-committed and reviewable, like an ADR) and enters the graph tagged with your name, never mistaken for a parsed fact. Requires evidence: quote the code that convinced you."""
    if kind not in ("kafka", "db", "http_endpoint", "http_call"):
        return "kind must be kafka|db|http_endpoint|http_call."
    if len(evidence) < 20:
        return "evidence must explain what convinced you (20+ chars): quote the code."
    if kind == "kafka" and not (topic and direction):
        return "kafka assertions need topic and direction."
    if kind == "db" and not table:
        return "db assertions need table."
    if kind.startswith("http") and not path:
        return "http assertions need path."

    con = db()
    row = con.execute("SELECT hash FROM files WHERE path=?", (file,)).fetchone()
    if not row:
        return f"File '{file}' is not in the index, check the path (repo-prefixed in a multi-repo workspace)."

    root = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True,
                               text=True).stdout.strip() or Path.cwd())
    af = root / "docs" / "graph-assertions.json"
    lst = []
    if af.exists():
        # Never clobber: a malformed file (merge-conflict marker, stray comma) must
        # not silently erase the team's accumulated assertions.
        try:
            lst = json.loads(af.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            return (f"docs/graph-assertions.json exists but is not valid JSON ({e}). "
                    "Fix or remove it first; refusing to overwrite the team's assertions.")
        if not isinstance(lst, list):
            return ("docs/graph-assertions.json is not a JSON array. "
                    "Fix it first; refusing to overwrite the team's assertions.")
    rec = {"kind": kind, "file": file, "line": line, "evidence": evidence, "confidence": confidence,
           "author": "assistant", "source_hash": row["hash"],
           "asserted_at": __import__("datetime").date.today().isoformat()}
    for k, v in (("topic", topic), ("direction", direction), ("table", table),
                 ("mode", mode), ("method", method), ("path", path)):
        if v:
            rec[k] = v
    lst = [x for x in lst if not (x.get("kind") == kind and x.get("file") == file and x.get("line") == line
                                  and x.get("topic") == (topic or None) and x.get("table") == (table or None)
                                  and x.get("path") == (path or None))]
    lst.append(rec)
    af.parent.mkdir(parents=True, exist_ok=True)
    af.write_text(json.dumps(lst, indent=2) + "\n", encoding="utf-8")
    return (f"Asserted and recorded in docs/graph-assertions.json ({len(lst)} total). It enters the graph on "
            f"the next index, tagged 'asserted', never mixed with parsed facts, and marked STALE automatically "
            f"if {file} changes. Commit the file to share it with the team.")


@mcp.tool(annotations=RO)
def message_flow(topic: str = "") -> str:
    """Messaging topology (Kafka, plus RabbitMQ/JMS/SQS/NATS labeled by system): correlate inbound/outbound message handling across modules. No args = full topic map (producers/consumers per topic with file:line, plus orphan warnings). Topics resolved from literals, constants, and application.yaml placeholders."""
    con = db()
    if not con.execute("SELECT name FROM sqlite_master WHERE name='msg_edges'").fetchone():
        return "No message-edge data; reindex with the current Ariadne"
    n_topics = con.execute("SELECT COUNT(DISTINCT topic) FROM msg_edges").fetchone()[0]
    has_test = con.execute("SELECT COUNT(*) FROM pragma_table_info('files') WHERE name='is_test'").fetchone()[0]
    has_decl = bool(con.execute("SELECT name FROM sqlite_master WHERE name='msg_topics'").fetchone())
    if not topic and n_topics > SUMMARY_THRESHOLD:
        # topology is production-only; a topic touched only by tests is a warning, not topology
        if has_test:
            per = con.execute("SELECT m.topic, SUM(m.direction='produce') p, SUM(m.direction='consume') c "
                              "FROM msg_edges m JOIN files f ON f.id=m.file_id WHERE f.is_test=0 GROUP BY m.topic").fetchall()
            test_only = [r[0] for r in con.execute(
                "SELECT DISTINCT m.topic FROM msg_edges m JOIN files f ON f.id=m.file_id WHERE f.is_test=1 "
                "AND m.topic NOT IN (SELECT m2.topic FROM msg_edges m2 JOIN files f2 ON f2.id=m2.file_id WHERE f2.is_test=0)")]
        else:
            per = con.execute("SELECT topic, SUM(direction='produce') p, SUM(direction='consume') c "
                              "FROM msg_edges GROUP BY topic").fetchall()
            test_only = []
        cap = lambda a: (a[:25] + [f"…and {len(a) - 25} more"]) if len(a) > 25 else a  # noqa: E731
        return {
            "summary": f"{len(per)} topics{f' ({len(test_only)} more only in tests)' if test_only else ''}; "
                       f"{sum(r['p'] for r in per)} producer sites, {sum(r['c'] for r in per)} consumer sites.",
            "warnings": {
                "produced_but_never_consumed": cap([r["topic"] for r in per if r["p"] and not r["c"]]),
                "consumed_but_never_produced": cap([r["topic"] for r in per if r["c"] and not r["p"]]),
                **({"topics_only_exercised_by_tests": cap(test_only)} if test_only else {}),
                "unresolved_topic_expressions": con.execute(
                    "SELECT COUNT(*) FROM msg_edges m JOIN files f ON f.id=m.file_id "
                    "WHERE m.resolved=0 AND f.is_test=0").fetchone()[0] if has_test
                else con.execute("SELECT COUNT(*) FROM msg_edges WHERE resolved=0").fetchone()[0],
                # config is the seam's source of truth: a topic declared there that
                # no code touches is drift, like a table defined but never accessed
                **({"declared_in_config_but_unused": cap([r[0] for r in con.execute(
                    "SELECT DISTINCT topic FROM msg_topics WHERE topic NOT IN (SELECT topic FROM msg_edges)")])}
                   if has_decl else {}),
            },
            "busiest_topics": [dict(r) for r in sorted(per, key=lambda r: -(r["p"] + r["c"]))[:10]],
            "next": "Full listing: docs/generated/message-flows.md. For sites on one topic: message_flow topic:<name>.",
        }
    q = ("SELECT m.topic, m.direction, f.path, m.line, m.resolved, m.via, m.system, m.source"
         + (", f.is_test" if has_test else "") + " FROM msg_edges m "
         "JOIN files f ON f.id=m.file_id " + ("WHERE m.topic=? " if topic else "") + "ORDER BY m.topic, m.direction")
    rows = con.execute(q, (topic,) if topic else ()).fetchall()
    if not rows:
        return f"No handlers found for topic '{topic}'." if topic else "No Kafka producers/consumers detected."
    topics = {}
    for r in rows:
        t = topics.setdefault(r["topic"], {"producers": [], "consumers": [], "unresolved": [],
                                           "test_producers": [], "test_consumers": []})
        src = r["source"] if "source" in r.keys() else "static"
        asserted = bool(src) and src != "static"
        sys_ = r["system"] if "system" in r.keys() else "kafka"
        site = (f"{r['path']}:{r['line']}"
                + (f" (via {r['via']})" if r["via"] and not asserted else "")
                + (f"  [{sys_}]" if sys_ and sys_ != "kafka" else "")
                + (f"  [ASSERTED by {src.split(':')[1]}, derived, not parsed]" if asserted else ""))
        if has_test and r["is_test"]:
            t["test_producers" if r["direction"] == "produce" else "test_consumers"].append(
                site + ("" if r["resolved"] else " (unresolved)") + "  [TEST]")
            continue
        if not r["resolved"]:
            t["unresolved"].append(site)
        else:
            t["producers" if r["direction"] == "produce" else "consumers"].append(site)
    out = []
    for name, t in topics.items():
        entry = {"topic": name, "producers": t["producers"], "consumers": t["consumers"]}
        if t["unresolved"]:
            entry["unresolved_expressions"] = t["unresolved"]
        if t["producers"] and not t["consumers"]:
            n_tc = len(t["test_consumers"])
            entry["warning"] = ("produced but no consumer found in this repo"
                                + (f" ({n_tc} test consumer" + (" exists" if n_tc == 1 else "s exist") + ")" if n_tc else ""))
        if t["consumers"] and not t["producers"]:
            n_tp = len(t["test_producers"])
            entry["warning"] = ("consumed but no producer found in this repo"
                                + (f" ({n_tp} test producer" + (" exists" if n_tp == 1 else "s exist") + ")" if n_tp else ""))
        if not t["producers"] and not t["consumers"] and not t["unresolved"] and (t["test_producers"] or t["test_consumers"]):
            entry["warning"] = "only exercised by tests — no production usage in this repo"
        if t["test_producers"] or t["test_consumers"]:
            entry["test_usage"] = {}
            if t["test_producers"]:
                entry["test_usage"]["producers"] = t["test_producers"]
            if t["test_consumers"]:
                entry["test_usage"]["consumers"] = t["test_consumers"]
        out.append(entry)
    # validate the seam against config declarations: link each topic to the
    # config key(s) that declare it, and flag sites that hardcode a declared name
    if has_decl:
        for e in out:
            keys = [r[0] for r in con.execute(
                "SELECT DISTINCT config_key FROM msg_topics WHERE topic=?", (e["topic"],))]
            if not keys:
                continue
            e["config_keys"] = keys
            hard = [s for s in e["producers"] + e["consumers"]
                    if "(via " not in s and "[ASSERTED" not in s]
            if hard:
                e["note"] = (f"config declares this topic ({', '.join(keys)}), but {len(hard)} site(s) "
                             "hardcode the name; hoist to the config key so the seam stays tight")
    return out


@mcp.tool(annotations=RO)
def db_map(table: str = "") -> str:
    """Database topology (Spring Boot + Liquibase): correlate each table with the changesets that shaped it AND every code site touching it (entities, repositories, @Query, JdbcTemplate) with read/write mode. Includes drift warnings. Pass table for one table."""
    con = db()
    if not con.execute("SELECT name FROM sqlite_master WHERE name='db_defs'").fetchone():
        return "No DB-layer data; reindex with the current Ariadne"
    n_tables = con.execute("SELECT COUNT(*) FROM (SELECT tbl FROM db_defs UNION SELECT tbl FROM db_access)").fetchone()[0]
    has_test = con.execute("SELECT COUNT(*) FROM pragma_table_info('files') WHERE name='is_test'").fetchone()[0]
    if not table and n_tables > SUMMARY_THRESHOLD:
        # topology and drift math are production-only; test-only access is its own warning
        prod_acc = ("SELECT a2.tbl tbl FROM db_access a2 JOIN files f2 ON f2.id=a2.file_id WHERE f2.is_test=0"
                    if has_test else "SELECT tbl FROM db_access")
        cap = lambda a: (a[:25] + [f"…and {len(a) - 25} more"]) if len(a) > 25 else a  # noqa: E731
        n_prod = con.execute(f"SELECT COUNT(*) FROM (SELECT tbl FROM db_defs UNION SELECT tbl FROM ({prod_acc}))").fetchone()[0]
        return {
            "summary": f"{n_prod} tables{f' ({n_tables - n_prod} more only in tests)' if n_tables > n_prod else ''}; "
                       f"{con.execute('SELECT COUNT(DISTINCT tbl) FROM db_defs').fetchone()[0]} defined by Liquibase, "
                       f"{con.execute(f'SELECT COUNT(DISTINCT tbl) FROM ({prod_acc})').fetchone()[0]} touched by code.",
            "warnings": {
                "DRIFT_accessed_but_no_changeset": cap([r[0] for r in con.execute(
                    f"SELECT DISTINCT tbl FROM ({prod_acc}) WHERE tbl NOT IN (SELECT tbl FROM db_defs)")]),
                "defined_but_never_accessed": cap([r[0] for r in con.execute(
                    f"SELECT DISTINCT tbl FROM db_defs WHERE tbl NOT IN ({prod_acc})")]),
                **({"accessed_only_by_tests": cap([r[0] for r in con.execute(
                    "SELECT DISTINCT a.tbl FROM db_access a JOIN files f ON f.id=a.file_id "
                    f"WHERE f.is_test=1 AND a.tbl NOT IN ({prod_acc})")])} if has_test else {}),
            },
            "most_accessed_tables": [dict(r) for r in con.execute(
                f"SELECT tbl, COUNT(*) sites FROM ({prod_acc}) GROUP BY tbl ORDER BY sites DESC LIMIT 10")],
            "next": "Full listing: docs/generated/data-map.md. For one table: db_map table:<name>.",
        }
    t = table.lower() if table else None
    defs = con.execute(
        "SELECT d.tbl, d.op, f.path, d.line, d.changeset FROM db_defs d LEFT JOIN files f ON f.id=d.file_id "
        + ("WHERE d.tbl=? " if t else "") + "ORDER BY d.tbl", (t,) if t else ()).fetchall()
    accs = con.execute(
        "SELECT a.tbl, a.kind, a.mode, f.path, a.line, a.detail" + (", f.is_test" if has_test else "")
        + " FROM db_access a JOIN files f ON f.id=a.file_id "
        + ("WHERE a.tbl=? " if t else "") + "ORDER BY a.tbl, a.kind", (t,) if t else ()).fetchall()
    if not defs and not accs:
        return f"No definition or access found for table '{t}'." if t else "No Liquibase changelogs or DB access detected."
    tables = {}
    for r in defs:
        e = tables.setdefault(r["tbl"], {"schema_ops": [], "entity": None, "repositories": [], "sql_sites": []})
        cs = f" [{r['changeset']}]" if r["changeset"] else ""
        e["schema_ops"].append(f"{r['op']} @ {r['path']}:{r['line']}{cs}")
    for r in accs:
        e = tables.setdefault(r["tbl"], {"schema_ops": [], "entity": None, "repositories": [], "sql_sites": []})
        site = f"{r['path']}:{r['line']} ({r['detail']})"
        if has_test and r["is_test"]:
            e.setdefault("test_sites", []).append(f"[{r['mode']}] {site}  [TEST]")
            continue
        if r["kind"] == "entity":
            e["entity"] = site
        elif r["kind"] == "repository":
            e["repositories"].append(site)
        else:
            e["sql_sites"].append(f"[{r['mode']}] {site}")
    out = []
    for name, e in tables.items():
        prod_empty = not e["entity"] and not e["repositories"] and not e["sql_sites"]
        entry = {"table": name, **e}
        if not e["schema_ops"]:
            entry["warning"] = ("DRIFT: accessed by code but no Liquibase changeset defines it in this repo"
                                + (" (exercised only by tests)" if prod_empty and e.get("test_sites") else ""))
        elif prod_empty:
            entry["warning"] = ("defined in changelog but no code access found"
                                + (" (exercised only by tests)" if e.get("test_sites") else ""))
        out.append(entry)
    return out


@mcp.tool(annotations=RO)
def http_map(path: str = "") -> str:
    """Full-stack HTTP seam: correlate REST endpoints (Spring controllers) with every caller (TS/React fetch/axios, Java RestTemplate/WebClient/Feign) matched on method + normalized path. Includes orphan endpoints and unmatched calls."""
    from http_extract import paths_match
    con = db()
    if not con.execute("SELECT name FROM sqlite_master WHERE name='http_endpoints'").fetchone():
        return "No HTTP-seam data; reindex with the current Ariadne"
    n_ep = con.execute("SELECT COUNT(*) FROM http_endpoints").fetchone()[0]
    has_test = con.execute("SELECT COUNT(*) FROM pragma_table_info('files') WHERE name='is_test'").fetchone()[0]
    if not path and n_ep > SUMMARY_THRESHOLD:
        from http_extract import paths_match as _pm
        # orphan math is production-only: a WireMock stub or a test caller cures nothing
        eps0 = con.execute("SELECT e.method, e.path, e.norm FROM http_endpoints e"
                           + (" JOIN files f ON f.id=e.file_id WHERE f.is_test=0" if has_test else "")).fetchall()
        calls0 = con.execute("SELECT c.method, c.path, c.norm, c.client FROM http_calls c"
                             + (" JOIN files f ON f.id=c.file_id WHERE f.is_test=0" if has_test else "")).fetchall()
        matched, orphans = set(), []
        for e in eps0:
            hit = False
            for i, c in enumerate(calls0):
                if c["method"] == e["method"] and _pm(c["norm"], e["norm"]):
                    matched.add(i)
                    hit = True
            if not hit:
                orphans.append(f"{e['method']} {e['path']}")
        cap = lambda a: (a[:25] + [f"…and {len(a) - 25} more"]) if len(a) > 25 else a  # noqa: E731
        return {
            "summary": f"{n_ep} endpoints, {len(calls0)} client calls.",
            "warnings": {
                "endpoints_with_no_caller_in_workspace": cap(orphans),
                "calls_with_no_matching_endpoint": cap([f"{c['method']} {c['path']} ({c['client']})"
                                                        for i, c in enumerate(calls0) if i not in matched]),
            },
            "next": "Full listing: docs/generated/http-map.md. For one route: http_map path:<fragment>.",
        }
    eps = con.execute("SELECT e.method, e.path, e.norm, f.path fp, e.line" + (", f.is_test" if has_test else "")
                      + " FROM http_endpoints e JOIN files f ON f.id=e.file_id ORDER BY e.norm").fetchall()
    calls = con.execute("SELECT c.method, c.path, c.norm, f.path fp, c.line, c.client" + (", f.is_test" if has_test else "")
                        + " FROM http_calls c JOIN files f ON f.id=c.file_id ORDER BY c.norm").fetchall()
    if not eps and not calls:
        return "No REST endpoints or HTTP clients detected."
    matched = set()
    out = []
    for e in eps:
        if path and path not in e["norm"] and path not in e["path"]:
            continue
        callers = []
        for i, c in enumerate(calls):
            if c["method"] == e["method"] and paths_match(c["norm"], e["norm"]):
                matched.add(i)
                callers.append(c)
        prod_callers = [c for c in callers if not (has_test and c["is_test"])]
        test_callers = [c for c in callers if has_test and c["is_test"]]
        # an endpoint defined in a test file (WireMock/contract stub) is labeled, never an orphan
        ep_test = has_test and e["is_test"]
        entry = {"endpoint": f"{e['method']} {e['path']}",
                 "defined": f"{e['fp']}:{e['line']}" + ("  [TEST]" if ep_test else ""),
                 "callers": [f"{c['fp']}:{c['line']} ({c['client']})" for c in prod_callers]}
        if test_callers:
            entry["test_callers"] = [f"{c['fp']}:{c['line']} ({c['client']})  [TEST]" for c in test_callers]
        if not prod_callers and not ep_test:
            entry["warning"] = (f"no caller found in the indexed workspace (exercised only by tests: {len(test_callers)})"
                                if test_callers else "no caller found in the indexed workspace")
        out.append(entry)
    unmatched = [f"{c['method']} {c['path']}, {c['fp']}:{c['line']} ({c['client']}), no matching endpoint in workspace"
                 for i, c in enumerate(calls)
                 if i not in matched and not (has_test and c["is_test"]) and (not path or path in c["norm"])]
    if unmatched:
        out.append({"unmatched_calls": unmatched})
    # test calls to endpoints outside the workspace are listed, not dropped, and never a warning
    test_unmatched = [f"{c['method']} {c['path']}, {c['fp']}:{c['line']} ({c['client']})  [TEST]"
                      for i, c in enumerate(calls)
                      if i not in matched and has_test and c["is_test"] and (not path or path in c["norm"])]
    if test_unmatched:
        out.append({"test_unmatched_calls": test_unmatched})
    return out


# ---- composite decision tools: the session-opening dance, server-side ----
STOPWORDS = {"the", "and", "for", "with", "from", "that", "this", "then", "than", "when", "where",
             "which", "into", "onto", "over", "under", "about", "after", "before", "should", "would", "could", "will",
             "must", "make", "made", "need", "needs", "want", "wants", "add", "use", "using", "used", "new", "our",
             "are", "was", "were", "has", "have", "had", "not", "but", "all", "any", "can", "its", "also", "only",
             "just", "some", "how", "why", "what", "who", "each", "per", "via", "one", "two", "code", "file", "files"}


def _task_terms(task):
    """Must match the Node edition token-for-token: same stopwords, same cap."""
    words = [w for w in re.findall(r"[a-z0-9_.$-]{3,}", task.lower()) if w not in STOPWORDS]
    out = []
    for w in words:
        if w not in out:
            out.append(w)
    return out[:8]


def _file_seams(con, fid):
    return {
        "topics": con.execute("SELECT DISTINCT topic, direction FROM msg_edges WHERE file_id=?", (fid,)).fetchall(),
        "tables": con.execute("SELECT DISTINCT tbl, mode FROM db_access WHERE file_id=?", (fid,)).fetchall(),
        "endpoints": con.execute("SELECT method, path FROM http_endpoints WHERE file_id=? LIMIT 15", (fid,)).fetchall(),
        "calls": con.execute("SELECT method, path FROM http_calls WHERE file_id=? LIMIT 15", (fid,)).fetchall(),
    }


def _governing(con, targets):
    if not targets:
        return []
    try:
        marks = ",".join("?" * len(targets))
        return con.execute(
            f"SELECT DISTINCT dc.id, dc.title FROM decision_links dl JOIN decisions dc ON dc.id=dl.decision_id "
            f"WHERE dl.target IN ({marks}) AND dc.valid_until IS NULL", list(targets)).fetchall()
    except sqlite3.Error:
        return []


def _cap_list(a, n=10):
    return (a[:n] + [f"…and {len(a) - n} more"]) if len(a) > n else a


@mcp.tool(annotations=RO)
def plan_context(task: str) -> str:
    """When you have a TASK but no target yet: ONE call that finds the starting set server-side — full-text and symbol matches for the task's terms, the files they concentrate in, the Kafka topics / DB tables / HTTP endpoints those files touch, the decisions governing them, and the tests that cover them. Use INSTEAD of the 3-5 exploratory search calls at session start; then context_pack the target you choose."""
    con = db()
    terms = _task_terms(task)
    if not terms:
        return "Could not extract search terms from the task; describe it with a few concrete words (component, topic, table, endpoint)."
    score, why = {}, {}

    def bump(p, n, w):
        score[p] = score.get(p, 0) + n
        why.setdefault(p, [])
        if w not in why[p]:
            why[p].append(w)

    try:
        fts_q = " OR ".join('"' + t.replace('"', '""') + '"' for t in terms)
        for i, r in enumerate(con.execute(
                "SELECT path FROM chunks WHERE chunks MATCH ? ORDER BY rank LIMIT 40", (fts_q,))):
            bump(r["path"], 40 - i, "text match")
    except sqlite3.Error:
        pass  # FTS syntax edge: symbols still cover us
    symbols = []
    for t in terms[:6]:
        for s in con.execute(
                "SELECT s.name, s.kind, s.parent, f.path, s.line FROM symbols s JOIN files f ON f.id=s.file_id "
                "WHERE s.name LIKE ? ORDER BY LENGTH(s.name) LIMIT 4", (f"%{t}%",)):
            symbols.append(f"{(s['parent'] + '.') if s['parent'] else ''}{s['name']} ({s['kind']}) {s['path']}:{s['line']}")
            bump(s["path"], 25, f"symbol {s['name']}")
    if not score:
        return f"Nothing in the graph matches [{', '.join(terms)}]. Try search_code with different words, or module_map to orient."
    seeds = [p for p, _ in sorted(score.items(), key=lambda kv: -kv[1])[:8]]
    marks = ",".join("?" * len(seeds))
    topics, tables, defines, hcalls = {}, {}, [], []
    for f in con.execute(f"SELECT id, path FROM files WHERE path IN ({marks})", seeds):
        s = _file_seams(con, f["id"])
        for t in s["topics"]:
            topics[f"{t['direction']} {t['topic']}"] = t["topic"]
        for t in s["tables"]:
            tables[f"{t['mode']} {t['tbl']}"] = t["tbl"]
        for e in s["endpoints"]:
            if f"{e['method']} {e['path']}" not in defines:
                defines.append(f"{e['method']} {e['path']}")
        for c in s["calls"]:
            if f"{c['method']} {c['path']}" not in hcalls:
                hcalls.append(f"{c['method']} {c['path']}")
    mods = list(dict.fromkeys(p.split("/")[0] for p in seeds))
    govern = _governing(con, list(dict.fromkeys(list(topics.values()) + list(tables.values()) + mods)))
    # tests that import any seed file, and the behaviors they assert
    tests = "none found — no test imports these files"
    try:
        tf = [r["path"] for r in con.execute(
            f"SELECT DISTINCT f2.path FROM edges e JOIN files f2 ON f2.id=e.src JOIN files f ON f.id=e.dst "
            f"WHERE f.path IN ({marks}) AND f2.is_test=1 LIMIT 6", seeds)]
        if tf:
            decamel = lambda s: s if " " in s else re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s).replace("_", " ").lower()  # noqa: E731
            tm = ",".join("?" * len(tf))
            tests = {"files": tf, "behaviors": [decamel(r["name"]) for r in con.execute(
                f"SELECT tc.name FROM test_cases tc JOIN files f2 ON f2.id=tc.file_id WHERE f2.path IN ({tm}) LIMIT 6", tf)]}
    except sqlite3.Error:
        pass  # files.is_test / test_cases may predate this index build
    insights = []
    try:
        insights = [f"{r['target']}: {str(r['summary'])[:150]}" for r in con.execute(
            f"SELECT target, summary FROM insights WHERE target IN ({','.join('?' * len(mods))})", mods)]
    except sqlite3.Error:
        pass  # no insights yet
    return {
        "task_terms": terms,
        "files_to_read": [{"path": p, "matched": why.get(p, [])[:4]} for p in seeds],
        "symbols": _cap_list(symbols, 12),
        "kafka": list(topics) or "none",
        "database": list(tables) or "none",
        "http": {"defines": defines, "calls": hcalls},
        "governing_decisions": [f"{g['id']}: {g['title']}" for g in govern] or "none recorded",
        "tests": tests,
        "cached_insights": insights or "none",
        "next": "Pick the real target from files_to_read and call context_pack on it. Check the governing decisions before designing. Run change_check(files) before you edit.",
    }


@mcp.tool(annotations=RO)
def change_check(files: list[str]) -> str:
    """PRE-EDIT decision support: given the files you intend to touch, ONE call returning their combined blast radius, the tests to re-run, the seam warnings your edit could introduce (sole producers/consumers, drift tables, uncalled endpoints, unresolved expressions), the decisions governing them, and the assertions your edit will mark STALE. Call BEFORE proposing a diff."""
    from http_extract import paths_match
    con = db()
    files = [f for f in files if f][:20]
    if not files:
        return "Pass the list of files you intend to edit."
    known, unknown = [], []
    for p in files:
        f = con.execute("SELECT id, path FROM files WHERE path=?", (p,)).fetchone()
        (known if f else unknown).append(f or p)
    if not known:
        return (f"None of the {len(files)} file(s) are in the index. Paths are repo-prefixed "
                "in a multi-repo workspace (module_map shows the roots).")
    has_test = con.execute("SELECT COUNT(*) FROM pragma_table_info('files') WHERE name='is_test'").fetchone()[0]
    kids = [f["id"] for f in known]
    id_marks = ",".join("?" * len(kids))
    affected, tests_affected = set(), set()
    per_file = []
    for f in known:
        b = _blast_data(con, f["path"], 2)
        for lvl in b["by_depth"]:
            affected.update(lvl)
        tests_affected.update(b.get("tests_affected", []))
        seams = _file_seams(con, f["id"])
        entry = {"path": f["path"],
                 "direct_dependents": con.execute("SELECT COUNT(*) c FROM edges WHERE dst=?", (f["id"],)).fetchone()["c"]}
        if seams["topics"]:
            entry["kafka"] = [f"{t['direction']} {t['topic']}" for t in seams["topics"]]
        if seams["tables"]:
            entry["database"] = [f"{t['mode']} {t['tbl']}" for t in seams["tables"]]
        if seams["endpoints"]:
            entry["defines_endpoints"] = [f"{e['method']} {e['path']}" for e in seams["endpoints"]]
        per_file.append(entry)
    affected -= {f["path"] for f in known}
    warn = {}
    unresolved = con.execute(
        f"SELECT m.topic expression, f.path, m.line FROM msg_edges m JOIN files f ON f.id=m.file_id "
        f"WHERE m.resolved=0 AND m.file_id IN ({id_marks})", kids).fetchall()
    if unresolved:
        warn["unresolved_expressions_in_these_files"] = [f"{r['expression']} @ {r['path']}:{r['line']}" for r in unresolved]
    # topics where a listed file is the ONLY production-side producer or consumer
    prod_join = " AND fx.is_test=0" if has_test else ""
    sole = []
    for r in con.execute(f"SELECT DISTINCT topic FROM msg_edges WHERE file_id IN ({id_marks})", kids):
        for direction in ("produce", "consume"):
            sites = [x["fid"] for x in con.execute(
                f"SELECT DISTINCT m.file_id fid FROM msg_edges m JOIN files fx ON fx.id=m.file_id "
                f"WHERE m.topic=? AND m.direction=?{prod_join}", (r["topic"], direction))]
            if sites and all(s in kids for s in sites):
                side = "sole producer" if direction == "produce" else "sole consumer"
                sole.append(f"{side} of {r['topic']} — a breaking change here orphans the topic")
    if sole:
        warn["sole_seam_side"] = sole
    drift = [r["tbl"] for r in con.execute(
        f"SELECT DISTINCT a.tbl FROM db_access a WHERE a.file_id IN ({id_marks}) "
        f"AND a.tbl NOT IN (SELECT tbl FROM db_defs)", kids)]
    if drift:
        warn["drift_tables_touched"] = [
            f"{t} — accessed here but no changeset defines it; fix the changelog with this change, or explain why not" for t in drift]
    eps = con.execute(f"SELECT e.method, e.path, e.norm FROM http_endpoints e WHERE e.file_id IN ({id_marks})", kids).fetchall()
    if eps:
        calls = con.execute("SELECT c.method, c.norm FROM http_calls c"
                            + (" JOIN files fx ON fx.id=c.file_id WHERE fx.is_test=0" if has_test else "")).fetchall()
        un = [e for e in eps if not any(c["method"] == e["method"] and paths_match(c["norm"], e["norm"]) for c in calls)]
        if un:
            warn["endpoints_defined_here_with_no_caller"] = [f"{e['method']} {e['path']}" for e in un]
    mods = list(dict.fromkeys(f["path"].split("/")[0] for f in known))
    topics_all = [r["topic"] for r in con.execute(f"SELECT DISTINCT topic FROM msg_edges WHERE file_id IN ({id_marks})", kids)]
    tables_all = [r["tbl"] for r in con.execute(f"SELECT DISTINCT tbl FROM db_access WHERE file_id IN ({id_marks})", kids)]
    govern = _governing(con, list(dict.fromkeys(topics_all + tables_all + mods)))
    at_risk = []
    try:
        pmarks = ",".join("?" * len(known))
        at_risk = [f"{r['kind']} @ {r['file_path']}:{r['line']} (by {r['author']})" for r in con.execute(
            f"SELECT kind, file_path, line, author FROM assertions WHERE kind!='dismissal' "
            f"AND file_path IN ({pmarks})", [f["path"] for f in known])]
    except sqlite3.Error:
        pass  # assertions table may predate this build
    out = {
        "files": {"checked": [f["path"] for f in known], **({"not_in_index": unknown} if unknown else {})},
        "blast_radius": {"affected_total": len(affected), "sample": _cap_list(sorted(affected), 12)},
        "tests_to_rerun": {"total": len(tests_affected), "files": _cap_list(sorted(tests_affected), 12)},
        "per_file": per_file,
        **({"seam_warnings": warn} if warn else {}),
        "governing_decisions": [f"{g['id']}: {g['title']} — check with decision_trace before deviating" for g in govern] or "none recorded",
        **({"assertions_marked_stale_by_this_edit": at_risk} if at_risk else {}),
        "next": "Re-run the tests listed after your edit. If a seam warning names a topic/table/endpoint, look at its other side first (message_flow/db_map/http_map).",
    }
    return out


@mcp.tool(annotations=WR)
async def reindex(mode: str = "incremental") -> str:
    """Rebuild the index. mode='incremental' (changed files since last indexed commit) or 'full'. Use when index_status reports fresh=false."""
    flag = "--full" if mode == "full" else "--incremental"

    def _run():
        try:
            r = subprocess.run([sys.executable, str(REPO_ROOT / ".ariadne" / "indexer.py"), flag],
                               capture_output=True, text=True, cwd=REPO_ROOT, timeout=600)
            return (r.stdout + r.stderr).strip() or "done"
        except subprocess.TimeoutExpired:
            return "reindex timed out after 600s; run it manually"

    # A sync def here would block FastMCP's event loop for up to 10 minutes,
    # stalling pings and every concurrent request until the client gives up
    # and kills the server. The node edition is async for the same reason.
    import anyio
    out = await anyio.to_thread.run_sync(_run)
    await _notify_after_reindex()  # subscribed resource readers refetch instead of going stale
    return out


def _load_tool_extensions():
    ext = DB_PATH.parent / "extensions"
    if not ext.exists():
        return
    import importlib.util
    import logging as _logging
    from trust import approved_files
    _tl = _logging.getLogger("ariadne.server")
    if not _tl.handlers:
        _tl.addHandler(_logging.StreamHandler(sys.stderr))
        _tl.setLevel(_logging.WARNING)
    for name in approved_files(ext, r"\.tool\.py$", _tl):
        f = ext / name
        try:
            spec = importlib.util.spec_from_file_location(f.stem.replace(".", "_"), f)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            if hasattr(mod, "register"):
                mod.register(mcp, db)
        except Exception as e:  # noqa: BLE001
            print(f"extension tool {f.name} failed: {e}", file=sys.stderr)


_load_tool_extensions()


# ---- MCP prompts: the four graph-aware recipes, rendered server-side ----
# Hosts that support MCP prompts surface these as slash commands. Every line
# of the rendered text comes from live queries, so the recipe carries current
# facts (blast radius, seams, decisions), not a static template. The registry
# must stay identical to the Node edition (suite-pinned).

def _prompt_guard(fn):
    """Errors become messages, never crashes — the same contract as the tools."""
    @functools.wraps(fn)
    def inner(*a, **k):
        try:
            return fn(*a, **k)
        except Exception as e:  # noqa: BLE001
            return f"Error in {fn.__name__}: {e}"
    return inner


def _dismissals(con):
    out = {}
    try:
        for r in con.execute("SELECT payload FROM assertions WHERE kind='dismissal'"):
            try:
                d = json.loads(r["payload"])
                out[f"{d.get('gap')}|{d.get('key')}"] = {"by": d.get("author"), "reason": d.get("reason")}
            except Exception:  # noqa: BLE001
                pass  # legacy row
    except sqlite3.Error:
        pass  # assertions table may predate this build
    return out


def _stale_assertions(con):
    try:
        return con.execute(
            "SELECT a.kind, a.file_path, a.line, a.author FROM assertions a JOIN files f ON f.path=a.file_path "
            "WHERE a.kind!='dismissal' AND a.source_hash IS NOT NULL AND a.source_hash != f.hash").fetchall()
    except sqlite3.Error:
        return []


@mcp.prompt(name="aegis-impact",
            description="What am I about to break? Blast radius, tests to re-run, seams touched, and governing decisions for a target (file path, class, or method) — rendered from the live graph.")
@_prompt_guard
def aegis_impact(target: str) -> str:
    con = db()
    hit = _resolve_target(con, target)
    if not hit:
        return (f"Target '{target}' not found in the index. Try find_symbol or search_code first, "
                "then re-run aegis-impact with the file path.")
    file, _sym = hit
    p = file["path"]
    blast = _blast_data(con, p, 2)
    seams = _file_seams(con, file["id"])
    govern = _governing(con, list(dict.fromkeys(
        [t["topic"] for t in seams["topics"]] + [t["tbl"] for t in seams["tables"]] + [p.split("/")[0]])))
    anchored = 0
    try:
        anchored = con.execute("SELECT COUNT(*) c FROM assertions WHERE kind!='dismissal' AND file_path=?",
                               (p,)).fetchone()["c"]
    except sqlite3.Error:
        pass  # pre-assertions build
    kafka = ", ".join(f"{t['direction']} {t['topic']}" for t in seams["topics"]) or "none"
    tables = ", ".join(f"{t['mode']} {t['tbl']}" for t in seams["tables"]) or "none"
    http = ", ".join(f"{e['method']} {e['path']}" for e in list(seams["endpoints"]) + list(seams["calls"])) or "none"
    lines = [
        f"You are about to change {target}" + ("" if p == target else f" ({p})") + ". Impact, from the live graph:",
        "",
        f"Blast radius (depth 2): {blast['affected_total']} production file(s) depend on it.",
        *[f"  - {x}" for x in _cap_list([x for lvl in blast["by_depth"] for x in lvl], 10)],
        f"Tests to re-run ({blast.get('tests_affected_total', 0)}):",
        *([f"  - {x}" for x in _cap_list(blast.get("tests_affected", []), 10)] if blast.get("tests_affected")
          else ["  - none recorded — treat the change as untested and say so in the PR"]),
        f"Seams touched: kafka [{kafka}]; tables [{tables}]; http [{http}].",
        "Governing decisions: " + ("; ".join(f"{g['id']}: {g['title']}" for g in govern) if govern else "none recorded") + ".",
        *([f"Assertions anchored to this file: {anchored} — your edit marks them STALE; re-affirm or retract them afterwards."]
          if anchored else []),
        "",
        "Before writing code: (1) check the governing decisions above (decision_trace <id>) and do not silently "
        "contradict them; (2) look at the other side of every seam listed (message_flow topic:<t> / db_map table:<t> "
        "/ http_map path:<p>); (3) when you know the full edit set, run change_check(files) and re-run the tests it lists.",
    ]
    return "\n".join(lines)


@mcp.prompt(name="aegis-orient",
            description="First encounter with a module: files, the most-depended-on entry points, the seams it participates in, governing decisions, and cached insight — the reading plan before any code is read.")
@_prompt_guard
def aegis_orient(module: str) -> str:
    con = db()
    rows = con.execute("SELECT id, path, lang FROM files WHERE path LIKE ?", (module + "/%",)).fetchall()
    if not rows:
        return f"No files under module '{module}'. module_map lists the modules in this workspace."
    langs = {}
    for r in rows:
        langs[r["lang"]] = langs.get(r["lang"], 0) + 1
    hot = con.execute(
        "SELECT f.path, COUNT(e.src) n FROM files f JOIN edges e ON e.dst=f.id "
        "WHERE f.path LIKE ? GROUP BY f.id ORDER BY n DESC LIMIT 5", (module + "/%",)).fetchall()
    topics = [r[0] for r in con.execute(
        "SELECT DISTINCT m.direction || ' ' || m.topic FROM msg_edges m JOIN files f ON f.id=m.file_id WHERE f.path LIKE ?", (module + "/%",))]
    tables = [r[0] for r in con.execute(
        "SELECT DISTINCT a.mode || ' ' || a.tbl FROM db_access a JOIN files f ON f.id=a.file_id WHERE f.path LIKE ?", (module + "/%",))]
    eps = [r[0] for r in con.execute(
        "SELECT DISTINCT e.method || ' ' || e.path FROM http_endpoints e JOIN files f ON f.id=e.file_id WHERE f.path LIKE ?", (module + "/%",))]
    govern = _governing(con, list(dict.fromkeys(
        [s.split(" ")[-1] for s in topics] + [s.split(" ")[-1] for s in tables] + [module])))
    insight = None
    try:
        row = con.execute("SELECT summary FROM insights WHERE target=?", (module,)).fetchone()
        insight = row["summary"] if row else None
    except sqlite3.Error:
        pass  # none yet
    n_tests = 0
    try:
        n_tests = con.execute("SELECT COUNT(*) c FROM files WHERE path LIKE ? AND is_test=1",
                              (module + "/%",)).fetchone()["c"]
    except sqlite3.Error:
        pass  # pre-is_test build
    top_langs = ", ".join(sorted(langs, key=langs.get, reverse=True)[:3])
    lines = [
        f"Orientation for module {module}: {len(rows)} files ({top_langs}), {n_tests} of them tests.",
        "",
        "Most-depended-on files (start reading here):",
        *([f"  - {h['path']} ({h['n']} dependents)" for h in hot] if hot
          else ["  - no in-module dependency edges recorded"]),
        f"Seams: kafka [{', '.join(_cap_list(topics, 8)) or 'none'}]; tables [{', '.join(_cap_list(tables, 8)) or 'none'}]; "
        f"http [{', '.join(_cap_list(eps, 8)) or 'none'}].",
        "Governing decisions: " + ("; ".join(f"{g['id']}: {g['title']}" for g in govern) if govern else "none recorded") + ".",
        "Cached insight: " + (insight or "none — after you understand the module, save_insight so the next agent starts warm") + ".",
        "",
        f"Suggested next calls: context_pack '{hot[0]['path'] if hot else module}' for the core file; "
        f"message_flow topic:<name> for the messaging side; decisions target:{module} for the history. "
        "Do not read files the outline already answers for.",
    ]
    return "\n".join(lines)


_GAP_CATS = [
    ("unresolved_topic_expressions",
     lambda g: f"{g['expression']} at {g['path']}:{g['line']}",
     lambda g: f"unresolved|{g['path']}:{g['line']}",
     "a runtime-assembled topic: kind 'kafka', plus topic and direction once you have read how the value is built"),
    ("tables_accessed_but_undefined",
     lambda g: f"table {g['table_name']} at {g['path']}:{g['line']}",
     lambda g: f"drift_table|{g['table_name']}",
     "schema drift: kind 'db' with the real table, or a changeset fix in the code itself"),
    ("topics_consumed_but_never_produced",
     lambda g: f"topic {g['topic']}",
     lambda g: f"orphan_topic|{g['topic']}",
     "a missing producer: kind 'kafka', direction 'produce', anchored at the site you find"),
    ("topics_produced_but_never_consumed",
     lambda g: f"topic {g['topic']}",
     lambda g: f"orphan_topic|{g['topic']}",
     "a missing consumer: kind 'kafka', direction 'consume', anchored at the site you find"),
    ("endpoints_with_no_caller",
     lambda g: f"endpoint {g['endpoint']}",
     lambda g: None,
     "an external or gateway-rewritten caller: kind 'http_call' with the normalized path"),
    ("topics_declared_in_config_but_unused",
     lambda g: f"topic {g['topic']} (declared by {g['config_key']})",
     lambda g: f"declared_unused|{g['topic']}",
     "config drift: either wire the topic up, remove the key, or dismiss with a reason"),
]


@mcp.prompt(name="aegis-resolve-gap",
            description="Work the graph's to-do list: the top unresolved gap (dynamic topic, drift table, orphan seam), the investigation protocol, and the assert_edge contract for recording what you find.")
@_prompt_guard
def aegis_resolve_gap() -> str:
    con = db()
    gaps = _gaps_data(con, 20)
    dism = _dismissals(con)
    top = None
    remaining = []
    for cat, fmt, key, hint in _GAP_CATS:
        live = [g for g in gaps.get(cat, []) if not (key(g) and key(g) in dism)]
        if live:
            if not top:
                top = {"cat": cat, "item": live[0], "fmt": fmt, "hint": hint}
                if len(live) > 1:
                    remaining.append(f"{cat}: {len(live) - 1} more")
            else:
                remaining.append(f"{cat}: {len(live)}")
    if not top:
        return ("No open gaps — static analysis resolved everything it looked at, and the rest is "
                "dismissed with reasons. Nothing to do.")
    why = f" Why the graph is blind here: {top['item']['why']}." if top["item"].get("why") else ""
    return "\n".join([
        f"The graph needs a human (or you) here. Top gap ({top['cat']}): {top['fmt'](top['item'])}.{why}",
        "",
        "Protocol:",
        "1. Read the code at the location (file_outline first; read the file only if the outline is not enough).",
        "2. Trace how the value is built: find_callers on the enclosing method, search_code on the string fragments.",
        f"3. If you can determine the real seam, record it with assert_edge — for this gap that means {top['hint']}. "
        "Evidence must QUOTE the code that convinced you (>= 20 chars) and carry a confidence (high|medium|low).",
        "4. If the gap is intended (external consumer, fire-and-forget, decommissioned), dismiss it with a reason "
        "via the annotate CLI or the graph view instead of asserting.",
        "NEVER assert from naming alone — an assertion is a fact you derived from code you read, or it does not enter the graph.",
        "",
        f"Remaining after this one: {'; '.join(remaining)}. Re-run aegis-resolve-gap for the next."
        if remaining else "This is the last open gap.",
    ])


@mcp.prompt(name="aegis-release-check",
            description="Pre-release review from the live graph: schema drift, orphan seams, uncalled endpoints, unresolved expressions, and stale assertions — each with the tool that investigates it.")
@_prompt_guard
def aegis_release_check() -> str:
    con = db()
    st = _status_data()
    gaps = _gaps_data(con, 60)
    dism = _dismissals(con)
    dismissed = 0

    def live(arr, key):
        nonlocal dismissed
        out = []
        for g in arr or []:
            if key(g) and key(g) in dism:
                dismissed += 1
            else:
                out.append(g)
        return out

    drift = [g["table_name"] for g in live(gaps.get("tables_accessed_but_undefined"), lambda g: f"drift_table|{g['table_name']}")]
    orphan_p = [g["topic"] for g in live(gaps.get("topics_produced_but_never_consumed"), lambda g: f"orphan_topic|{g['topic']}")]
    orphan_c = [g["topic"] for g in live(gaps.get("topics_consumed_but_never_produced"), lambda g: f"orphan_topic|{g['topic']}")]
    uncalled = [g["endpoint"] for g in gaps.get("endpoints_with_no_caller", [])]
    unresolved = live(gaps.get("unresolved_topic_expressions"), lambda g: f"unresolved|{g['path']}:{g['line']}")
    declared = [g["topic"] for g in live(gaps.get("topics_declared_in_config_but_unused"), lambda g: f"declared_unused|{g['topic']}")]
    stale = _stale_assertions(con)
    n = len(drift) + len(orphan_p) + len(orphan_c) + len(uncalled) + len(unresolved) + len(declared) + len(stale)
    lines = [
        f"Pre-release review, from the live graph (index fresh: {str(st['fresh']).lower()}"
        + ("" if st["fresh"] else " — reindex before trusting this") + "):",
        "",
        f"1. Schema drift — code touching tables no changeset defines ({len(drift)}): "
        + (", ".join(_cap_list(drift, 10)) or "none") + ". -> db_map table:<name>",
        f"2. Orphan topics — produced but never consumed ({len(orphan_p)}): " + (", ".join(_cap_list(orphan_p, 10)) or "none")
        + f"; consumed but never produced ({len(orphan_c)}): " + (", ".join(_cap_list(orphan_c, 10)) or "none")
        + ". -> message_flow topic:<name>",
        f"3. Endpoints nobody calls ({len(uncalled)}): " + (", ".join(_cap_list(uncalled, 10)) or "none") + ". -> http_map path:<fragment>",
        f"4. Unresolved dynamic expressions ({len(unresolved)}): "
        + (", ".join(_cap_list([f"{g['path']}:{g['line']}" for g in unresolved], 6)) or "none")
        + ". -> aegis-resolve-gap works through them one at a time",
        f"5. Stale assertions — evidence files changed since they were asserted ({len(stale)}): "
        + (", ".join(_cap_list([f"{s['kind']} @ {s['file_path']}:{s['line']} (by {s['author']})" for s in stale], 8)) or "none")
        + ". -> re-affirm or retract (graph view, or the annotate CLI)",
        f"6. Topics declared in config but unused ({len(declared)}): " + (", ".join(_cap_list(declared, 10)) or "none") + ".",
        *([f"({dismissed} previously triaged item(s) excluded — dismissed with reasons in docs/graph-assertions.json.)"]
          if dismissed else []),
        "",
        "Ship bar: every line above should be empty, fixed, or dismissed-with-a-reason. A drift table or orphan seam "
        "nobody can explain is a release blocker — investigate with the tool named on its line."
        if n else
        "All clear: no drift, no orphan seams, no uncalled endpoints, no unresolved expressions, no stale assertions.",
    ]
    return "\n".join(lines)


# ---- MCP resources: ariadne:// context a host can ATTACH without tool calls ----
# URIs are the cross-edition contract (suite-pinned): graph, status, context,
# decisions (+ per-id template), assertions. Subscribed clients get
# notifications/resources/updated when the index moves (see the watcher below).

_export_cache = {"key": None, "json": None}


def _current_run():
    try:
        row = db().execute("SELECT value FROM meta WHERE key='last_run'").fetchone()
        return row["value"] if row else None
    except Exception:  # noqa: BLE001
        return None


@mcp.resource("ariadne://graph", name="graph", mime_type="application/json",
              description="The full graph-export JSON snapshot (modules, topics, tables, endpoints, gaps, annotations) — the same contract the graph view renders. Cached until the index moves.")
async def resource_graph() -> str:
    key = _current_run()
    if key and _export_cache["key"] == key and _export_cache["json"]:
        return _export_cache["json"]

    def _run():
        r = subprocess.run([sys.executable, str(Path(__file__).resolve().parent / "graph_export.py")],
                           capture_output=True, text=True, cwd=REPO_ROOT, timeout=120)
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout).strip()[-300:] or "graph export failed")
        return r.stdout.strip().splitlines()[-1]

    import anyio
    try:
        out = await anyio.to_thread.run_sync(_run)
    except Exception as e:  # noqa: BLE001
        return f"Error reading graph: {e}"
    _export_cache.update(key=key, json=out)
    return out


@mcp.resource("ariadne://status", name="status", mime_type="application/json",
              description="Index freshness: counts, indexed SHA vs HEAD, payload version. The resource twin of the index_status tool.")
def resource_status() -> str:
    try:
        return json.dumps(_status_data(), indent=1)
    except Exception as e:  # noqa: BLE001
        return f"Error reading status: {e}"


@mcp.resource("ariadne://context", name="context", mime_type="text/markdown",
              description="The graph-derived orientation pack for agents (docs/generated/agent-context.md): module map, seams, standing rules derived from what the graph actually contains.")
def resource_context() -> str:
    p = REPO_ROOT / "docs" / "generated" / "agent-context.md"
    if not p.exists():
        return ("No agent-context.md yet. Generate it with: python3 .ariadne/docgen.py "
                "(the post-commit hook keeps it current once installed).")
    return p.read_text(encoding="utf-8")


@mcp.resource("ariadne://decisions", name="decisions", mime_type="application/json",
              description="The decision ledger: every ADR with status and temporal validity. Read one in full at ariadne://decisions/<id>.")
def resource_decisions() -> str:
    try:
        con = db()
        rows = []
        for r in con.execute("SELECT id, title, status, decided_at, valid_until, superseded_by FROM decisions ORDER BY decided_at DESC"):
            e = {"id": r["id"], "title": r["title"], "status": r["status"], "decided": r["decided_at"]}
            if r["valid_until"]:
                e["valid_until"], e["superseded_by"] = r["valid_until"], r["superseded_by"]
            rows.append(e)
        return json.dumps({"decisions": rows, "note": "Read one ADR in full at ariadne://decisions/<id>."}, indent=1)
    except Exception as e:  # noqa: BLE001
        return f"Error reading decisions: {e}"


@mcp.resource("ariadne://decisions/{id}", name="decision", mime_type="text/markdown",
              description="One architectural decision record, as markdown: the git-versioned source file when present, else the indexed summary with its supersession chain.")
def resource_decision(id: str) -> str:
    try:
        con = db()
        rec = con.execute("SELECT * FROM decisions WHERE id=?", (id.upper(),)).fetchone()
        if not rec:
            return f"No decision '{id}'. ariadne://decisions lists what exists."
        if rec["source_path"]:
            p = REPO_ROOT / rec["source_path"]
            if p.exists():
                return p.read_text(encoding="utf-8")
        links = con.execute("SELECT kind, target FROM decision_links WHERE decision_id=?", (rec["id"],)).fetchall()
        return (f"# {rec['id']}: {rec['title']}\n\nStatus: {rec['status']}\nDate: {rec['decided_at'] or '?'}\n"
                + (f"Valid until: {rec['valid_until']} (superseded by {rec['superseded_by']})\n" if rec["valid_until"] else "")
                + (("Governs: " + ", ".join(f"{li['kind']}:{li['target']}" for li in links) + "\n") if links else "")
                + f"\n{rec['summary'] or ''}\n")
    except Exception as e:  # noqa: BLE001
        return f"Error reading decision: {e}"


@mcp.resource("ariadne://assertions", name="assertions", mime_type="application/json",
              description="The human knowledge layer: docs/graph-assertions.json with a computed stale flag per assertion (evidence file changed since it was recorded).")
def resource_assertions() -> str:
    af = REPO_ROOT / "docs" / "graph-assertions.json"
    if not af.exists():
        return json.dumps({"assertions": [], "note": "No graph-assertions.json yet — assert_edge (or the graph view) creates it."}, indent=1)
    try:
        lst = json.loads(af.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        return f"docs/graph-assertions.json exists but is not valid JSON ({e}). Fix it by hand; nothing here will overwrite it."
    if not isinstance(lst, list):
        return "docs/graph-assertions.json is not a JSON array. Fix it by hand; nothing here will overwrite it."
    try:
        con = db()
        for a in lst:
            if isinstance(a, dict) and a.get("kind") != "dismissal" and a.get("source_hash") and a.get("file"):
                cur = con.execute("SELECT hash FROM files WHERE path=?", (a["file"],)).fetchone()
                if cur and cur["hash"] != a["source_hash"]:
                    a["stale"] = True
    except Exception:  # noqa: BLE001
        pass  # no index yet: serve the raw ledger
    return json.dumps({"assertions": lst,
                       "note": "stale=true means the evidence file changed since the assertion was recorded — re-affirm or retract it."}, indent=1)


# ---- updated-notifications: the agent-side twin of the graph view's watcher.
# Hooks and agents reindex outside this process, so subscribed clients poll
# nothing: while subscriptions exist, meta.last_run is checked every 2s (a
# microsecond read) and a move fans out notifications/resources/updated per
# subscribed URI plus one resources/list_changed (the decision list may have
# grown). The reindex tool short-circuits the wait by notifying on completion.

_subs = []  # (session, uri) pairs, one per active subscription
_watch_task = None
_last_notified_run = None


async def _notify_index_moved():
    global _last_notified_run
    dead = []
    for pair in list(_subs):
        session, uri = pair
        try:
            await session.send_resource_updated(AnyUrl(uri))
        except Exception:  # noqa: BLE001
            dead.append(pair)
    for session in {p[0] for p in _subs if p not in dead}:
        try:
            await session.send_resource_list_changed()
        except Exception:  # noqa: BLE001
            pass
    for p in dead:
        if p in _subs:
            _subs.remove(p)
    _last_notified_run = _current_run()


async def _notify_after_reindex():
    await _notify_index_moved()
    if not _subs:
        # no subscriptions, but the calling session still gets list_changed
        try:
            await mcp.get_context().session.send_resource_list_changed()
        except Exception:  # noqa: BLE001
            pass  # module-surface call: no live session


async def _watch_index():
    global _last_notified_run
    while True:
        await asyncio.sleep(2)
        if not _subs:
            continue
        run = _current_run()
        if run and _last_notified_run and run != _last_notified_run:
            await _notify_index_moved()
        elif run and not _last_notified_run:
            _last_notified_run = run


@mcp._mcp_server.subscribe_resource()
async def _on_subscribe(uri) -> None:
    global _watch_task, _last_notified_run
    _subs.append((mcp._mcp_server.request_context.session, str(uri)))
    if _watch_task is None:
        _last_notified_run = _current_run()
        _watch_task = asyncio.get_running_loop().create_task(_watch_index())


@mcp._mcp_server.unsubscribe_resource()
async def _on_unsubscribe(uri) -> None:
    sess = mcp._mcp_server.request_context.session
    _subs[:] = [p for p in _subs if not (p[0] is sess and p[1] == str(uri))]


def main():
    """Console entry point (aegis-ariadne) and script entry alike."""
    # The SDK computes the resources capability with subscribe hardcoded False
    # even when subscribe handlers are registered, and notification options
    # default everything off; declare what this server actually implements
    # (subscribe + list_changed), the Node edition's registerCapabilities twin.
    _orig_cio = mcp._mcp_server.create_initialization_options

    def _cio(notification_options=None, experimental_capabilities=None, **kw):
        opts = _orig_cio(NotificationOptions(resources_changed=True), experimental_capabilities or {}, **kw)
        if opts.capabilities.resources:
            opts.capabilities.resources.subscribe = True
        return opts

    mcp._mcp_server.create_initialization_options = _cio
    mcp.run()


if __name__ == "__main__":
    main()
