#!/usr/bin/env node
/**
 * Ariadne (GraphRAG-style) MCP server (Node edition) over the index built by indexer.mjs.
 * Production traits: read-only DB access, WAL-friendly, input validation,
 * graceful errors surfaced to the model instead of crashes, query limits.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { execFileSync, execFile } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { pathsMatch } from "./http.mjs";
import fs from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { approvedFiles } from "./trust.mjs";

// The payload finally carries a version identity: surfaced by index_status so
// "which Ariadne is this workspace running?" is a tool call, not archaeology.
let PAYLOAD_VERSION = "unknown";
try {
  PAYLOAD_VERSION = JSON.parse(fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8")).version ?? "unknown";
} catch { /* vendored without a manifest */ }
import path from "node:path";

function git(args) {
  try { return execFileSync("git", args, { encoding: "utf8", timeout: 15_000 }).trim(); }
  catch { return ""; }
}
const REPO_ROOT = git(["rev-parse", "--show-toplevel"]) || process.cwd();
const GR_DIR = path.join(process.env.ARIADNE_HOME ?? REPO_ROOT, ".ariadne");
const DB_PATH = path.join(GR_DIR, "index.db");

let _db = null;
function db() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error("Index not found. Build it with: node .ariadne/indexer.mjs --full");
  }
  if (!_db) {
    _db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    _db.pragma("busy_timeout = 5000");
  }
  return _db;
}
// The indexer may replace the DB underneath us; reopen on any sqlite error once.
function withDb(fn) {
  try { return fn(db()); }
  catch (e) {
    if (String(e).includes("SQLITE")) { try { _db?.close(); } catch {} _db = null; return fn(db()); }
    throw e;
  }
}
// ---- result budget: no single tool call may flood the model's context ----
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(GR_DIR, "config.json"), "utf8")); } catch { /* defaults */ }
const MAX_ROWS = cfg.maxToolRows ?? 50;
const MAX_BYTES = cfg.maxToolBytes ?? 24000;
const SUMMARY_THRESHOLD = cfg.summaryThreshold ?? 40;

const hasWarning = (r) => r && typeof r === "object" &&
  (r.warning || r.warnings || r.unresolved_expressions || r.unmatched_calls);

/** Cap rows and bytes. Entries carrying warnings are kept FIRST and never dropped.
 *  a truncated dump that silently discards the drift warning is worse than useless. */
function budget(result) {
  if (Array.isArray(result) && result.length > MAX_ROWS) {
    const total = result.length;
    const warned = result.filter(hasWarning);
    const plain = result.filter((r) => !hasWarning(r));
    const kept = [...warned, ...plain].slice(0, MAX_ROWS);
    result = {
      showing: kept.length,
      of: total,
      note: `Truncated to protect context (warnings are kept first and never dropped). Narrow with a filter argument, or raise 'limit'.`,
      results: kept,
    };
  }
  let out = typeof result === "string" ? result : JSON.stringify(result, null, 1);
  if (out.length > MAX_BYTES) {
    out = out.slice(0, MAX_BYTES) +
      `\n\n… [truncated at ${MAX_BYTES} chars to protect context. Narrow the query, pass a filter argument, or query one item at a time.]`;
  }
  return out;
}

const j = (x) => JSON.stringify(x, null, 1);
const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : j(s) }] });
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi ?? lo, Number.isFinite(n) ? n : lo));

// Every tool returns an error message (not a crash) so the agent can adapt.
function tool(server, name, description, schema, handler) {
  server.registerTool(name, { description, inputSchema: schema }, async (args) => {
    try { return text(budget(await handler(args))); }
    catch (e) { return text(`Error in ${name}: ${e.message ?? e}`); }
  });
}

const server = new McpServer({ name: "ariadne", version: "2.0.0" });

tool(server, "index_status",
  "Check index freshness: file/symbol/edge counts and whether the indexed git SHA matches HEAD. Call first if results seem stale.",
  {}, () => withDb((d) => {
    const c = (sql) => d.prepare(sql).get().c;
    const indexed = d.prepare("SELECT value FROM meta WHERE key='last_sha'").get()?.value ?? null;
    const head = git(["rev-parse", "HEAD"]);
    return { files: c("SELECT COUNT(*) c FROM files"), symbols: c("SELECT COUNT(*) c FROM symbols"),
      edges: c("SELECT COUNT(*) c FROM edges"), indexed_sha: indexed, head_sha: head, fresh: indexed === head,
      payload_version: PAYLOAD_VERSION };
  }));

tool(server, "search_code",
  "Full-text search over all code. Returns matching chunks with path and start line. Use for 'where is X handled/configured/used' questions instead of reading files.",
  { query: z.string().min(2).max(200), limit: z.number().int().optional() },
  ({ query, limit }) => withDb((d) => {
    const safe = '"' + query.replaceAll('"', '""') + '"';
    const rows = d.prepare(
      `SELECT path, start_line, snippet(chunks, 2, '>>>', '<<<', ' … ', 24) AS snippet
       FROM chunks WHERE chunks MATCH ? ORDER BY rank LIMIT ?`
).all(safe, clamp(limit ?? 8, 1, 25));
    // Attribute each hit to its enclosing symbol: "UserService.findById" beats a bare line
    // number, and saves the agent an open-the-file round trip to find out what it hit.
    const encl = d.prepare(`SELECT s.name, s.parent FROM symbols s JOIN files f ON f.id=s.file_id
      WHERE f.path=? AND s.line<=? ORDER BY s.line DESC LIMIT 1`);
    for (const r of rows) {
      const e = encl.get(r.path, r.start_line);
      if (e) r.in_symbol = (e.parent ? e.parent + "." : "") + e.name;
    }
    return rows.length ? rows : "No matches.";
  }));

