#!/usr/bin/env python3
"""AEGIS annotate (Python edition; mirror of annotate.mjs).

Write-back CLI for clients that are not MCP agents, above all the VS Code
graph view. Semantics identical to the save_insight / assert_edge MCP tools:
hash-keyed insights, no-clobber assertions in docs/graph-assertions.json,
provenance preserved. Human input gets its own provenance (author: "human"),
so a person's annotation is never mistaken for a parsed fact OR for a model's
inference.

Usage: python3 annotate.py '<json>'   (see annotate.mjs header for shapes)
"""
import datetime
import hashlib
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path.cwd()
DB_PATH = Path(os.environ.get("ARIADNE_HOME", ROOT)) / ".ariadne" / "index.db"


def die(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


if not DB_PATH.exists():
    die("Index not found, run the Ariadne indexer first.")
try:
    a = json.loads(sys.argv[1] if len(sys.argv) > 1 else "")
except Exception:  # noqa: BLE001
    die("annotate expects one JSON argument; see the header of this file.")
author = a.get("author") or "human"

if a.get("action") == "insight":
    if a.get("kind") not in ("module", "file", "topic", "table") or len(a.get("summary", "")) < 40 or not a.get("target"):
        die("insight needs target, kind (module|file|topic|table), and a summary of at least 40 chars.")
    con = sqlite3.connect(DB_PATH, timeout=10)
    try:
        con.execute("PRAGMA busy_timeout=10000")
        con.execute("""CREATE TABLE IF NOT EXISTS insights(target TEXT PRIMARY KEY, kind TEXT,
                       hash TEXT, summary TEXT, model TEXT, generated_at REAL, source TEXT)""")
        if not [r for r in con.execute("PRAGMA table_info(insights)") if r[1] == "source"]:
            con.execute("ALTER TABLE insights ADD COLUMN source TEXT")
        if a["kind"] == "file":
            r = con.execute("SELECT hash FROM files WHERE path=?", (a["target"],)).fetchone()
            if not r or not r[0]:
                die(f"File '{a['target']}' is not in the index (paths are repo-prefixed in a multi-repo workspace).")
            h = r[0]
        elif a["kind"] == "module":
            # sha1 over the module's file hashes SORTED BY HASH: must match
            # enrich, server.py _module_hash, and the Node edition, or enrich
            # treats this insight as changed and overwrites it on the next run
            hs = sorted((x[0] or "") for x in con.execute(
                "SELECT hash FROM files WHERE path LIKE ?", (a["target"] + "/%",)))
            h = hashlib.sha1("|".join(hs).encode()).hexdigest()
        else:
            h = ""  # topic/table notes have no single backing file; they don't auto-stale
        # Durable first: index.db is gitignored and disposable, so a row without
        # a docs/insights.json entry dies at the next pull-index or --rebuild.
        prefixes = [r[0][len("last_sha:"):] for r in
                    con.execute("SELECT key FROM meta WHERE key LIKE 'last_sha:%'").fetchall()]
        prefixes = [x for x in prefixes if x != "."]
        # Prefer a git-versioned root so the file is shareable. Fall back to the
        # workspace parent rather than failing: that is where the graph view has
        # always written docs/graph-assertions.json, the indexer reads both, and
        # a topic/table note has no path to infer a repo from. Never make an
        # existing caller pass a new argument.
        base = ROOT
        if prefixes:  # multi-root workspace: cwd is the parent, not a repo
            # module/file targets are repo-prefixed, so the repo is the first segment
            guess = a["target"] if a["kind"] == "module" else a["target"].split("/")[0] if a["kind"] == "file" else None
            root_arg = a.get("root")
            pick = (root_arg if root_arg in prefixes else None) or \
                   (guess if guess in prefixes else None) or \
                   (prefixes[0] if len(prefixes) == 1 else None)
            if pick:
                base = ROOT / pick
        f = base / "docs" / "insights.json"
        rel = f.relative_to(ROOT) if str(f).startswith(str(ROOT)) else f
        shared = base != ROOT or not prefixes
        items = []
        if f.exists():
            # Never clobber: a malformed file must not erase the team's insights.
            try:
                items = json.loads(f.read_text(encoding="utf-8"))
            except Exception as e:  # noqa: BLE001
                die(f"{rel} exists but is not valid JSON ({e}). Fix or remove it first.")
            if not isinstance(items, list):
                die(f"{rel} is not a JSON array. Fix it first.")
        items = [x for x in items if not (isinstance(x, dict) and x.get("target") == a["target"])]
        items.append({"target": a["target"], "kind": a["kind"], "hash": h,
                      "summary": a["summary"][:4000], "model": f"{author}:graph-view",
                      "generated_at": time.time()})
        items.sort(key=lambda x: str(x.get("target", "")))  # reviewable diffs
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(items, indent=2) + "\n", encoding="utf-8")
        con.execute("INSERT OR REPLACE INTO insights(target, kind, hash, summary, model, generated_at, source) "
                    "VALUES(?,?,?,?,?,?,'live')",
                    (a["target"], a["kind"], h, a["summary"][:4000], f"{author}:graph-view", time.time()))
        con.commit()
    finally:
        con.close()
    tip = "" if shared else ' (tip: pass "root":"<repo>" to place it inside a git-versioned repo)'
    print(f"Insight saved for {a['kind']} '{a['target']}' (provenance: {author}) and recorded in {rel}. "
          f"Served by explain/context_pack immediately; commit the file to share it{tip}.")

