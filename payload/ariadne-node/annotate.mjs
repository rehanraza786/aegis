#!/usr/bin/env node
/**
 * AEGIS annotate: write-back CLI for clients that are not MCP agents, above
 * all the VS Code graph view. Semantics are identical to the save_insight /
 * assert_edge MCP tools: insights are hash-keyed so they auto-stale, and
 * assertions land in docs/graph-assertions.json (git-versioned, PR-reviewed,
 * never clobbered on parse failure) with provenance preserved. Human input
 * gets its own provenance (`author: "human"`), so a person's annotation is
 * never mistaken for a parsed fact OR for a model's inference.
 *
 * Usage: node annotate.mjs '<json>'
 *   {"action":"insight","target":"billing-service","kind":"module","summary":"..."}
 *   {"action":"assert","kind":"kafka","file":"a/b.java","line":6,"evidence":"...",
 *    "confidence":"high","topic":"orders.created.prod","direction":"produce"}
 * Prints a one-line result on stdout; exits 1 with a reason on stderr.
 */
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DB_PATH = path.join(process.env.ARIADNE_HOME ?? ROOT, ".ariadne", "index.db");
const die = (msg) => { console.error(msg); process.exit(1); };

if (!fs.existsSync(DB_PATH)) die("Index not found, run the Ariadne indexer first.");
let a;
try { a = JSON.parse(process.argv[2] ?? ""); } catch { die("annotate expects one JSON argument; see the header of this file."); }
const author = a.author || "human";

if (a.action === "insight") {
  if (!["module", "file"].includes(a.kind) || !(a.summary?.length >= 40) || !a.target) {
    die("insight needs target, kind (module|file), and a summary of at least 40 chars.");
  }
  const db = new Database(DB_PATH);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS insights(target TEXT PRIMARY KEY, kind TEXT,
             hash TEXT, summary TEXT, model TEXT, generated_at REAL)`);
    let h = "";
    if (a.kind === "file") {
      h = db.prepare("SELECT hash FROM files WHERE path=?").get(a.target)?.hash ?? "";
      if (!h) die(`File '${a.target}' is not in the index (paths are repo-prefixed in a multi-repo workspace).`);
    } else {
      const hs = db.prepare("SELECT hash FROM files WHERE path LIKE ? ORDER BY path").all(a.target + "/%").map((r) => r.hash ?? "");
      h = crypto.createHash("sha1").update(hs.join("|")).digest("hex");
    }
    db.prepare("INSERT OR REPLACE INTO insights(target, kind, hash, summary, model, generated_at) VALUES(?,?,?,?,?,?)")
      .run(a.target, a.kind, h, a.summary.slice(0, 4000), `${author}:graph-view`, Date.now() / 1000);
  } finally { db.close(); }
  console.log(`Insight saved for ${a.kind} '${a.target}' (provenance: ${author}). Served by explain/context_pack immediately.`);

} else if (a.action === "assert") {
  if (!["kafka", "db", "http_endpoint", "http_call"].includes(a.kind)) die("kind must be kafka|db|http_endpoint|http_call.");
  if (!(a.evidence?.length >= 20)) die("evidence must explain what convinced you (20+ chars): quote the code.");
  if (a.kind === "kafka" && (!a.topic || !a.direction)) die("kafka assertions need topic and direction.");
  if (a.kind === "db" && !a.table) die("db assertions need table.");
  if (a.kind.startsWith("http") && !a.path) die("http assertions need path.");

  const db = new Database(DB_PATH, { readonly: true });
  let hash = null;
  try { hash = db.prepare("SELECT hash FROM files WHERE path=?").get(a.file)?.hash ?? null; } finally { db.close(); }
  if (!hash) die(`File '${a.file}' is not in the index (paths are repo-prefixed in a multi-repo workspace).`);

  const af = path.join(ROOT, "docs", "graph-assertions.json");
  let list = [];
  if (fs.existsSync(af)) {
    // Never clobber: a malformed file must not erase the team's assertions.
    try { list = JSON.parse(fs.readFileSync(af, "utf8")); }
    catch (e) { die(`docs/graph-assertions.json exists but is not valid JSON (${e.message}). Fix or remove it first.`); }
    if (!Array.isArray(list)) die("docs/graph-assertions.json is not a JSON array. Fix it first.");
  }
  const rec = { kind: a.kind, file: a.file, line: a.line ?? 0, evidence: a.evidence,
    confidence: ["high", "medium", "low"].includes(a.confidence) ? a.confidence : "medium",
    author, source_hash: hash, asserted_at: new Date().toISOString().slice(0, 10) };
  for (const k of ["topic", "direction", "table", "mode", "method", "path"]) if (a[k]) rec[k] = a[k];
  list = list.filter((x) => !(x.kind === a.kind && x.file === a.file && x.line === rec.line
    && x.topic === a.topic && x.table === a.table && x.path === a.path));
  list.push(rec);
  fs.mkdirSync(path.dirname(af), { recursive: true });
  fs.writeFileSync(af, JSON.stringify(list, null, 2) + "\n");
  console.log(`Asserted (provenance: ${author}) and recorded in docs/graph-assertions.json (${list.length} total). It enters the graph on the next index, marked STALE automatically if ${a.file} changes. Commit the file to share it.`);

} else {
  die('action must be "insight" or "assert".');
}
