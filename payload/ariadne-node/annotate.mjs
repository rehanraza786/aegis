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

/** Repo prefixes in a multi-root workspace (empty for a single repo). */
function rootPrefixes() {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db.prepare("SELECT key FROM meta WHERE key LIKE 'last_sha:%'").all()
      .map((r) => r.key.slice("last_sha:".length)).filter((x) => x !== ".");
  } catch { return []; } finally { db.close(); }
}

/** Directory whose docs/graph-assertions.json should hold an assertion about
 *  `file`. Paths are repo-prefixed, so the first segment names the repo.
 *  Writing to the multi-root parent "works" — the indexer reads it — but the
 *  parent is not a git repo, so nothing is versioned, reviewed, or shared.
 *  Parity: assertionsBase in server.mjs. */
function assertionsBase(file) {
  const prefixes = rootPrefixes();
  const seg = String(file ?? "").split("/")[0];
  return prefixes.includes(seg) ? path.join(ROOT, seg) : ROOT;
}

/** Repos a gap key touches. A dismissal has no evidence FILE, but it does have
 *  evidence: the thing being dismissed. An orphan topic has producers, a drift
 *  table has access sites, an unresolved expression has a path — and every path
 *  is repo-prefixed, so the graph can say which repo owns the argument. Same
 *  rule as everywhere else: anchor to the evidence. */
function dismissalRepos(gap, key) {
  const prefixes = rootPrefixes();
  if (!prefixes.length) return [];
  const paths = new Set();
  // "unresolved" keys are already a path:line
  const asPath = String(key ?? "").split(":")[0];
  if (asPath.includes("/")) paths.add(asPath);
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const add = (sql, ...args) => {
      try { for (const r of db.prepare(sql).all(...args)) if (r.path) paths.add(r.path); } catch { /* table may not exist */ }
    };
    add("SELECT f.path FROM msg_edges m JOIN files f ON f.id=m.file_id WHERE m.topic=?", key);
    add("SELECT f.path FROM db_access a JOIN files f ON f.id=a.file_id WHERE a.tbl=?", key);
    add("SELECT f.path FROM db_defs d JOIN files f ON f.id=d.file_id WHERE d.tbl=?", key);
    add("SELECT f.path FROM http_endpoints e JOIN files f ON f.id=e.file_id WHERE e.norm=? OR e.path=?", key, key);
    add("SELECT f.path FROM http_calls c JOIN files f ON f.id=c.file_id WHERE c.norm=? OR c.path=?", key, key);
  } finally { db.close(); }
  return [...new Set([...paths].map((p) => p.split("/")[0]))].filter((x) => prefixes.includes(x)).sort();
}