tool(server, "context_pack",
  "ONE call that assembles everything relevant to working on a target (a file path, class, or method): its outline, callers, blast radius, the Kafka topics / DB tables / HTTP endpoints it touches, the architectural decisions governing those, and any cached insight. Use this INSTEAD of six separate lookups when starting work on something, it is the cheapest way to load focused context, and it is budgeted so it cannot flood the window.",
  { target: z.string().min(1).max(300) },
  ({ target }) => withDb((d) => {
    // resolve target -> a file (accept a path, or a symbol name)
    let file = d.prepare("SELECT id, path, lang FROM files WHERE path=?").get(target);
    let symbol = null;
    if (!file) {
      const sym = d.prepare(`SELECT s.name, s.parent, s.kind, s.line, s.signature, f.id fid, f.path
        FROM symbols s JOIN files f ON f.id=s.file_id
        WHERE s.name=? OR (s.parent || '.' || s.name)=? ORDER BY (s.kind='class') DESC LIMIT 1`).get(target, target);
      if (sym) { symbol = sym; file = { id: sym.fid, path: sym.path }; }
    }
    if (!file) {
      const like = d.prepare("SELECT id, path FROM files WHERE path LIKE ? LIMIT 1").get("%" + target + "%");
      if (like) file = like;
    }
    if (!file) return `Target '${target}' not found. Try find_symbol or search_code first.`;

    const cap = (a, n) => (a.length > n ? [...a.slice(0, n), `…and ${a.length - n} more`] : a);
    const mod = file.path.split("/")[0];

    const outline = d.prepare(`SELECT name, kind, line, parent FROM symbols WHERE file_id=? ORDER BY line LIMIT 25`).all(file.id);
    const callers = symbol
      ? d.prepare(`SELECT s.name caller, f.path, c.line FROM calls c JOIN symbols s ON s.id=c.src_symbol
                   JOIN files f ON f.id=s.file_id WHERE c.callee=? LIMIT 15`).all(symbol.name)
      : [];
    const dependents = d.prepare(`SELECT f2.path FROM edges e JOIN files f2 ON f2.id=e.src WHERE e.dst=? LIMIT 15`).all(file.id).map((r) => r.path);
    const depCount = d.prepare("SELECT COUNT(*) c FROM edges WHERE dst=?").get(file.id).c;

    const topics = d.prepare("SELECT DISTINCT topic, direction FROM msg_edges WHERE file_id=?").all(file.id);
    const tables = d.prepare("SELECT DISTINCT tbl, mode FROM db_access WHERE file_id=?").all(file.id);
    const endpoints = d.prepare("SELECT method, path FROM http_endpoints WHERE file_id=? LIMIT 15").all(file.id);
    const httpCalls = d.prepare("SELECT method, path FROM http_calls WHERE file_id=? LIMIT 15").all(file.id);

    // decisions governing anything this file touches
    let govern = [];
    try {
      const targets = [...topics.map((t) => t.topic), ...tables.map((t) => t.tbl), mod];
      if (targets.length) {
        const marks = targets.map(() => "?").join(",");
        govern = d.prepare(`SELECT DISTINCT dc.id, dc.title, dc.status FROM decision_links dl
          JOIN decisions dc ON dc.id=dl.decision_id
          WHERE dl.target IN (${marks}) AND dc.valid_until IS NULL`).all(...targets);
      }
    } catch { /* decisions table may predate this build */ }

    let insight = null;
    try {
      const row = d.prepare("SELECT summary FROM insights WHERE target=? OR target=? LIMIT 1").get(file.path, mod);
      if (row) insight = row.summary;
    } catch { /* no insights yet */ }

    // which tests import this target, and the behaviors they assert
    let tests = "none found — no test imports this target";
    try {
      const tf = d.prepare(`SELECT DISTINCT f2.path FROM edges e JOIN files f2 ON f2.id=e.src
        WHERE e.dst=? AND f2.is_test=1 LIMIT 5`).all(file.id).map((r) => r.path);
      if (tf.length) {
        const marks = tf.map(() => "?").join(",");
        // jest strings are already prose; camelCase/snake_case method names get decamelized
        const decamel = (s) => s.includes(" ") ? s : s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
        const behaviors = d.prepare(`SELECT tc.name FROM test_cases tc JOIN files f2 ON f2.id=tc.file_id
          WHERE f2.path IN (${marks}) LIMIT 5`).all(...tf).map((r) => decamel(r.name));
        tests = { files: tf, behaviors };
      }
    } catch { /* files.is_test / test_cases may predate this index build */ }

    return {
      target: symbol ? `${symbol.parent ? symbol.parent + "." : ""}${symbol.name} (${symbol.kind})` : file.path,
      file: file.path + (symbol ? `:${symbol.line}` : ""),
      module: mod,
      outline: cap(outline.map((o) => `${o.parent ? o.parent + "." : ""}${o.name}:${o.kind}@${o.line}`), 25),
      callers: callers.length ? callers.map((c) => `${c.caller} (${c.path}:${c.line})`) : "none recorded (heuristic; use find_references for certainty)",
      blast_radius: { direct_dependents: depCount, sample: dependents },
      kafka: topics.length ? topics.map((t) => `${t.direction} ${t.topic}`) : "none",
      database: tables.length ? tables.map((t) => `${t.mode} ${t.tbl}`) : "none",
      http: {
        defines: endpoints.map((e) => `${e.method} ${e.path}`),
        calls: httpCalls.map((c) => `${c.method} ${c.path}`),
      },
      governing_decisions: govern.length ? govern.map((g) => `${g.id}: ${g.title}`) : "none recorded",
      cached_insight: insight ?? "none, run enrichment, or synthesize and save_insight",
      tests,
      next: "This is the focused context for this target. Go deeper only where needed: find_references (certainty), blast_radius (full list), message_flow/db_map/http_map (the other side of a seam).",
    };
  }));

tool(server, "find_symbol",
  "Look up functions/classes/types by name (substring by default). Returns kind, signature, file, line, enough to reference without reading the file.",
  { name: z.string().min(1).max(120), exact: z.boolean().optional() },
  ({ name, exact }) => withDb((d) => {
    const rows = exact
      ? d.prepare(`SELECT s.name, s.kind, s.signature, s.parent, f.path, s.line FROM symbols s
                   JOIN files f ON f.id=s.file_id WHERE s.name = ? ORDER BY s.name LIMIT 30`).all(name)
      : d.prepare(`SELECT s.name, s.kind, s.signature, s.parent, f.path, s.line FROM symbols s
                   JOIN files f ON f.id=s.file_id WHERE s.name LIKE ? ORDER BY s.name LIMIT 30`).all(`%${name}%`);
    return rows.length ? rows : "No symbol found.";
  }));

tool(server, "file_outline",
  "A file's skeleton: language, line count, all symbols with signatures, plus its imports and importers. Use INSTEAD of reading the file when you only need structure.",
  { path: z.string().min(1).max(500) },
  ({ path: p }) => withDb((d) => {
    const f = d.prepare("SELECT * FROM files WHERE path=?").get(p);
    if (!f) return "File not in index.";
    return {
      path: p, lang: f.lang, lines: f.lines,
      symbols: d.prepare("SELECT name, kind, line, signature, parent FROM symbols WHERE file_id=? ORDER BY line LIMIT ?").all(f.id, MAX_ROWS),
      symbol_count: d.prepare("SELECT COUNT(*) c FROM symbols WHERE file_id=?").get(f.id).c,
      imports: d.prepare("SELECT f2.path p FROM edges e JOIN files f2 ON f2.id=e.dst WHERE e.src=?").all(f.id).map((r) => r.p),
      imported_by: d.prepare("SELECT f2.path p FROM edges e JOIN files f2 ON f2.id=e.src WHERE e.dst=?").all(f.id).map((r) => r.p),
    };
  }));

