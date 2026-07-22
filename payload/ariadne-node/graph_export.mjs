#!/usr/bin/env node
/**
 * AEGIS graph export: one machine-readable JSON snapshot of the graph for
 * visual clients (the VS Code graph view) and anything else that wants the
 * topology without speaking MCP. Read-only, deterministic, zero tokens.
 *
 * The same budget discipline as the tools applies: entry lists are capped
 * (config maxDocItems), per-entry site lists are capped, and warnings are
 * computed over production code only, with test usage labeled, never counted
 * as a cure. Provenance survives: every site carries `test` and `asserted`.
 *
 * Usage: node graph_export.mjs [--pretty]     (JSON on stdout; run from the
 * workspace root after indexing). Schema documented in EXTENDING.md.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { pathsMatch } from "./http.mjs";

const ROOT = process.cwd();
const DB_PATH = path.join(process.env.ARIADNE_HOME ?? ROOT, ".ariadne", "index.db");
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(DB_PATH), "config.json"), "utf8")); } catch { /* defaults */ }
const MAX_MODULES = cfg.maxDiagramNodes ?? 30;
// This feeds a human UI, not a model's context window, so the ceiling is a
// safety bound for enormous systems, not the doc/tool budget. Warning-bearing
// entries are never dropped by it (warnFirst below).
const MAX_ITEMS = cfg.maxExportItems ?? (cfg.maxDocItems ?? 60) * 4;
const MAX_SITES = 12;

if (!fs.existsSync(DB_PATH)) {
  console.error("Index not found, run the Ariadne indexer first.");
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true });
const q = (sql, ...a) => db.prepare(sql).all(...a);
const has = (t) => !!q("SELECT name FROM sqlite_master WHERE name=?", t).length;
const hasTest = !!q("SELECT COUNT(*) c FROM pragma_table_info('files') WHERE name='is_test'")[0].c;
const svc = (p) => p.split("/")[0];
const T = hasTest ? ", f.is_test" : "";
const site = (r, extra = {}) => ({
  path: r.path, line: r.line,
  ...(r.via ? { via: r.via } : {}),
  ...(hasTest && r.is_test ? { test: true } : {}),
  ...(r.source && String(r.source).startsWith("asserted") ? { asserted: r.source } : {}),
  ...extra,
});
const capped = (arr, n) => ({ items: arr.slice(0, n), ...(arr.length > n ? { more: arr.length - n } : {}) });
/** Cap an entry list at n, but warning-bearing entries are kept FIRST and never
 *  dropped — the same rule the MCP tools enforce (a truncated export that
 *  silently discarded a drift warning would be worse than no export at all). */
const warnFirst = (arr, n, weight) => {
  const w = arr.filter((e) => Object.keys(e.warnings ?? {}).length);
  const clean = arr.filter((e) => !Object.keys(e.warnings ?? {}).length)
    .sort((a, b) => weight(b) - weight(a)); // busiest first, like message_flow's summary
  return [...w, ...clean.slice(0, Math.max(0, n - w.length))];
};
const nSites = (l) => (l?.items?.length ?? 0) + (l?.more ?? 0);

/* ---- modules: files per first path segment + cross-module import edges ---- */
const files = q("SELECT path, lang FROM files");
const services = new Map();
for (const f of files) {
  const s = services.get(svc(f.path)) ?? { files: 0, langs: {} };
  s.files++; s.langs[f.lang] = (s.langs[f.lang] ?? 0) + 1;
  services.set(svc(f.path), s);
}
const deps = new Map();
for (const e of q(`SELECT DISTINCT f1.path a, f2.path b FROM edges e
                   JOIN files f1 ON f1.id=e.src JOIN files f2 ON f2.id=e.dst`)) {
  const [a, b] = [svc(e.a), svc(e.b)];
  if (a !== b) (deps.get(a) ?? deps.set(a, new Set()).get(a)).add(b);
}
const hot = q(`SELECT f.path, COUNT(e.src) n FROM files f JOIN edges e ON e.dst=f.id
               GROUP BY f.id ORDER BY n DESC LIMIT 10`);
const modules = [...services.entries()]
  .sort((a, b) => b[1].files - a[1].files)
  .slice(0, MAX_MODULES)
  .map(([name, s]) => ({
    id: name, files: s.files,
    langs: Object.keys(s.langs).sort((a, b) => s.langs[b] - s.langs[a]).slice(0, 3),
    deps: [...(deps.get(name) ?? [])].sort(),
  }));

/* ---- topics: production topology + labeled test usage + warnings ---- */
const mrows = has("msg_edges")
  ? q(`SELECT m.topic, m.direction, m.line, m.via, m.resolved, m.source, f.path${T}
       FROM msg_edges m JOIN files f ON f.id=m.file_id ORDER BY m.topic, m.line`)
  : [];
