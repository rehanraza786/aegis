#!/usr/bin/env python3
"""AEGIS enrich (Python edition). LLM semantic layer over the graph.
Hash-cached insights per module/hotspot file; providers: ANTHROPIC_API_KEY,
OPENAI_API_KEY (+OPENAI_BASE_URL for local Ollama/vLLM), or --provider mock."""
import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path.cwd()
DB = Path(os.environ.get("ARIADNE_HOME", ROOT)) / ".ariadne" / "index.db"

ap = argparse.ArgumentParser()
ap.add_argument("--limit", type=int, default=20)
ap.add_argument("--plan", action="store_true")
ap.add_argument("--apply")
ap.add_argument("--provider", choices=["anthropic", "openai", "mock"],
                default=("anthropic" if os.environ.get("ANTHROPIC_API_KEY")
                         else "openai" if os.environ.get("OPENAI_API_KEY") else None))
A = ap.parse_args()
if not DB.exists():
    sys.exit("Index not found, run the indexer first.")
if not A.provider and not A.plan and not A.apply:
    sys.exit("No LLM provider configured. Set ANTHROPIC_API_KEY, or OPENAI_API_KEY "
             "(+OPENAI_BASE_URL for local servers like Ollama), or pass --provider mock. "
             "Enrichment is opt-in, see PRIVACY.md.")

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
con.execute("""CREATE TABLE IF NOT EXISTS insights(
  target TEXT PRIMARY KEY, kind TEXT, hash TEXT, summary TEXT,
  model TEXT, generated_at REAL)""")
q = lambda sql, *a: con.execute(sql, a).fetchall()
svc = lambda p: p.split("/")[0]