elif a.get("action") == "assert":
    if a.get("kind") not in ("kafka", "db", "http_endpoint", "http_call"):
        die("kind must be kafka|db|http_endpoint|http_call.")
    if len(a.get("evidence", "")) < 20:
        die("evidence must explain what convinced you (20+ chars): quote the code.")
    if a["kind"] == "kafka" and not (a.get("topic") and a.get("direction")):
        die("kafka assertions need topic and direction.")
    if a["kind"] == "db" and not a.get("table"):
        die("db assertions need table.")
    if a["kind"].startswith("http") and not a.get("path"):
        die("http assertions need path.")

    con = sqlite3.connect(f"file:{DB_PATH.as_posix()}?mode=ro", uri=True)
    row = con.execute("SELECT hash FROM files WHERE path=?", (a.get("file"),)).fetchone()
    con.close()
    if not row or not row[0]:
        die(f"File '{a.get('file')}' is not in the index (paths are repo-prefixed in a multi-repo workspace).")

    af = ROOT / "docs" / "graph-assertions.json"
    lst = []
    if af.exists():
        # Never clobber: a malformed file must not erase the team's assertions.
        try:
            lst = json.loads(af.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            die(f"docs/graph-assertions.json exists but is not valid JSON ({e}). Fix or remove it first.")
        if not isinstance(lst, list):
            die("docs/graph-assertions.json is not a JSON array. Fix it first.")
    rec = {"kind": a["kind"], "file": a["file"], "line": a.get("line", 0), "evidence": a["evidence"],
           "confidence": a.get("confidence") if a.get("confidence") in ("high", "medium", "low") else "medium",
           "author": author, "source_hash": row[0],
           "asserted_at": datetime.date.today().isoformat()}
    for k in ("topic", "direction", "table", "mode", "method", "path"):
        if a.get(k):
            rec[k] = a[k]
    lst = [x for x in lst if not (x.get("kind") == a["kind"] and x.get("file") == a["file"]
                                  and x.get("line") == rec["line"] and x.get("topic") == a.get("topic")
                                  and x.get("table") == a.get("table") and x.get("path") == a.get("path"))]
    lst.append(rec)
    af.parent.mkdir(parents=True, exist_ok=True)
    af.write_text(json.dumps(lst, indent=2) + "\n", encoding="utf-8")
    print(f"Asserted (provenance: {author}) and recorded in docs/graph-assertions.json ({len(lst)} total). "
          f"It enters the graph on the next index, marked STALE automatically if {a['file']} changes. "
          "Commit the file to share it.")

elif a.get("action") == "dismiss":
    # gap triage: a dismissed gap stops shouting but stays auditable. Stored in
    # the same reviewed file, kind "dismissal"; the export mutes matching gaps.
    if not a.get("gap") or not a.get("key"):
        die("dismiss needs gap (e.g. orphan_topic) and key (topic/table/path).")
    if len(a.get("reason", "")) < 10:
        die("reason must say why this gap is acceptable (10+ chars).")
    af = ROOT / "docs" / "graph-assertions.json"
    alist = []
    if af.exists():
        try:
            alist = json.loads(af.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            die(f"docs/graph-assertions.json is not valid JSON ({e}). Fix it first.")
        if not isinstance(alist, list):
            die("docs/graph-assertions.json is not a JSON array. Fix it first.")
    alist = [x for x in alist if not (x.get("kind") == "dismissal" and x.get("gap") == a["gap"] and x.get("key") == a["key"])]
    alist.append({"kind": "dismissal", "gap": a["gap"], "key": a["key"], "reason": a["reason"],
                  "author": author, "dismissed_at": datetime.date.today().isoformat()})
    af.parent.mkdir(parents=True, exist_ok=True)
    af.write_text(json.dumps(alist, indent=2) + "\n", encoding="utf-8")
    print(f"Dismissed {a['gap']} '{a['key']}' (by: {author}). It mutes in the worklist after reindex but stays auditable; commit the file to share.")

elif a.get("action") in ("retract", "reaffirm"):
    # lifecycle for existing assertions, keyed by the same natural key the
    # no-duplicate filter uses. retract removes; reaffirm re-verifies: the
    # source_hash moves to the evidence file's CURRENT hash, clearing STALE.
    af = ROOT / "docs" / "graph-assertions.json"
    if not af.exists():
        die("docs/graph-assertions.json does not exist; nothing to modify.")
    try:
        alist = json.loads(af.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        die(f"docs/graph-assertions.json is not valid JSON ({e}). Fix it first.")
    if not isinstance(alist, list):
        die("docs/graph-assertions.json is not a JSON array. Fix it first.")

    def key(x):
        return "|".join(str(v) for v in (x.get("kind"), x.get("file"), x.get("line", 0),
                                         x.get("topic", ""), x.get("table", ""), x.get("path", "")))
    target = key(a)
    hits = [x for x in alist if key(x) == target]
    if not hits:
        die("No matching assertion found in docs/graph-assertions.json (key: kind+file+line+topic/table/path).")
    if a["action"] == "retract":
        alist = [x for x in alist if key(x) != target]
        af.write_text(json.dumps(alist, indent=2) + "\n", encoding="utf-8")
        print(f"Retracted {len(hits)} assertion(s) (by: {author}); {len(alist)} remain. "
              "Reindex removes it from the graph; commit the file to share.")
    else:
        con = sqlite3.connect(f"file:{DB_PATH.as_posix()}?mode=ro", uri=True)
        row = con.execute("SELECT hash FROM files WHERE path=?", (a.get("file"),)).fetchone()
        con.close()
        if not row or not row[0]:
            die(f"File '{a.get('file')}' is not in the index; cannot reaffirm against it.")
        for x in alist:
            if key(x) == target:
                x["source_hash"] = row[0]
                x["reaffirmed_at"] = datetime.date.today().isoformat()
                x["reaffirmed_by"] = author
        af.write_text(json.dumps(alist, indent=2) + "\n", encoding="utf-8")
        print(f"Reaffirmed {len(hits)} assertion(s) against the current {a.get('file')} (by: {author}). "
              "STALE clears on the next index.")
else:
    die('action must be "insight", "assert", "dismiss", "retract", or "reaffirm".')