tool(server, "blast_radius",
  "Everything that transitively depends on a file (reverse dependency BFS). Call BEFORE modifying shared code to know what to re-test.",
  { path: z.string().min(1).max(500), depth: z.number().int().optional() },
  ({ path: p, depth }) => withDb((d) => {
    const f = d.prepare("SELECT id FROM files WHERE path=?").get(p);
    if (!f) return "File not in index.";
    const hasTest = d.prepare("SELECT COUNT(*) c FROM pragma_table_info('files') WHERE name='is_test'").get().c;
    let frontier = new Set([f.id]);
    const seen = new Set([f.id]);
    const levels = [];
    const testsAffected = new Set();
    for (let i = 0; i < clamp(depth ?? 2, 1, 5); i++) {
      if (!frontier.size) break;
      const marks = [...frontier].map(() => "?").join(",");
      const rows = d.prepare(
        `SELECT DISTINCT e.src, f2.path${hasTest ? ", f2.is_test" : ""} FROM edges e JOIN files f2 ON f2.id=e.src WHERE e.dst IN (${marks})`
).all(...frontier);
      frontier = new Set(rows.map((r) => r.src).filter((id) => !seen.has(id)));
      frontier.forEach((id) => seen.add(id));
      // tests ride along in the traversal but stay out of the production counts
      for (const r of rows) if (r.is_test) testsAffected.add(r.path);
      const prod = rows.filter((r) => !r.is_test);
      if (prod.length) levels.push([...new Set(prod.map((r) => r.path))].sort());
    }
    return { file: p, affected_total: levels.reduce((a, l) => a + l.length, 0), by_depth: levels,
      ...(hasTest ? { tests_affected: [...testsAffected].sort(), tests_affected_total: testsAffected.size } : {}) };
  }));

tool(server, "dependencies",
  "What a file imports (its direct in-repo dependencies).",
  { path: z.string().min(1).max(500) },
  ({ path: p }) => withDb((d) => {
    const rows = d.prepare(
      `SELECT f2.path p FROM files f JOIN edges e ON e.src=f.id JOIN files f2 ON f2.id=e.dst WHERE f.path=?`
).all(p).map((r) => r.p);
    return rows.length ? rows : "No in-repo dependencies found.";
  }));