def _post(url, headers, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def complete(prompt):
    if A.provider == "mock":
        i = prompt.index("TARGET:")
        return f"[mock insight] {prompt[i:i+60]}…, intent summarized deterministically for self-tests."
    model = os.environ.get("AEGIS_MODEL")
    if A.provider == "anthropic":
        j = _post("https://api.anthropic.com/v1/messages",
                  {"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"},
                  {"model": model or "claude-haiku-4-5", "max_tokens": 400,
                   "messages": [{"role": "user", "content": prompt}]})
        return "".join(c.get("text", "") for c in j["content"])
    base = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    j = _post(f"{base}/chat/completions",
              {"authorization": f"Bearer {os.environ.get('OPENAI_API_KEY', 'local')}"},
              {"model": model or "gpt-4o-mini", "max_tokens": 400,
               "messages": [{"role": "user", "content": prompt}]})
    return j["choices"][0]["message"]["content"]


def module_targets():
    mods = {}
    for f in q("SELECT path, hash FROM files"):
        mods.setdefault(svc(f["path"]), []).append(f["hash"] or "")
    return [{"kind": "module", "target": name,
             "hash": hashlib.sha1("|".join(sorted(hs)).encode()).hexdigest()}
            for name, hs in mods.items()]


def hotspot_targets(n=12):
    return [{"kind": "file", "target": r["path"], "hash": r["hash"] or ""}
            for r in q("SELECT f.path, f.hash, COUNT(e.src) d FROM files f "
                       "JOIN edges e ON e.dst=f.id GROUP BY f.id ORDER BY d DESC LIMIT ?", n)]


def prompt_for(t):
    header = ("You are enriching a codebase knowledge graph. Write a dense, factual summary "
              "(5-8 sentences): purpose/intent, key responsibilities, how it connects to the rest "
              "of the system, and any invariants or gotchas a developer must know before changing it. "
              f"No preamble, no markdown headers.\n\nTARGET: {t['kind']} {t['target']}\n")
    if t["kind"] == "module":
        like = t["target"] + "/%"
        syms = q("SELECT s.name FROM symbols s JOIN files f ON f.id=s.file_id "
                 "WHERE f.path LIKE ? AND s.kind IN ('class','type') LIMIT 25", like)
        topics = q("SELECT DISTINCT m.topic, m.direction FROM msg_edges m JOIN files f ON f.id=m.file_id WHERE f.path LIKE ?", like)
        tables = q("SELECT DISTINCT a.tbl, a.mode FROM db_access a JOIN files f ON f.id=a.file_id WHERE f.path LIKE ?", like)
        eps = q("SELECT e.method, e.path FROM http_endpoints e JOIN files f ON f.id=e.file_id WHERE f.path LIKE ? LIMIT 15", like)
        return header + (
            f"Classes/types: {', '.join(s['name'] for s in syms) or 'n/a'}\n"
            f"Kafka: {', '.join(x['direction'] + ' ' + x['topic'] for x in topics) or 'none'}\n"
            f"DB tables: {', '.join(x['tbl'] + '(' + x['mode'] + ')' for x in tables) or 'none'}\n"
            f"HTTP endpoints: {', '.join(e['method'] + ' ' + e['path'] for e in eps) or 'none'}\n")
    outline = q("SELECT s.name, s.kind, s.parent FROM symbols s JOIN files f ON f.id=s.file_id "
                "WHERE f.path=? ORDER BY s.line LIMIT 40", t["target"])
    callers = q("SELECT COUNT(*) c FROM edges e JOIN files f ON f.id=e.dst WHERE f.path=?", t["target"])[0]["c"]
    return header + (
        "Outline: " + ", ".join((s["parent"] + "." if s["parent"] else "") + s["name"] + ":" + s["kind"] for s in outline)
        + f"\nDependent files: {callers} (high blast radius)\n")


targets = module_targets() + hotspot_targets()

if A.plan:
    plan = []
    for t in targets:
        prev = con.execute("SELECT hash FROM insights WHERE target=?", (t["target"],)).fetchone()
        if prev and prev["hash"] == t["hash"]:
            continue
        plan.append({**t, "prompt": prompt_for(t)})
        if len(plan) >= A.limit:
            break
    print(json.dumps(plan))
    sys.exit(0)

if A.apply:
    items = json.loads(Path(A.apply).read_text(encoding="utf-8"))
    for it in items:
        con.execute("INSERT OR REPLACE INTO insights(target, kind, hash, summary, model, generated_at) VALUES(?,?,?,?,?,?)",
                    (it["target"], it["kind"], it["hash"], str(it["summary"])[:4000], it.get("model", "external"), time.time()))
    con.commit()
    print(f"Applied {len(items)} insights.")

fresh = cached = failed = 0
if A.apply:
    targets = []
for t in targets:
    if fresh >= A.limit:
        break
    prev = con.execute("SELECT hash FROM insights WHERE target=?", (t["target"],)).fetchone()
    if prev and prev["hash"] == t["hash"]:
        cached += 1
        continue
    try:
        summary = complete(prompt_for(t)).strip()
        con.execute("INSERT OR REPLACE INTO insights(target, kind, hash, summary, model, generated_at) VALUES(?,?,?,?,?,?)",
                    (t["target"], t["kind"], t["hash"], summary,
                     "mock" if A.provider == "mock" else os.environ.get("AEGIS_MODEL", A.provider), time.time()))
        fresh += 1
        print(f"  + {t['kind']}: {t['target']}")
    except Exception as e:  # noqa: BLE001
        failed += 1
        print(f"  ! {t['target']}: {e}", file=sys.stderr)
con.commit()
print(f"Enrichment: {fresh} generated, {cached} cached (hash-unchanged), {failed} failed.")

rows = q("SELECT target, kind, summary FROM insights ORDER BY kind, target")
if rows:
    out = ROOT / "docs" / "generated"
    out.mkdir(parents=True, exist_ok=True)
    md = ("<!-- generated by aegis enrich, cached by content hash; do not edit -->\n\n"
          "# Semantic Insights (LLM-enriched)\n\n"
          "_Each entry is regenerated only when its content hash changes._\n\n")
    for r in rows:
        if r["kind"] == "module":
            md += f"## Module: {r['target']}\n{r['summary']}\n\n"
    hot = [r for r in rows if r["kind"] == "file"]
    if hot:
        md += "## High-blast-radius files\n\n" + "\n\n".join(f"**`{r['target']}`**, {r['summary']}" for r in hot) + "\n"
    (out / "insights.md").write_text(md, encoding="utf-8")
    print("  + docs/generated/insights.md")
