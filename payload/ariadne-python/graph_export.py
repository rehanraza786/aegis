#!/usr/bin/env python3
"""AEGIS graph export (Python edition; mirror of graph_export.mjs).

One machine-readable JSON snapshot of the graph for visual clients (the VS Code
graph view) and anything else that wants the topology without speaking MCP.
Read-only, deterministic, zero tokens. Budget discipline matches the tools:
entry lists are capped (config maxDocItems), per-entry site lists are capped,
warnings are computed over production code only with test usage labeled, and
provenance survives (`test` / `asserted` on every site).

Usage: python3 graph_export.py [--pretty]   (JSON on stdout; run from the
workspace root after indexing). Schema documented in EXTENDING.md.
"""
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from http_extract import paths_match  # noqa: E402

ROOT = Path.cwd()
DB_PATH = Path(os.environ.get("ARIADNE_HOME", ROOT)) / ".ariadne" / "index.db"
try:
    _cfg = json.loads((DB_PATH.parent / "config.json").read_text(encoding="utf-8"))
except Exception:  # noqa: BLE001
    _cfg = {}
MAX_MODULES = _cfg.get("maxDiagramNodes", 30)
# This feeds a human UI, not a model's context window, so the ceiling is a
# safety bound for enormous systems, not the doc/tool budget. Warning-bearing
# entries are never dropped by it (warn_first below).
MAX_ITEMS = _cfg.get("maxExportItems", _cfg.get("maxDocItems", 60) * 4)
MAX_SITES = 12

if not DB_PATH.exists():
    sys.exit("Index not found, run the Ariadne indexer first.")
con = sqlite3.connect(f"file:{DB_PATH.as_posix()}?mode=ro", uri=True)
con.row_factory = sqlite3.Row
q = lambda sql, *a: con.execute(sql, a).fetchall()  # noqa: E731
has = lambda t: bool(q("SELECT name FROM sqlite_master WHERE name=?", t))  # noqa: E731
HAS_TEST = bool(q("SELECT COUNT(*) c FROM pragma_table_info('files') WHERE name='is_test'")[0]["c"])
T = ", f.is_test" if HAS_TEST else ""
svc = lambda p: p.split("/")[0]  # noqa: E731


def site(r, **extra):
    s = {"path": r["path"], "line": r["line"]}
    if "via" in r.keys() and r["via"]:
        s["via"] = r["via"]
    if HAS_TEST and r["is_test"]:
        s["test"] = True
    if "source" in r.keys() and r["source"] and str(r["source"]).startswith("asserted"):
        s["asserted"] = r["source"]
    s.update(extra)
    return s


def capped(arr, n):
    out = {"items": arr[:n]}
    if len(arr) > n:
        out["more"] = len(arr) - n
    return out


def warn_first(arr, n, weight):
    """Cap an entry list at n, but warning-bearing entries are kept FIRST and
    never dropped — the same rule the MCP tools enforce (a truncated export
    that silently discarded a drift warning would be worse than no export).
    Clean entries fill the remaining slots busiest-first, like message_flow."""
    warned = [e for e in arr if e.get("warnings")]
    clean = sorted((e for e in arr if not e.get("warnings")), key=weight, reverse=True)
    return warned + clean[:max(0, n - len(warned))]


def n_sites(lst):
    return len((lst or {}).get("items", [])) + (lst or {}).get("more", 0)


# ---- modules ----
files = q("SELECT path, lang FROM files")
services = {}
for f in files:
    s = services.setdefault(svc(f["path"]), {"files": 0, "langs": {}})
    s["files"] += 1
    s["langs"][f["lang"]] = s["langs"].get(f["lang"], 0) + 1
deps = {}
for e in q("SELECT DISTINCT f1.path a, f2.path b FROM edges e "
           "JOIN files f1 ON f1.id=e.src JOIN files f2 ON f2.id=e.dst"):
    a, b = svc(e["a"]), svc(e["b"])
    if a != b:
        deps.setdefault(a, set()).add(b)
modules = [{"id": name,
            "files": s["files"],
            "langs": sorted(s["langs"], key=lambda k: -s["langs"][k])[:3],
            "deps": sorted(deps.get(name, ()))}
           for name, s in sorted(services.items(), key=lambda kv: -kv[1]["files"])[:MAX_MODULES]]

# ---- topics ----
mrows = q(f"SELECT m.topic, m.direction, m.line, m.via, m.resolved, m.source, m.system, f.path{T} "
          "FROM msg_edges m JOIN files f ON f.id=m.file_id ORDER BY m.topic, m.line") if has("msg_edges") else []
