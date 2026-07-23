#!/usr/bin/env python3
"""
Ingest a compiler-grade SCIP index (from scip-typescript, scip-java, etc.)
into the .ariadne SQLite database, adding symbol-level precision on top of
the regex baseline:

  scip_defs:  every definition   (symbol -> path, line, docs)
  scip_refs:  every reference    (symbol <- path, line)
  edges kind='ref': file->file edges derived from resolved references

Usage:
  # TypeScript/React (run at the dir containing tsconfig.json):
  npx @sourcegraph/scip-typescript index --output index.scip
  # Java (Gradle/Maven project):
  scip-java index --output index.scip
  # Then:
  python3 .ariadne/scip_ingest.py index.scip [more.scip ...]

Requires: pip install protobuf   (scip_pb2.py is bundled alongside this file)
"""

import sqlite3
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import scip_pb2  # noqa: E402

REPO_ROOT = Path(
    subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
    or "."
).resolve()
DB_PATH = REPO_ROOT / ".ariadne" / "index.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS scip_defs(
  symbol TEXT, path TEXT, line INTEGER, docs TEXT,
  PRIMARY KEY(symbol, path, line));
CREATE TABLE IF NOT EXISTS scip_refs(
  symbol TEXT, path TEXT, line INTEGER,
  PRIMARY KEY(symbol, path, line));
CREATE INDEX IF NOT EXISTS idx_refs_symbol ON scip_refs(symbol);
CREATE INDEX IF NOT EXISTS idx_defs_path ON scip_defs(path);
"""

DEFINITION_ROLE = 0x1  # scip.SymbolRole.Definition


def display_name(symbol: str) -> str:
    """Extract a human-friendly trailing name from a SCIP symbol string.
    e.g. '... `UserService`#findById().' -> 'findById'"""
    tail = symbol.rstrip(".").split("/")[-1]
    for sep in ("#", "`"):
        if sep in tail:
            tail = tail.split(sep)[-1] or tail.split(sep)[-2]
    return tail.strip("`#().").strip() or symbol


def ingest(paths):
    con = sqlite3.connect(DB_PATH)
    con.executescript(SCHEMA)
    files_by_path = {r[1]: r[0] for r in con.execute("SELECT id, path FROM files")}

    total_defs = total_refs = 0
    def_file_by_symbol = {}

    for scip_path in paths:
        idx = scip_pb2.Index()
        idx.ParseFromString(Path(scip_path).read_bytes())
        root = idx.metadata.project_root.replace("file://", "")
        try:
            prefix = str(Path(root).resolve().relative_to(REPO_ROOT))
        except ValueError:
            prefix = ""
        prefix = "" if prefix in (".", "") else prefix + "/"

        for doc in idx.documents:
            rel = prefix + doc.relative_path
            con.execute("DELETE FROM scip_defs WHERE path=?", (rel,))
            con.execute("DELETE FROM scip_refs WHERE path=?", (rel,))
            docs_by_symbol = {s.symbol: "\n".join(s.documentation)[:300] for s in doc.symbols}
            # batched per document: a large SCIP index carries millions of
            # occurrences, and executemany runs the row loop in C instead of a
            # Python-level con.execute per row (order preserved, so OR REPLACE
            # keeps the same winner)
            def_rows, ref_rows = [], []
            for occ in doc.occurrences:
                if occ.symbol.startswith("local "):
                    continue  # file-local variables add noise, not knowledge
                line = (occ.range[0] if occ.range else 0) + 1
                if occ.symbol_roles & DEFINITION_ROLE:
                    def_rows.append((occ.symbol, rel, line, docs_by_symbol.get(occ.symbol, "")))
                    def_file_by_symbol[occ.symbol] = rel
                else:
                    ref_rows.append((occ.symbol, rel, line))
            if def_rows:
                con.executemany("INSERT OR REPLACE INTO scip_defs VALUES(?,?,?,?)", def_rows)
            if ref_rows:
                con.executemany("INSERT OR REPLACE INTO scip_refs VALUES(?,?,?)", ref_rows)
            total_defs += len(def_rows)
            total_refs += len(ref_rows)

    # Derive precise file->file reference edges (replaces guesswork for indexed files)
    edge_rows = []
    rows = con.execute("SELECT DISTINCT symbol, path FROM scip_refs").fetchall()
    for sym, ref_path in rows:
        def_path = def_file_by_symbol.get(sym)
        if not def_path or def_path == ref_path:
            continue
        src, dst = files_by_path.get(ref_path), files_by_path.get(def_path)
        if src and dst:
            edge_rows.append((src, dst))
    if edge_rows:
        con.executemany("INSERT OR IGNORE INTO edges(src, dst, kind) VALUES(?,?,'ref')", edge_rows)
    edge_count = len(edge_rows)

    con.execute("INSERT OR REPLACE INTO meta VALUES('scip_ingested_at', ?)", (str(time.time()),))
    con.execute("INSERT OR REPLACE INTO meta VALUES('scip_sha', ?)", (
        subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True,
                       cwd=REPO_ROOT).stdout.strip(),))
    con.commit()
    print(f"SCIP ingest: {total_defs} definitions, {total_refs} references, "
          f"{edge_count} ref-edges from {len(paths)} index file(s).")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    if not DB_PATH.exists():
        print("Run the baseline indexer first: python3 .ariadne/indexer.py --full")
        sys.exit(1)
    ingest(sys.argv[1:])