/** Every place an assertions file may live: parent, then each repo. */
function assertionFiles() {
  const out = [path.join(ROOT, "docs", "graph-assertions.json")];
  for (const r of rootPrefixes()) {
    const p = path.join(ROOT, r, "docs", "graph-assertions.json");
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Read an assertions file, refusing to proceed on malformed JSON: a stray
 *  comma must never silently erase the team's accumulated assertions. */
function readAssertions(af) {
  if (!fs.existsSync(af)) return null;
  let list;
  try { list = JSON.parse(fs.readFileSync(af, "utf8")); }
  catch (e) { die(`${path.relative(ROOT, af)} is not valid JSON (${e.message}). Fix or remove it first.`); }
  if (!Array.isArray(list)) die(`${path.relative(ROOT, af)} is not a JSON array. Fix it first.`);
  return list;
}

if (!fs.existsSync(DB_PATH)) die("Index not found, run the Ariadne indexer first.");
let a;
try { a = JSON.parse(process.argv[2] ?? ""); } catch { die("annotate expects one JSON argument; see the header of this file."); }
const author = a.author || "human";

if (a.action === "insight") {
  if (!["module", "file", "topic", "table"].includes(a.kind) || !(a.summary?.length >= 40) || !a.target) {
    die("insight needs target, kind (module|file|topic|table), and a summary of at least 40 chars.");
  }
  const db = new Database(DB_PATH);
  let rel, shared = true;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS insights(target TEXT PRIMARY KEY, kind TEXT,
             hash TEXT, summary TEXT, model TEXT, generated_at REAL, source TEXT)`);
    if (!db.prepare("SELECT COUNT(*) c FROM pragma_table_info('insights') WHERE name='source'").get().c) {
      db.exec("ALTER TABLE insights ADD COLUMN source TEXT");
    }
    let h = "";
    if (a.kind === "file") {
      h = db.prepare("SELECT hash FROM files WHERE path=?").get(a.target)?.hash ?? "";
      if (!h) die(`File '${a.target}' is not in the index (paths are repo-prefixed in a multi-repo workspace).`);
    } else if (a.kind === "module") {
      // sha1 over the module's file hashes SORTED BY HASH: must match
      // enrich, server.mjs moduleHash, and the Python edition, or enrich
      // treats this insight as changed and overwrites it on the next run
      let row = null;
      try { row = db.prepare("SELECT hash FROM module_hashes WHERE module=?").get(a.target); } catch { /* older index */ }
      if (row) h = row.hash;
      else {
        const lo = a.target + "/", hi = lo.slice(0, -1) + String.fromCharCode(lo.charCodeAt(lo.length - 1) + 1);
        const hs = db.prepare("SELECT hash FROM files WHERE path >= ? AND path < ?").all(lo, hi).map((r) => r.hash ?? "");
        h = crypto.createHash("sha1").update(hs.sort().join("|")).digest("hex");
      }
    } // topic/table notes have no single backing file; they don't auto-stale
    // Durable first: index.db is gitignored and disposable, so a row without a
    // docs/insights.json entry dies at the next pull-index or --rebuild.
    const prefixes = db.prepare("SELECT key FROM meta WHERE key LIKE 'last_sha:%'").all()
      .map((r) => r.key.slice("last_sha:".length)).filter((x) => x !== ".");
    // Prefer a git-versioned root so the file is shareable. Fall back to the
    // workspace parent rather than failing: that is where the graph view has
    // always written docs/graph-assertions.json, the indexer reads both, and a
    // topic/table note has no path to infer a repo from. Never make an existing
    // caller pass a new argument.
    let baseDir = ROOT;
    if (prefixes.length) { // multi-root workspace: cwd is the parent, not a repo
      // module/file targets are repo-prefixed, so the repo is the first segment
      const guess = a.kind === "module" ? a.target : a.kind === "file" ? String(a.target).split("/")[0] : null;
      const pick = (a.root && prefixes.includes(a.root) ? a.root : null)
        ?? (prefixes.includes(guess) ? guess : null)
        ?? (prefixes.length === 1 ? prefixes[0] : null);
      if (pick) baseDir = path.join(ROOT, pick);
    }
    const f = path.join(baseDir, "docs", "insights.json");
    rel = path.relative(ROOT, f);
    shared = baseDir !== ROOT || !prefixes.length;
    let list = [];
    if (fs.existsSync(f)) {
      // Never clobber: a malformed file must not erase the team's insights.
      try { list = JSON.parse(fs.readFileSync(f, "utf8")); }
      catch (e) { die(`${rel} exists but is not valid JSON (${e.message}). Fix or remove it first.`); }
      if (!Array.isArray(list)) die(`${rel} is not a JSON array. Fix it first.`);
    }
    list = list.filter((x) => x?.target !== a.target);
    list.push({ target: a.target, kind: a.kind, hash: h, summary: a.summary.slice(0, 4000),
                model: `${author}:graph-view`, generated_at: Date.now() / 1000 });
    list.sort((x, y) => String(x.target).localeCompare(String(y.target))); // reviewable diffs
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(list, null, 2) + "\n");
    db.prepare("INSERT OR REPLACE INTO insights(target, kind, hash, summary, model, generated_at, source) VALUES(?,?,?,?,?,?,'live')")
      .run(a.target, a.kind, h, a.summary.slice(0, 4000), `${author}:graph-view`, Date.now() / 1000);
  } finally { db.close(); }
  console.log(`Insight saved for ${a.kind} '${a.target}' (provenance: ${author}) and recorded in ${rel}. Served by explain/context_pack immediately; commit the file to share it${shared ? "" : " (tip: pass \"root\":\"<repo>\" to place it inside a git-versioned repo)"}.`);

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

  const af = path.join(assertionsBase(a.file), "docs", "graph-assertions.json");
  let list = readAssertions(af) ?? [];
  const rec = { kind: a.kind, file: a.file, line: a.line ?? 0, evidence: a.evidence,
    confidence: ["high", "medium", "low"].includes(a.confidence) ? a.confidence : "medium",
    author, source_hash: hash, asserted_at: new Date().toISOString().slice(0, 10) };
  for (const k of ["topic", "direction", "table", "mode", "method", "path"]) if (a[k]) rec[k] = a[k];
  list = list.filter((x) => !(x.kind === a.kind && x.file === a.file && x.line === rec.line
    && x.topic === a.topic && x.table === a.table && x.path === a.path));
  list.push(rec);
  fs.mkdirSync(path.dirname(af), { recursive: true });
  fs.writeFileSync(af, JSON.stringify(list, null, 2) + "\n");
  console.log(`Asserted (provenance: ${author}) and recorded in ${path.relative(ROOT, af)} (${list.length} total). It enters the graph on the next index, marked STALE automatically if ${a.file} changes. Commit the file to share it.`);

} else if (a.action === "dismiss") {
  // gap triage: a dismissed gap stops shouting but stays auditable. Stored in
  // the same reviewed file, kind "dismissal"; the export mutes matching gaps.
  if (!a.gap || !a.key) die("dismiss needs gap (e.g. orphan_topic) and key (topic/table/path).");
  if (!(a.reason?.length >= 10)) die("reason must say why this gap is acceptable (10+ chars).");
  // Anchor to the evidence, like every other write. Ambiguity is refused rather
  // than written to the multi-root parent: that parent is not a git repo, so
  // "succeeded" there means unversioned, unreviewed, and unshared.
  const prefixes = rootPrefixes();
  let dismissBase = ROOT;
  if (prefixes.length) {
    let pick = a.root && prefixes.includes(a.root) ? a.root : null;
    if (!pick) {
      const repos = dismissalRepos(a.gap, a.key);
      if (repos.length === 1) pick = repos[0];
      else {
        const opts = (repos.length ? repos : prefixes).join(", ");
        die(`'${a.key}' ${repos.length ? `spans ${repos.length} repos` : "could not be traced to a repo"}; pass "root":"<repo>" so the dismissal lands somewhere git-versioned. Candidates: ${opts}.`);
      }
    }
    dismissBase = path.join(ROOT, pick);
  }
  const af = path.join(dismissBase, "docs", "graph-assertions.json");
  let list = readAssertions(af) ?? [];
  list = list.filter((x) => !(x.kind === "dismissal" && x.gap === a.gap && x.key === a.key));
  list.push({ kind: "dismissal", gap: a.gap, key: a.key, reason: a.reason, author,
    dismissed_at: new Date().toISOString().slice(0, 10) });
  fs.mkdirSync(path.dirname(af), { recursive: true });
  fs.writeFileSync(af, JSON.stringify(list, null, 2) + "\n");
  console.log(`Dismissed ${a.gap} '${a.key}' (by: ${author}) in ${path.relative(ROOT, af)}. It mutes in the worklist after reindex but stays auditable; commit the file to share.`);

} else if (a.action === "retract" || a.action === "reaffirm") {
  // lifecycle for existing assertions, keyed by the same natural key the
  // no-duplicate filter uses. retract removes; reaffirm re-verifies: the
  // source_hash moves to the evidence file's CURRENT hash, clearing STALE.
  // The record may live in the parent (older placements) or in the repo that
  // owns its evidence file, so edit whichever one actually holds it.
  const key = (x) => [x.kind, x.file, x.line ?? 0, x.topic ?? "", x.table ?? "", x.path ?? ""].join("|");
  const target = key(a);
  let af = null, list = null, hits = [];
  for (const cand of assertionFiles()) {
    const part = readAssertions(cand);
    if (!part) continue;
    const found = part.filter((x) => key(x) === target);
    if (found.length) { af = cand; list = part; hits = found; break; }
  }
  if (!af) die("No matching assertion found in any docs/graph-assertions.json (key: kind+file+line+topic/table/path).");
  if (a.action === "retract") {
    list = list.filter((x) => key(x) !== target);
    fs.writeFileSync(af, JSON.stringify(list, null, 2) + "\n");
    console.log(`Retracted ${hits.length} assertion(s) (by: ${author}); ${list.length} remain. Reindex removes it from the graph; commit the file to share.`);
  } else {
    const db = new Database(DB_PATH, { readonly: true });
    let hash = null;
    try { hash = db.prepare("SELECT hash FROM files WHERE path=?").get(a.file)?.hash ?? null; } finally { db.close(); }
    if (!hash) die(`File '${a.file}' is not in the index; cannot reaffirm against it.`);
    for (const x of list) if (key(x) === target) { x.source_hash = hash; x.reaffirmed_at = new Date().toISOString().slice(0, 10); x.reaffirmed_by = author; }
    fs.writeFileSync(af, JSON.stringify(list, null, 2) + "\n");
    console.log(`Reaffirmed ${hits.length} assertion(s) against the current ${a.file} (by: ${author}). STALE clears on the next index.`);
  }

} else {
  die('action must be "insight", "assert", "dismiss", "retract", or "reaffirm".');
}