by_topic = {}
for r in mrows:
    by_topic.setdefault(r["topic"], []).append(r)
# config-declared topics: the seam's source of truth (validation + linkage)
decl_rows = q("SELECT t.topic, t.config_key, f.path, t.line FROM msg_topics t "
              "JOIN files f ON f.id=t.file_id ORDER BY t.topic") if has("msg_topics") else []
decl_by_topic = {}
for r in decl_rows:
    decl_by_topic.setdefault(r["topic"], []).append(r["config_key"])
topics = []
for topic, rows in by_topic.items():
    prod = [r for r in rows if r["direction"] == "produce" and not (HAS_TEST and r["is_test"])]
    cons = [r for r in rows if r["direction"] == "consume" and not (HAS_TEST and r["is_test"])]
    test = [r for r in rows if HAS_TEST and r["is_test"]]
    warnings = {}
    if prod and not cons:
        warnings["orphan_produce"] = True
    if cons and not prod:
        warnings["orphan_consume"] = True
    if not prod and not cons and test:
        warnings["test_only"] = True
    if any(not r["resolved"] for r in rows):
        warnings["unresolved_expression"] = True
    systems = sorted({(r["system"] if "system" in r.keys() else None) or "kafka" for r in rows})
    t = {"topic": topic,
         **({} if systems == ["kafka"] else {"system": "+".join(systems)}),
         **({"config_keys": sorted(set(decl_by_topic[topic]))} if topic in decl_by_topic else {}),
         "producers": capped([site(r) for r in prod], MAX_SITES),
         "consumers": capped([site(r) for r in cons], MAX_SITES),
         "warnings": warnings}
    if test:
        t["test_sites"] = capped([site(r, direction=r["direction"]) for r in test], 6)
    topics.append(t)
topics = warn_first(topics, MAX_ITEMS, lambda t: n_sites(t["producers"]) + n_sites(t["consumers"]))

# ---- tables ----
drows = q("SELECT d.tbl, d.op, d.line, d.changeset, f.path FROM db_defs d "
          "LEFT JOIN files f ON f.id=d.file_id ORDER BY d.tbl") if has("db_defs") else []
arows = q(f"SELECT a.tbl, a.kind, a.mode, a.line, a.detail, a.source, f.path{T} "
          "FROM db_access a JOIN files f ON f.id=a.file_id ORDER BY a.tbl, a.line") if has("db_access") else []
by_tbl = {}
for d in drows:
    by_tbl.setdefault(d["tbl"], {"defs": [], "accs": []})["defs"].append(d)
for a in arows:
    by_tbl.setdefault(a["tbl"], {"defs": [], "accs": []})["accs"].append(a)
tables = []
for tbl, t in by_tbl.items():
    pa = [a for a in t["accs"] if not (HAS_TEST and a["is_test"])]
    ta = [a for a in t["accs"] if HAS_TEST and a["is_test"]]
    warnings = {}
    if not t["defs"]:
        warnings["drift_no_changeset"] = True
    if t["defs"] and not pa:
        warnings["defined_but_unused"] = True
    rec = {"table": tbl,
           "changesets": [f"{d['op']}" + (f" [{d['changeset']}]" if d["changeset"] else "") for d in t["defs"]],
           "access": capped([site(a, mode=a["mode"]) for a in pa], MAX_SITES),
           "warnings": warnings}
    if ta:
        rec["test_sites"] = capped([site(a, mode=a["mode"]) for a in ta], 6)
    tables.append(rec)
tables = warn_first(tables, MAX_ITEMS, lambda t: n_sites(t["access"]) + len(t["changesets"]))

# ---- endpoints ----
eps = q(f"SELECT e.method, e.path ep, e.norm, e.line, e.source, f.path{T} "
        "FROM http_endpoints e JOIN files f ON f.id=e.file_id ORDER BY e.norm") if has("http_endpoints") else []
calls = q(f"SELECT c.method, c.norm, c.line, c.client, c.source, f.path{T} "
          "FROM http_calls c JOIN files f ON f.id=c.file_id") if has("http_calls") else []