tool(server, "module_map",
  "Directory-level overview: file count and main languages per top-level directory (optionally under `prefix`). First call to orient in an unfamiliar repo.",
  { prefix: z.string().max(300).optional() },
  ({ prefix = "" }) => withDb((d) => {
    const rows = d.prepare("SELECT path, lang FROM files WHERE path LIKE ?").all(`${prefix}%`);
    const agg = new Map();
    for (const r of rows) {
      const rest = r.path.slice(prefix.length).replace(/^\//, "");
      const top = rest.includes("/") ? rest.split("/")[0] : "(root files)";
      const a = agg.get(top) ?? { files: 0, langs: {} };
      a.files++; a.langs[r.lang] = (a.langs[r.lang] ?? 0) + 1;
      agg.set(top, a);
    }
    return [...agg.entries()].sort().map(([k, v]) => ({
      dir: (prefix + "/" + k).replace(/^\/+|\/+$/g, "") || k,
      files: v.files,
      langs: Object.keys(v.langs).sort((a, b) => v.langs[b] - v.langs[a]).slice(0, 3),
    }));
  }));

tool(server, "hotspots",
  "Most-depended-on files (highest in-degree), highest-risk to change, best places to start understanding the architecture.",
  { limit: z.number().int().optional() },
  ({ limit }) => withDb((d) =>
    d.prepare(`SELECT f.path, COUNT(e.src) dependents FROM files f JOIN edges e ON e.dst=f.id
               GROUP BY f.id ORDER BY dependents DESC LIMIT ?`).all(clamp(limit ?? 10, 1, 30))));

tool(server, "find_callers",
  "AST-based: who calls this function/method? Returns each calling function with its file and line. Heuristic (matched by name); for compiler-resolved precision use find_references (SCIP).",
  { name: z.string().min(1).max(120), limit: z.number().int().optional() },
  ({ name, limit }) => withDb((d) => {
    const rows = d.prepare(
      `SELECT s.name AS caller, s.parent, f.path, c.line FROM calls c
       JOIN symbols s ON s.id=c.src_symbol JOIN files f ON f.id=s.file_id
       WHERE c.callee = ? ORDER BY f.path, c.line LIMIT ?`
).all(name, clamp(limit ?? 40, 1, 100));
    return rows.length ? rows : "No callers recorded (AST index may not cover this file's language, or name mismatch, try find_references for SCIP-grade lookup).";
  }));

tool(server, "find_callees",
  "AST-based: what does this function/method call? Returns callee names with lines. Heuristic (by name).",
  { name: z.string().min(1).max(120) },
  ({ name }) => withDb((d) => {
    const rows = d.prepare(
      `SELECT DISTINCT c.callee, c.line FROM calls c JOIN symbols s ON s.id=c.src_symbol
       WHERE s.name = ? ORDER BY c.line LIMIT 60`
).all(name);
    return rows.length ? rows : "No callees recorded for that symbol.";
  }));

tool(server, "find_references",
  "COMPILER-GRADE (requires SCIP ingest): every place a symbol is actually used, resolved by the compiler, not text matching. Returns definition site + reference sites.",
  { name: z.string().min(1).max(200), limit: z.number().int().optional() },
  ({ name, limit }) => withDb((d) => {
    if (!d.prepare("SELECT name FROM sqlite_master WHERE name='scip_refs'").get()) {
      return "SCIP data not ingested (see README). Use search_code instead.";
    }
    const defs = d.prepare("SELECT symbol, path, line, docs FROM scip_defs WHERE symbol LIKE ? LIMIT 5").all(`%${name}%`);
    if (!defs.length) return `No compiler-resolved definition matching '${name}'. Try find_symbol.`;
    return defs.map((def) => {
      const refs = d.prepare("SELECT path, line FROM scip_refs WHERE symbol=? ORDER BY path, line LIMIT ?")
        .all(def.symbol, clamp(limit ?? 40, 1, 100));
      return { symbol: def.symbol, defined: `${def.path}:${def.line}`, doc: (def.docs ?? "").slice(0, 150),
        reference_count: refs.length, references: refs.map((r) => `${r.path}:${r.line}`) };
    });
  }));

tool(server, "goto_definition",
  "COMPILER-GRADE (requires SCIP ingest): exact definition of a symbol with its doc comment. More precise than find_symbol for overloaded/common names.",
  { name: z.string().min(1).max(200) },
  ({ name }) => withDb((d) => {
    if (!d.prepare("SELECT name FROM sqlite_master WHERE name='scip_defs'").get()) {
      return "SCIP data not ingested; use find_symbol instead.";
    }
    const rows = d.prepare(
      "SELECT symbol, path, line, docs FROM scip_defs WHERE symbol LIKE ? ORDER BY length(symbol) LIMIT 10"
).all(`%${name}%`);
    return rows.length ? rows : "Not found in SCIP index; try find_symbol.";
  }));

tool(server, "explain",
  "Cached LLM insight for a module or file: intent, responsibilities, system connections, gotchas. Generated by the enrichment layer (hash-cached, regenerated only when content changes). Falls back with guidance if no insight exists or it's stale.",
  { target: z.string().min(1).max(300) },
  ({ target }) => withDb((d) => {
    if (!d.prepare("SELECT name FROM sqlite_master WHERE name='insights'").get()) {
      return "No insights yet. Run enrichment: node .ariadne/enrich.mjs (see PRIVACY.md, opt-in, supports fully-local models via OPENAI_BASE_URL).";
    }
    const row = d.prepare("SELECT * FROM insights WHERE target=? OR target LIKE ? LIMIT 1").get(target, "%" + target + "%");
    if (!row) return `No cached insight for '${target}'. Ask Hermes to derive one from the graph, or run enrich.`;
    let stale = "";
    if (row.kind === "file") {
      const f = d.prepare("SELECT hash FROM files WHERE path=?").get(row.target);
      if (f && f.hash !== row.hash) stale = " [STALE: file changed since this was generated, re-run enrich]";
    }
    return `${row.kind} ${row.target} (model: ${row.model})${stale}\n\n${row.summary}`;
  }));

tool(server, "decisions",
  "Decision memory (Mnemosyne): query architectural decisions with temporal validity. Filter by free text, a governed target (topic/table/module), status, or as_of (YYYY-MM-DD) for time-travel ('what was valid last March'). Decisions are parsed from ADR markdown in the repos, the source of truth stays in git.",
  { query: z.string().max(200).optional(), target: z.string().max(200).optional(),
    status: z.string().max(30).optional(), as_of: z.string().max(10).optional() },
  ({ query, target, status, as_of }) => withDb((d) => {
    if (!d.prepare("SELECT name FROM sqlite_master WHERE name='decisions'").get()) return "No decision data; reindex with the current Ariadne";
    let rows = d.prepare("SELECT * FROM decisions ORDER BY decided_at DESC").all();
    if (target) {
      const ids = new Set(d.prepare("SELECT decision_id FROM decision_links WHERE target LIKE ?").all(`%${target}%`).map((r) => r.decision_id));
      rows = rows.filter((r) => ids.has(r.id));
    }
    if (query) rows = rows.filter((r) => (r.title + " " + r.summary).toLowerCase().includes(query.toLowerCase()));
    if (status) rows = rows.filter((r) => r.status === status.toLowerCase());
    if (as_of) rows = rows.filter((r) => r.decided_at && r.decided_at <= as_of && (!r.valid_until || r.valid_until > as_of));
    if (!rows.length) return "No matching decisions. To capture one from this conversation, use save_decision.";
    return rows.slice(0, 20).map((r) => ({
      id: r.id, title: r.title,
      status: as_of ? "valid as of " + as_of : r.status,
      decided: r.decided_at, ...(r.valid_until ? { valid_until: r.valid_until, superseded_by: r.superseded_by } : {}),
      governs: d.prepare("SELECT kind, target FROM decision_links WHERE decision_id=?").all(r.id).map((l) => `${l.kind}:${l.target}`),
      summary: r.summary, source: r.source_path,
    }));
  }));

tool(server, "decision_trace",
  "Full lineage of one decision: supersession chain (what replaced what, when), governed artifacts with existence check (flags decisions referencing topics/tables that no longer exist in the graph, decision drift).",
  { id: z.string().min(1).max(60) },
  ({ id }) => withDb((d) => {
    const rec = d.prepare("SELECT * FROM decisions WHERE id=?").get(id.toUpperCase());
    if (!rec) return `No decision '${id}'.`;
    const chain = [];
    let cur = rec;
    while (cur) { chain.push(cur); cur = cur.superseded_by ? d.prepare("SELECT * FROM decisions WHERE id=?").get(cur.superseded_by) : null; }
    let back = d.prepare("SELECT * FROM decisions WHERE superseded_by=?").get(rec.id);
    while (back) { chain.unshift(back); back = d.prepare("SELECT * FROM decisions WHERE superseded_by=?").get(back.id); }
    const links = d.prepare("SELECT kind, target FROM decision_links WHERE decision_id=?").all(rec.id);
    const topics = new Set(d.prepare("SELECT DISTINCT topic FROM msg_edges").all().map((r) => r.topic));
    const tables = new Set(d.prepare("SELECT DISTINCT tbl FROM db_access UNION SELECT DISTINCT tbl FROM db_defs").all().map((r) => r.tbl));
    return {
      chain: chain.map((c) => `${c.id} [${c.status}] ${c.decided_at ?? "?"}${c.valid_until ? " → until " + c.valid_until : " → current"}: ${c.title}`),
      governs: links.map((l) => {
        const exists = l.kind === "topic" ? topics.has(l.target) : l.kind === "table" ? tables.has(l.target) : true;
        return `${l.kind}:${l.target}${exists ? "" : "  ⚠️ no longer exists in the graph (decision drift)"}`;
      }),
      summary: rec.summary, source: rec.source_path,
    };
  }));

tool(server, "save_decision",
  "Capture a decision made in this conversation into durable decision memory: writes a git-versioned ADR markdown file (docs/adr/) AND indexes it immediately. Use when the human and you settle an architectural/design choice. supersedes: optional ADR id this replaces.",
  { title: z.string().min(5).max(150), decision: z.string().min(20).max(2000),
    rationale: z.string().min(10).max(2000), alternatives: z.string().max(1000).optional(),
    supersedes: z.string().max(30).optional() },
  ({ title, decision, rationale, alternatives, supersedes }) => {
    const adrDir = path.join(REPO_ROOT, "docs", "adr");
    fs.mkdirSync(adrDir, { recursive: true });
    let max = 0;
    for (const f of fs.readdirSync(adrDir)) {
      const m = f.match(/ADR-(\d+)/i);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    const id = `ADR-${String(max + 1).padStart(3, "0")}`;
    const today = new Date().toISOString().slice(0, 10);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    const file = path.join(adrDir, `${id}-${slug}.md`);
    const body = `# ${id}: ${title}\n\nStatus: Accepted\nDate: ${today}\n` +
      (supersedes ? `Supersedes: ${supersedes.toUpperCase()}\n` : "") +
      `\n## Decision\n\n${decision}\n\n## Rationale\n\n${rationale}\n` +
      (alternatives ? `\n## Alternatives considered\n\n${alternatives}\n` : "") +
      `\n<!-- captured via AEGIS save_decision -->\n`;
    fs.writeFileSync(file, body);
    const d = new Database(DB_PATH);
    d.pragma("busy_timeout = 10000");
    try {
      d.exec(`CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY, title TEXT, status TEXT, decided_at TEXT,
              valid_until TEXT, superseded_by TEXT, source_path TEXT, summary TEXT)`);
      d.exec("CREATE TABLE IF NOT EXISTS decision_links(decision_id TEXT, kind TEXT, target TEXT)");
      d.prepare("INSERT OR REPLACE INTO decisions(id, title, status, decided_at, valid_until, superseded_by, source_path, summary) VALUES(?,?,?,?,NULL,NULL,?,?)")
        .run(id, title, "accepted", today, path.relative(REPO_ROOT, file), decision.slice(0, 400));
      if (supersedes) {
        d.prepare("UPDATE decisions SET valid_until=?, superseded_by=?, status='superseded' WHERE id=?")
          .run(today, id, supersedes.toUpperCase());
      }
    } finally { d.close(); }
    return `${id} saved to ${path.relative(REPO_ROOT, file)} (git-versioned) and indexed. It will be re-parsed on every reindex; commit the file to share it.`;
  });

tool(server, "save_insight",
  "Persist a derived insight for a module or file into the graph (served by `explain`, hash-keyed so it auto-stales when content changes). Use after synthesizing understanding from the graph tools, this is how assistants (Copilot, Claude, etc.) enrich the shared knowledge layer.",
  { target: z.string().min(1).max(300), kind: z.enum(["module", "file"]), summary: z.string().min(40).max(4000) },
  ({ target, kind, summary }) => {
    // dedicated writable connection: the shared handle is read-only by design
    const d = new Database(DB_PATH);
    d.pragma("busy_timeout = 10000");
    try {
    d.exec(`CREATE TABLE IF NOT EXISTS insights(target TEXT PRIMARY KEY, kind TEXT, hash TEXT,
               summary TEXT, model TEXT, generated_at REAL)`);
    let hash = "";
    if (kind === "file") hash = d.prepare("SELECT hash FROM files WHERE path=?").get(target)?.hash ?? "";
    else {
      const hs = d.prepare("SELECT hash FROM files WHERE path LIKE ? ORDER BY path").all(target + "/%").map((r) => r.hash ?? "");
      hash = require("node:crypto").createHash("sha1").update(hs.join("|")).digest("hex");
    }
    d.prepare(`INSERT OR REPLACE INTO insights(target, kind, hash, summary, model, generated_at)
               VALUES(?,?,?,?,?,?)`).run(target, kind, hash, summary, "assistant", Date.now() / 1000);
    return `Insight saved for ${kind} '${target}'. It will be served by explain() and marked stale automatically when content changes.`;
    } finally { d.close(); }
  });

tool(server, "graph_gaps",
  "Where static analysis is BLIND, the graph's own to-do list. Returns dynamic topic/SQL expressions it could not resolve, orphan topics and endpoints, drift tables, and unmatched calls, each with file:line. Use this to find what needs a human or an assistant to work out, then record the answer with assert_edge. This is how the graph gets better instead of staying wrong.",
  { limit: z.number().int().optional() },
  ({ limit }) => withDb((d) => {
    const n = clamp(limit ?? 20, 1, 60);
    const gaps = {};
    const q = (sql, ...a) => { try { return d.prepare(sql).all(...a); } catch { return []; } };
    // gap math is production-only: a test consumer must not cure a dead topic.
    // test coverage surfaces as a `note` on the entry, never as a fix
    const hasTest = d.prepare("SELECT COUNT(*) c FROM pragma_table_info('files') WHERE name='is_test'").get().c;
    const prod = hasTest ? " AND f.is_test=0" : "";

    gaps.unresolved_topic_expressions = q(
      `SELECT m.topic AS expression, f.path, m.line FROM msg_edges m JOIN files f ON f.id=m.file_id
       WHERE m.resolved=0${prod} LIMIT ?`, n)
      .map((r) => ({ ...r, why: "topic name is assembled at runtime, static analysis cannot evaluate it" }));

    const per = hasTest
      ? q(`SELECT m.topic, SUM(m.direction='produce') p, SUM(m.direction='consume') c FROM msg_edges m
           JOIN files f ON f.id=m.file_id WHERE f.is_test=0 GROUP BY m.topic`)
      : q(`SELECT topic, SUM(direction='produce') p, SUM(direction='consume') c FROM msg_edges GROUP BY topic`);
    const testPer = new Map((hasTest
      ? q(`SELECT m.topic, SUM(m.direction='produce') p, SUM(m.direction='consume') c FROM msg_edges m
           JOIN files f ON f.id=m.file_id WHERE f.is_test=1 GROUP BY m.topic`)
      : []).map((r) => [r.topic, r]));
    gaps.topics_produced_but_never_consumed = per.filter((t) => t.p && !t.c).slice(0, n)
      .map((t) => ({ topic: t.topic, why: "no consumer found, dead topic, a consumer outside the workspace, or a dynamic listener the parser missed",
        ...(testPer.get(t.topic)?.c ? { note: "exercised only by tests" } : {}) }));
    gaps.topics_consumed_but_never_produced = per.filter((t) => t.c && !t.p).slice(0, n)
      .map((t) => ({ topic: t.topic, why: "no producer found, an upstream repo not indexed, or a dynamic producer the parser missed",
        ...(testPer.get(t.topic)?.p ? { note: "exercised only by tests" } : {}) }));

    // drift and unresolved entries carry no test note: test access neither causes nor cures them
    gaps.tables_accessed_but_undefined = q(
      `SELECT DISTINCT a.tbl AS table_name, f.path, a.line FROM db_access a JOIN files f ON f.id=a.file_id
       WHERE a.tbl NOT IN (SELECT tbl FROM db_defs)${prod} LIMIT ?`, n)
      .map((r) => ({ ...r, why: "DRIFT, code touches it but no Liquibase changeset defines it here (other repo? dynamic DDL? a real bug?)" }));

    const eps = q(`SELECT e.method, e.path, e.norm FROM http_endpoints e${hasTest ? " JOIN files f ON f.id=e.file_id WHERE f.is_test=0" : ""}`);
    const calls = q(`SELECT c.method, c.norm FROM http_calls c${hasTest ? " JOIN files f ON f.id=c.file_id WHERE f.is_test=0" : ""}`);
    const testCalls = hasTest ? q(`SELECT c.method, c.norm FROM http_calls c JOIN files f ON f.id=c.file_id WHERE f.is_test=1`) : [];
    gaps.endpoints_with_no_caller = eps
      .filter((e) => !calls.some((c) => c.method === e.method && pathsMatch(c.norm, e.norm)))
      .slice(0, n)
      .map((e) => ({ endpoint: `${e.method} ${e.path}`, why: "nobody in the workspace calls it, dead route, an external consumer, or a gateway rewrite the parser cannot see",
        ...(testCalls.some((c) => c.method === e.method && pathsMatch(c.norm, e.norm)) ? { note: "exercised only by tests" } : {}) }));

    const total = Object.values(gaps).reduce((a, b) => a + b.length, 0);
    return {
      summary: total
        ? `${total} things static analysis could not resolve. Investigate the code at each location; when you work out the answer, record it with assert_edge so the whole team's graph improves.`
        : "No gaps found, static analysis resolved everything it looked at.",
      ...gaps,
    };
  }));

tool(server, "assert_edge",
  "Record a fact you DERIVED by reading code that static analysis could not resolve, a runtime-assembled Kafka topic, a dynamically built SQL table, a gateway-rewritten route. Writes to docs/graph-assertions.json (git-committed and reviewable, exactly like an ADR) and into the graph, tagged with your name so it is never mistaken for a parsed fact. Requires evidence: quote the code that convinced you. Only assert what you can defend.",
  {
    kind: z.enum(["kafka", "db", "http_endpoint", "http_call"]),
    file: z.string().min(1).max(400),
    line: z.number().int(),
    evidence: z.string().min(20).max(600),
    confidence: z.enum(["high", "medium", "low"]),
    topic: z.string().max(200).optional(),
    direction: z.enum(["produce", "consume"]).optional(),
    table: z.string().max(120).optional(),
    mode: z.enum(["read", "write", "rw"]).optional(),
    method: z.string().max(10).optional(),
    path: z.string().max(300).optional(),
  },
  (a) => {
    if (a.kind === "kafka" && (!a.topic || !a.direction)) return "kafka assertions need topic and direction.";
    if (a.kind === "db" && !a.table) return "db assertions need table.";
    if (a.kind.startsWith("http") && !a.path) return "http assertions need path.";

    const d = new Database(DB_PATH, { readonly: true });
    let hash = null;
    try { hash = d.prepare("SELECT hash FROM files WHERE path=?").get(a.file)?.hash ?? null; } finally { d.close(); }
    if (!hash) return `File '${a.file}' is not in the index, check the path (it is repo-prefixed in a multi-repo workspace).`;

    const af = path.join(REPO_ROOT, "docs", "graph-assertions.json");
    let list = [];
    if (fs.existsSync(af)) {
      // Never clobber: a malformed file (merge-conflict marker, stray comma) must
      // not silently erase the team's accumulated assertions.
      try { list = JSON.parse(fs.readFileSync(af, "utf8")); }
      catch (e) { return `docs/graph-assertions.json exists but is not valid JSON (${e.message}). Fix or remove it first; refusing to overwrite the team's assertions.`; }
      if (!Array.isArray(list)) return "docs/graph-assertions.json is not a JSON array. Fix it first; refusing to overwrite the team's assertions.";
    }
    const rec = { ...a, author: "assistant", source_hash: hash, asserted_at: new Date().toISOString().slice(0, 10) };
    // replace an identical prior assertion rather than duplicating
    list = list.filter((x) => !(x.kind === a.kind && x.file === a.file && x.line === a.line
      && x.topic === a.topic && x.table === a.table && x.path === a.path));
    list.push(rec);
    fs.mkdirSync(path.dirname(af), { recursive: true });
    fs.writeFileSync(af, JSON.stringify(list, null, 2) + "\n");
    return `Asserted and recorded in docs/graph-assertions.json (${list.length} total). It enters the graph on the next index, tagged 'asserted', never mixed with parsed facts, and marked STALE automatically if ${a.file} changes. Commit the file to share it with the team.`;
  });

tool(server, "message_flow",
  "Kafka topology: correlate inbound/outbound message handling across modules. No args = full topic map (each topic's producers and consumers with file:line, plus orphans, topics produced but never consumed or vice versa). Pass topic for one topic's flow. Topics resolved from literals, constants, and application.yaml placeholders.",
  { topic: z.string().max(200).optional() },
  ({ topic }) => withDb((d) => {
    if (!d.prepare("SELECT name FROM sqlite_master WHERE name='msg_edges'").get()) {
      return "No message-edge data; reindex with the current Ariadne";
    }
    // Large system, no filter: a full dump is useless AND huge. Return the signal instead.
    const nTopics = d.prepare("SELECT COUNT(DISTINCT topic) c FROM msg_edges").get().c;
    const hasTest = d.prepare("SELECT COUNT(*) c FROM pragma_table_info('files') WHERE name='is_test'").get().c;
    if (!topic && nTopics > SUMMARY_THRESHOLD) {
      // topology is production-only; a topic touched only by tests is a warning, not topology
      const per = hasTest
        ? d.prepare(`SELECT m.topic, SUM(m.direction='produce') producers,
            SUM(m.direction='consume') consumers FROM msg_edges m
            JOIN files f ON f.id=m.file_id WHERE f.is_test=0 GROUP BY m.topic`).all()
        : d.prepare(`SELECT topic, SUM(direction='produce') producers,
            SUM(direction='consume') consumers FROM msg_edges GROUP BY topic`).all();
      const testOnly = hasTest
        ? d.prepare(`SELECT DISTINCT m.topic FROM msg_edges m JOIN files f ON f.id=m.file_id WHERE f.is_test=1
            AND m.topic NOT IN (SELECT m2.topic FROM msg_edges m2 JOIN files f2 ON f2.id=m2.file_id WHERE f2.is_test=0)`).all().map((r) => r.topic)
        : [];
      const cap = (a) => (a.length > 25 ? [...a.slice(0, 25), `…and ${a.length - 25} more`] : a);
      return {
        summary: `${per.length} topics${testOnly.length ? ` (${testOnly.length} more only in tests)` : ""}; ${per.reduce((x, t) => x + t.producers, 0)} producer sites, ${per.reduce((x, t) => x + t.consumers, 0)} consumer sites.`,
        warnings: {
          produced_but_never_consumed: cap(per.filter((t) => t.producers > 0 && t.consumers === 0).map((t) => t.topic)),
          consumed_but_never_produced: cap(per.filter((t) => t.consumers > 0 && t.producers === 0).map((t) => t.topic)),
          ...(testOnly.length ? { topics_only_exercised_by_tests: cap(testOnly) } : {}),
          unresolved_topic_expressions: hasTest
            ? d.prepare("SELECT COUNT(*) c FROM msg_edges m JOIN files f ON f.id=m.file_id WHERE m.resolved=0 AND f.is_test=0").get().c
            : d.prepare("SELECT COUNT(*) c FROM msg_edges WHERE resolved=0").get().c,
        },
        busiest_topics: per.sort((a, b) => (b.producers + b.consumers) - (a.producers + a.consumers)).slice(0, 10),
        next: "Full listing: docs/generated/message-flows.md. For the sites on one topic: message_flow topic:<name>.",
      };
    }
    const where = topic ? "WHERE m.topic = ?" : "";
    const hasSrc = d.prepare("SELECT COUNT(*) c FROM pragma_table_info('msg_edges') WHERE name='source'").get().c;
    const rows = d.prepare(
      `SELECT m.topic, m.direction, f.path, m.line, m.resolved, m.via${hasSrc ? ", m.source" : ""}${hasTest ? ", f.is_test" : ""} FROM msg_edges m
       JOIN files f ON f.id=m.file_id ${where} ORDER BY m.topic, m.direction`
).all(...(topic ? [topic] : []));
    if (!rows.length) return topic ? `No handlers found for topic '${topic}'.` : "No Kafka producers/consumers detected.";
    const topics = {};
    for (const r of rows) {
      const t = (topics[r.topic] ??= { producers: [], consumers: [], unresolved: [], test_producers: [], test_consumers: [] });
      const asserted = r.source && r.source !== "static";
      const site = `${r.path}:${r.line}` + (r.via && !asserted ? ` (via ${r.via})` : "")
        + (asserted ? `  [ASSERTED by ${r.source.split(":")[1]}, derived, not parsed]` : "");
      if (r.is_test) {
        (r.direction === "produce" ? t.test_producers : t.test_consumers)
          .push(site + (r.resolved ? "" : " (unresolved)") + "  [TEST]");
        continue;
      }
      if (!r.resolved) t.unresolved.push(site);
      else (r.direction === "produce" ? t.producers : t.consumers).push(site);
    }
    const out = Object.entries(topics).map(([t, v]) => ({
      topic: t, producers: v.producers, consumers: v.consumers,
      ...(v.unresolved.length ? { unresolved_expressions: v.unresolved } : {}),
      ...(v.producers.length && !v.consumers.length ? { warning: "produced but no consumer found in this repo"
        + (v.test_consumers.length ? ` (${v.test_consumers.length} test consumer${v.test_consumers.length === 1 ? " exists" : "s exist"})` : "") } : {}),
      ...(v.consumers.length && !v.producers.length ? { warning: "consumed but no producer found in this repo"
        + (v.test_producers.length ? ` (${v.test_producers.length} test producer${v.test_producers.length === 1 ? " exists" : "s exist"})` : "") } : {}),
      ...(!v.producers.length && !v.consumers.length && !v.unresolved.length && (v.test_producers.length || v.test_consumers.length)
        ? { warning: "only exercised by tests — no production usage in this repo" } : {}),
      ...(v.test_producers.length || v.test_consumers.length ? { test_usage: {
        ...(v.test_producers.length ? { producers: v.test_producers } : {}),
        ...(v.test_consumers.length ? { consumers: v.test_consumers } : {}),
      } } : {}),
    }));
    return out;
  }));

tool(server, "db_map",
  "Database topology (Spring Boot + Liquibase): correlate every table with the changesets that shaped it AND every code site touching it (JPA entities, Spring Data repositories, @Query, JdbcTemplate) with read/write mode. No args = full map with drift warnings (code accessing tables no changelog defines; tables defined but never accessed). Pass table for one table.",
  { table: z.string().max(200).optional() },
  ({ table }) => withDb((d) => {
    if (!d.prepare("SELECT name FROM sqlite_master WHERE name='db_defs'").get()) {
      return "No DB-layer data; reindex with the current Ariadne";
    }
    const nTables = d.prepare("SELECT COUNT(*) c FROM (SELECT tbl FROM db_defs UNION SELECT tbl FROM db_access)").get().c;
    const hasTest = d.prepare("SELECT COUNT(*) c FROM pragma_table_info('files') WHERE name='is_test'").get().c;
    if (!table && nTables > SUMMARY_THRESHOLD) {
      // topology and drift math are production-only; test-only access is its own warning
      const prodAcc = hasTest
        ? "SELECT a2.tbl tbl FROM db_access a2 JOIN files f2 ON f2.id=a2.file_id WHERE f2.is_test=0"
        : "SELECT tbl FROM db_access";
      const cap = (a) => (a.length > 25 ? [...a.slice(0, 25), `…and ${a.length - 25} more`] : a);
      const nProd = d.prepare(`SELECT COUNT(*) c FROM (SELECT tbl FROM db_defs UNION SELECT tbl FROM (${prodAcc}))`).get().c;
      return {
        summary: `${nProd} tables${nTables > nProd ? ` (${nTables - nProd} more only in tests)` : ""}; ${d.prepare("SELECT COUNT(DISTINCT tbl) c FROM db_defs").get().c} defined by Liquibase, ${d.prepare(`SELECT COUNT(DISTINCT tbl) c FROM (${prodAcc})`).get().c} touched by code.`,
        warnings: {
          DRIFT_accessed_but_no_changeset: cap(d.prepare(`SELECT DISTINCT tbl FROM (${prodAcc}) WHERE tbl NOT IN (SELECT tbl FROM db_defs)`).all().map((r) => r.tbl)),
          defined_but_never_accessed: cap(d.prepare(`SELECT DISTINCT tbl FROM db_defs WHERE tbl NOT IN (${prodAcc})`).all().map((r) => r.tbl)),
          ...(hasTest ? { accessed_only_by_tests: cap(d.prepare(`SELECT DISTINCT a.tbl FROM db_access a JOIN files f ON f.id=a.file_id
            WHERE f.is_test=1 AND a.tbl NOT IN (${prodAcc})`).all().map((r) => r.tbl)) } : {}),
        },
        most_accessed_tables: d.prepare(`SELECT tbl, COUNT(*) sites FROM (${prodAcc}) GROUP BY tbl ORDER BY sites DESC LIMIT 10`).all(),
        next: "Full listing: docs/generated/data-map.md. For changesets and access sites on one table: db_map table:<name>.",
      };
    }
    const t = table?.toLowerCase();
    const defs = d.prepare(`SELECT db.tbl, db.op, f.path, db.line, db.changeset FROM db_defs db
      LEFT JOIN files f ON f.id=db.file_id ${t ? "WHERE db.tbl=?" : ""} ORDER BY db.tbl`).all(...(t ? [t] : []));
    const accs = d.prepare(`SELECT a.tbl, a.kind, a.mode, f.path, a.line, a.detail${hasTest ? ", f.is_test" : ""} FROM db_access a
      JOIN files f ON f.id=a.file_id ${t ? "WHERE a.tbl=?" : ""} ORDER BY a.tbl, a.kind`).all(...(t ? [t] : []));
    if (!defs.length && !accs.length) return t ? `No definition or access found for table '${t}'.` : "No Liquibase changelogs or DB access detected.";
    const tables = {};
    for (const r of defs) {
      const e = (tables[r.tbl] ??= { schema_ops: [], entity: null, repositories: [], sql_sites: [] });
      e.schema_ops.push(`${r.op} @ ${r.path}:${r.line}${r.changeset ? ` [${r.changeset}]` : ""}`);
    }
    for (const r of accs) {
      const e = (tables[r.tbl] ??= { schema_ops: [], entity: null, repositories: [], sql_sites: [] });
      const site = `${r.path}:${r.line} (${r.detail})`;
      if (r.is_test) { (e.test_sites ??= []).push(`[${r.mode}] ${site}  [TEST]`); continue; }
      if (r.kind === "entity") e.entity = site;
      else if (r.kind === "repository") e.repositories.push(site);
      else e.sql_sites.push(`[${r.mode}] ${site}`);
    }
    return Object.entries(tables).map(([name, e]) => {
      const prodEmpty = !e.entity && !e.repositories.length && !e.sql_sites.length;
      return {
        table: name, ...e,
        ...(!e.schema_ops.length ? { warning: "DRIFT: accessed by code but no Liquibase changeset defines it in this repo"
          + (prodEmpty && e.test_sites?.length ? " (exercised only by tests)" : "") } : {}),
        ...(e.schema_ops.length && prodEmpty
          ? { warning: "defined in changelog but no code access found"
            + (e.test_sites?.length ? " (exercised only by tests)" : "") } : {}),
      };
    });
  }));

tool(server, "http_map",
  "Full-stack HTTP seam: correlate REST endpoints (Spring controllers) with every caller (TS/React fetch/axios, Java RestTemplate/WebClient/Feign) matched on method + normalized path ({id}, :id, ${expr} all correlate). No args = full map with orphans (endpoints nobody calls; calls hitting no known endpoint). Pass path to filter.",
  { path: z.string().max(300).optional() },
  ({ path: pf }) => withDb((d) => {
    if (!d.prepare("SELECT name FROM sqlite_master WHERE name='http_endpoints'").get()) {
      return "No HTTP-seam data; reindex with the current Ariadne";
    }
    const nEp = d.prepare("SELECT COUNT(*) c FROM http_endpoints").get().c;
    const hasTest = d.prepare("SELECT COUNT(*) c FROM pragma_table_info('files') WHERE name='is_test'").get().c;
    if (!pf && nEp > SUMMARY_THRESHOLD) {
      // orphan math is production-only: a WireMock stub or a test caller cures nothing
      const eps0 = d.prepare(`SELECT e.method, e.path, e.norm FROM http_endpoints e${hasTest ? " JOIN files f ON f.id=e.file_id WHERE f.is_test=0" : ""}`).all();
      const calls0 = d.prepare(`SELECT c.method, c.path, c.norm, c.client FROM http_calls c${hasTest ? " JOIN files f ON f.id=c.file_id WHERE f.is_test=0" : ""}`).all();
      const matched = new Set();
      const orphanEps = [];
      for (const e of eps0) {
        let any = false;
        calls0.forEach((c, i) => {
          if (c.method === e.method && pathsMatch(c.norm, e.norm)) { matched.add(i); any = true; }
        });
        if (!any) orphanEps.push(`${e.method} ${e.path}`);
      }
      const cap = (a) => (a.length > 25 ? [...a.slice(0, 25), `…and ${a.length - 25} more`] : a);
      return {
        summary: `${nEp} endpoints, ${calls0.length} client calls.`,
        warnings: {
          endpoints_with_no_caller_in_workspace: cap(orphanEps),
          calls_with_no_matching_endpoint: cap(calls0.filter((_, i) => !matched.has(i)).map((c) => `${c.method} ${c.path} (${c.client})`)),
        },
        next: "Full listing: docs/generated/http-map.md. For callers of one route: http_map path:<fragment>.",
      };
    }
    const eps = d.prepare(`SELECT e.method, e.path, e.norm, f.path fp, e.line, e.detail${hasTest ? ", f.is_test" : ""}
      FROM http_endpoints e JOIN files f ON f.id=e.file_id ORDER BY e.norm`).all();
    const calls = d.prepare(`SELECT c.method, c.path, c.norm, f.path fp, c.line, c.client${hasTest ? ", f.is_test" : ""}
      FROM http_calls c JOIN files f ON f.id=c.file_id ORDER BY c.norm`).all();
    if (!eps.length && !calls.length) return "No REST endpoints or HTTP clients detected.";
    const matchedCalls = new Set();
    const out = [];
    for (const e of eps) {
      if (pf && !e.norm.includes(pf) && !e.path.includes(pf)) continue;
      const callers = calls.filter((c, i) => {
        const ok = (c.method === e.method || c.method === "GET" && e.method === "GET") && pathsMatch(c.norm, e.norm);
        if (ok) matchedCalls.add(i);
        return ok;
      });
      const prodCallers = callers.filter((c) => !c.is_test);
      const testCallers = callers.filter((c) => c.is_test);
      // an endpoint defined in a test file (WireMock/contract stub) is labeled, never an orphan
      out.push({ endpoint: `${e.method} ${e.path}`, defined: `${e.fp}:${e.line}` + (e.is_test ? "  [TEST]" : ""),
        callers: prodCallers.map((c) => `${c.fp}:${c.line} (${c.client})`),
        ...(testCallers.length ? { test_callers: testCallers.map((c) => `${c.fp}:${c.line} (${c.client})  [TEST]`) } : {}),
        ...(prodCallers.length || e.is_test ? {} : { warning: testCallers.length
          ? `no caller found in the indexed workspace (exercised only by tests: ${testCallers.length})`
          : "no caller found in the indexed workspace" }) });
    }
    const unmatched = calls.filter((c, i) => !matchedCalls.has(i) && !c.is_test && (!pf || c.norm.includes(pf)));
    if (unmatched.length) {
      out.push({ unmatched_calls: unmatched.map((c) => `${c.method} ${c.path}, ${c.fp}:${c.line} (${c.client}), no matching endpoint in workspace (external API, or path built dynamically)`) });
    }
    // test calls to endpoints outside the workspace are listed, not dropped, and never a warning
    const testUnmatched = calls.filter((c, i) => !matchedCalls.has(i) && c.is_test && (!pf || c.norm.includes(pf)));
    if (testUnmatched.length) {
      out.push({ test_unmatched_calls: testUnmatched.map((c) => `${c.method} ${c.path}, ${c.fp}:${c.line} (${c.client})  [TEST]`) });
    }
    return out;
  }));

tool(server, "reindex",
  "Rebuild the index. mode='incremental' (changed files since last indexed commit) or 'full'. Use when index_status reports fresh=false.",
  { mode: z.enum(["incremental", "full"]).optional() },
  ({ mode = "incremental" }) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(GR_DIR, "indexer.mjs"), `--${mode}`],
      { cwd: REPO_ROOT, timeout: 600_000 },
      (err, stdout, stderr) => {
        try { _db?.close(); } catch {} _db = null; // pick up the fresh DB
        resolve((stdout + stderr).trim() || (err ? `reindex failed: ${err.message}` : "done"));
      });
  }));

// ---- plugin tools: .ariadne/extensions/*.tool.mjs export register({ tool, z, withDb, server }) ----
{
  const extDir = path.join(GR_DIR, "extensions");
  if (fs.existsSync(extDir)) {
    for (const f of approvedFiles(extDir, /\.tool\.mjs$/, (l, m) => console.error(m))) {
      try {
        const mod = await import(pathToFileURL(path.join(extDir, f)).href);
        if (typeof mod.register === "function") await mod.register({ tool: (n, d2, s, f2) => tool(server, n, d2, s, f2), z, withDb, server });
      } catch (e) { console.error(`extension tool ${f} failed: ${e.message}`); }
    }
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