const byTopic = new Map();
for (const r of mrows) (byTopic.get(r.topic) ?? byTopic.set(r.topic, []).get(r.topic)).push(r);
const topics = warnFirst([...byTopic.entries()].map(([topic, rows]) => {
  const prod = rows.filter((r) => r.direction === "produce" && !(hasTest && r.is_test));
  const cons = rows.filter((r) => r.direction === "consume" && !(hasTest && r.is_test));
  const test = rows.filter((r) => hasTest && r.is_test);
  return {
    topic,
    producers: capped(prod.map((r) => site(r)), MAX_SITES),
    consumers: capped(cons.map((r) => site(r)), MAX_SITES),
    ...(test.length ? { test_sites: capped(test.map((r) => site(r, { direction: r.direction })), 6) } : {}),
    warnings: {
      ...(prod.length && !cons.length ? { orphan_produce: true } : {}),
      ...(cons.length && !prod.length ? { orphan_consume: true } : {}),
      ...(!prod.length && !cons.length && test.length ? { test_only: true } : {}),
      ...(rows.some((r) => !r.resolved) ? { unresolved_expression: true } : {}),
    },
  };
}), MAX_ITEMS, (t) => nSites(t.producers) + nSites(t.consumers));

/* ---- tables: schema history + access + drift, production-only math ---- */
const drows = has("db_defs") ? q("SELECT d.tbl, d.op, d.line, d.changeset, f.path FROM db_defs d LEFT JOIN files f ON f.id=d.file_id ORDER BY d.tbl") : [];
const arows = has("db_access")
  ? q(`SELECT a.tbl, a.kind, a.mode, a.line, a.detail, a.source, f.path${T}
       FROM db_access a JOIN files f ON f.id=a.file_id ORDER BY a.tbl, a.line`)
  : [];
const byTbl = new Map();
for (const d of drows) (byTbl.get(d.tbl) ?? byTbl.set(d.tbl, { defs: [], accs: [] }).get(d.tbl)).defs.push(d);
for (const a of arows) (byTbl.get(a.tbl) ?? byTbl.set(a.tbl, { defs: [], accs: [] }).get(a.tbl)).accs.push(a);
const tables = warnFirst([...byTbl.entries()].map(([tbl, t]) => {
  const pa = t.accs.filter((a) => !(hasTest && a.is_test));
  const ta = t.accs.filter((a) => hasTest && a.is_test);
  return {
    table: tbl,
    changesets: t.defs.map((d) => `${d.op}${d.changeset ? ` [${d.changeset}]` : ""}`),
    access: capped(pa.map((a) => site(a, { mode: a.mode })), MAX_SITES),
    ...(ta.length ? { test_sites: capped(ta.map((a) => site(a, { mode: a.mode })), 6) } : {}),
    warnings: {
      ...(!t.defs.length ? { drift_no_changeset: true } : {}),
      ...(t.defs.length && !pa.length ? { defined_but_unused: true } : {}),
    },
  };
}), MAX_ITEMS, (t) => nSites(t.access) + t.changesets.length);

/* ---- endpoints: production endpoints with correlated callers ---- */
const eps = has("http_endpoints")
  ? q(`SELECT e.method, e.path ep, e.norm, e.line, e.source, f.path${T} FROM http_endpoints e JOIN files f ON f.id=e.file_id ORDER BY e.norm`)
  : [];
const calls = has("http_calls")
  ? q(`SELECT c.method, c.norm, c.line, c.client, c.source, f.path${T} FROM http_calls c JOIN files f ON f.id=c.file_id`)
  : [];
const endpoints = warnFirst(eps.filter((e) => !(hasTest && e.is_test)).map((e) => {
  const cs = calls.filter((c) => c.method === e.method && pathsMatch(c.norm, e.norm));
  const prod = cs.filter((c) => !(hasTest && c.is_test));
  return {
    method: e.method, path: e.ep, file: e.path, line: e.line,
    ...(String(e.source ?? "").startsWith("asserted") ? { asserted: e.source } : {}),
    callers: capped(prod.map((c) => site(c, { client: c.client })), MAX_SITES),
    warnings: { ...(prod.length ? {} : { no_caller: true, ...(cs.length ? { tested_only: true } : {}) }) },
  };
}), MAX_ITEMS, (e) => nSites(e.callers));

/* ---- gaps: where static analysis is blind (the human worklist) ---- */
const gaps = {
  unresolved_topic_expressions: mrows
    .filter((r) => !r.resolved && !(hasTest && r.is_test))
    .slice(0, MAX_ITEMS)
    .map((r) => ({ expression: r.topic, direction: r.direction, path: r.path, line: r.line })),
};

/* ---- annotations already in the graph ---- */
const fileHash = new Map(q("SELECT path, hash FROM files").map((r) => [r.path, r.hash]));
const annotations = {
  insights: has("insights")
    ? q("SELECT target, kind, model, hash FROM insights ORDER BY target").slice(0, MAX_ITEMS)
        .map((r) => ({ target: r.target, kind: r.kind, by: r.model }))
    : [],
  assertions: has("assertions")
    ? q("SELECT kind, file_path, line, confidence, author, source_hash FROM assertions ORDER BY file_path").slice(0, MAX_ITEMS)
        .map((r) => ({ kind: r.kind, file: r.file_path, line: r.line, confidence: r.confidence, author: r.author,
                       ...(r.source_hash && fileHash.get(r.file_path) !== r.source_hash ? { stale: true } : {}) }))
    : [],
};

const out = {
  schema: 1,
  generated_from: { db: path.basename(DB_PATH), modules_total: services.size, files: files.length,
    symbols: q("SELECT COUNT(*) c FROM symbols")[0].c,
    ...(services.size > MAX_MODULES ? { modules_truncated_to: MAX_MODULES } : {}) },
  modules, topics, tables, endpoints, gaps, annotations,
};
process.stdout.write(JSON.stringify(out, null, process.argv.includes("--pretty") ? 1 : 0) + "\n");