endpoints = []
for e in [e for e in eps if not (HAS_TEST and e["is_test"])]:
    cs = [c for c in calls if c["method"] == e["method"] and paths_match(c["norm"], e["norm"])]
    prod = [c for c in cs if not (HAS_TEST and c["is_test"])]
    rec = {"method": e["method"], "path": e["ep"], "file": e["path"], "line": e["line"],
           "callers": capped([site(c, client=c["client"]) for c in prod], MAX_SITES),
           "warnings": ({} if prod else {"no_caller": True, **({"tested_only": True} if cs else {})})}
    if e["source"] and str(e["source"]).startswith("asserted"):
        rec["asserted"] = e["source"]
    endpoints.append(rec)
endpoints = warn_first(endpoints, MAX_ITEMS, lambda e: n_sites(e["callers"]))

# ---- gaps ----
gaps = {
    "unresolved_topic_expressions": [
        {"expression": r["topic"], "direction": r["direction"], "path": r["path"], "line": r["line"]}
        for r in mrows if not r["resolved"] and not (HAS_TEST and r["is_test"])][:MAX_ITEMS],
    "topics_declared_in_config_but_unused": [
        {"topic": r["topic"], "config_key": r["config_key"], "path": r["path"], "line": r["line"]}
        for r in decl_rows if r["topic"] not in by_topic][:MAX_ITEMS],
}

# ---- annotations ----
def _assertion_row(r):
    try:
        p = json.loads(r["payload"]) if r["payload"] else {}
    except Exception:  # noqa: BLE001 - legacy row
        p = {}
    out = {"kind": r["kind"], "file": r["file_path"], "line": r["line"],
           "confidence": r["confidence"], "author": r["author"]}
    for k in ("topic", "direction", "table", "path"):
        if p.get(k):
            out[k] = p[k]
    if p.get("evidence"):
        out["evidence"] = str(p["evidence"])[:200]
    if r["source_hash"] and file_hash.get(r["file_path"]) != r["source_hash"]:
        out["stale"] = True
    return out


file_hash = {r["path"]: r["hash"] for r in q("SELECT path, hash FROM files")}
annotations = {
    "insights": [{"target": r["target"], "kind": r["kind"], "by": r["model"],
                  "summary": str(r["summary"] or "")[:300]}
                 for r in q("SELECT target, kind, model, hash, summary FROM insights ORDER BY target")[:MAX_ITEMS]]
    if has("insights") else [],
    "assertions": [_assertion_row(r)
                   for r in q("SELECT kind, payload, file_path, line, confidence, author, source_hash "
                              "FROM assertions ORDER BY file_path")[:MAX_ITEMS]]
    if has("assertions") else [],
}

# ---- freshness: a stale graph must be able to say so. The indexer stamps one
# last_sha:<prefix> per root ("." single-root), so freshness is per-root: every
# stamped SHA must equal its repo's current HEAD. If any root can't be checked
# (no git), freshness is unknown and the field is omitted — never guessed. ----
_sha_row = q("SELECT value FROM meta WHERE key='last_sha'")
indexed_sha = _sha_row[0]["value"] if _sha_row else None
sha_rows = q("SELECT key, value FROM meta WHERE key LIKE 'last_sha:%'")
head_sha = None
checked = matched = 0
for r in sha_rows:
    pref = r["key"][len("last_sha:"):]
    d = ROOT if pref == "." else ROOT / pref
    try:
        h = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True,
                           timeout=10, cwd=d).stdout.strip() or None
    except Exception:  # noqa: BLE001 - no git / not a repo
        h = None
    if h:
        checked += 1
        if h == r["value"]:
            matched += 1
        if len(sha_rows) == 1:
            head_sha = h
fresh = (matched == checked) if sha_rows and checked == len(sha_rows) else None

out = {
    "schema": 1,
    "generated_from": {"db": DB_PATH.name, "modules_total": len(services), "files": len(files),
                       "symbols": q("SELECT COUNT(*) c FROM symbols")[0]["c"],
                       # pre-cap totals, so a UI can say "showing N of M" instead of truncating silently
                       "topics_total": len(by_topic), "tables_total": len(by_tbl),
                       "endpoints_total": sum(1 for e in eps if not (HAS_TEST and e["is_test"])),
                       **({"indexed_sha": indexed_sha} if indexed_sha else {}),
                       **({"head_sha": head_sha} if head_sha else {}),
                       **({} if fresh is None else {"fresh": fresh}),
                       **({"modules_truncated_to": MAX_MODULES} if len(services) > MAX_MODULES else {})},
    "modules": modules, "topics": topics, "tables": tables, "endpoints": endpoints,
    "gaps": gaps, "annotations": annotations,
}
sys.stdout.write(json.dumps(out, indent=1 if "--pretty" in sys.argv else None) + "\n")
