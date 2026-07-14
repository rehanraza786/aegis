#!/usr/bin/env node
/**
 * AEGIS enrich, the semantic layer: applies an LLM on top of the code+docs
 * graph to produce cached, hash-keyed insights (module intent, hotspot-file
 * summaries, architecture observations).
 *
 * Token economics: each target is summarized ONCE per content-hash. Re-runs
 * (CI on merge, local) only pay for what actually changed. All prompts are
 * built from the graph (outlines, callers, topics, tables, endpoints) not
 * raw file dumps, keeping each prompt ~1-2 KB.
 *
 * Providers (env-selected, explicit opt-in, see PRIVACY.md):
 *   ANTHROPIC_API_KEY          -> Anthropic API (model: AEGIS_MODEL or claude-haiku-4-5)
 *   OPENAI_API_KEY [+ OPENAI_BASE_URL] -> any OpenAI-compatible endpoint,
 *       including LOCAL servers (Ollama/llama.cpp/vLLM at http://localhost:11434/v1)
 *       for fully offline enrichment
 *   --provider mock            -> deterministic canned output (self-tests)
 *
 * Usage: node .ariadne/enrich.mjs [--limit 20] [--provider anthropic|openai|mock]
 * Outputs: insights table in index.db (+ staleness tracking), docs/generated/insights.md,
 * and the `explain` MCP tool serves them to agents.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const ROOT = process.cwd();
const DB_PATH = path.join(process.env.ARIADNE_HOME ?? ROOT, ".ariadne", "index.db");
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const LIMIT = parseInt(argOf("--limit", "20"), 10);
let PROVIDER = argOf("--provider",
  process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.OPENAI_API_KEY ? "openai" : null);
const PLAN = args.includes("--plan");
const APPLY = argOf("--apply", null);

if (!fs.existsSync(DB_PATH)) { console.error("Index not found, run the indexer first."); process.exit(1); }
if (!PROVIDER && !PLAN && !APPLY) {
  console.error(`No LLM provider configured. Set ANTHROPIC_API_KEY, or OPENAI_API_KEY
(+ OPENAI_BASE_URL for local servers like Ollama: http://localhost:11434/v1),
or pass --provider mock. Enrichment is opt-in and off by default, see PRIVACY.md.`);
  process.exit(2);
}

const db = new Database(DB_PATH);
db.pragma("busy_timeout = 10000");
db.exec(`CREATE TABLE IF NOT EXISTS insights(
  target TEXT PRIMARY KEY, kind TEXT, hash TEXT, summary TEXT,
  model TEXT, generated_at REAL)`);
const q = (sql, ...a) => db.prepare(sql).all(...a);
const svc = (p) => p.split("/")[0];
// insights describe production intent: seam facts from test files stay out of
// the prompts (column exists only once an indexer >= schema v5 has run)
const PROD = q("SELECT COUNT(*) c FROM pragma_table_info('files') WHERE name='is_test'")[0].c ? " AND f.is_test=0" : "";

/* ---------------- LLM call ---------------- */
async function complete(prompt) {
  if (PROVIDER === "mock") {
    return `[mock insight] ${prompt.slice(prompt.indexOf("TARGET:"), prompt.indexOf("TARGET:") + 60)}…, intent summarized deterministically for self-tests.`;
  }
  if (PROVIDER === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY,
                 "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: process.env.AEGIS_MODEL ?? "claude-haiku-4-5",
        max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return j.content.map((c) => c.text ?? "").join("");
  }
  // openai-compatible (includes local Ollama/llama.cpp/vLLM via OPENAI_BASE_URL)
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY ?? "local"}` },
    body: JSON.stringify({ model: process.env.AEGIS_MODEL ?? "gpt-4o-mini",
      max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).choices[0].message.content;
}

/* ---------------- targets: modules + hotspot files, hash-keyed ---------------- */
function moduleTargets() {
  const files = q("SELECT path, hash FROM files");
  const mods = new Map();
  for (const f of files) {
    const m = mods.get(svc(f.path)) ?? { paths: [], hashes: [] };
    m.paths.push(f.path); m.hashes.push(f.hash ?? "");
    mods.set(svc(f.path), m);
  }
  return [...mods.entries()].map(([name, m]) => ({
    kind: "module", target: name,
    hash: createHash("sha1").update(m.hashes.sort().join("|")).digest("hex"),
  }));
}
function hotspotTargets(n = 12) {
  return q(`SELECT f.path, f.hash, COUNT(e.src) deps FROM files f JOIN edges e ON e.dst=f.id
            GROUP BY f.id ORDER BY deps DESC LIMIT ?`, n)
    .map((r) => ({ kind: "file", target: r.path, hash: r.hash ?? "" }));
}

/* ---------------- prompt packs from the graph (no raw file dumps) ---------------- */
function promptFor(t) {
  const header = `You are enriching a codebase knowledge graph. Write a dense, factual summary (5-8 sentences):
purpose/intent, key responsibilities, how it connects to the rest of the system, and any invariants
or gotchas a developer must know before changing it. No preamble, no markdown headers.

TARGET: ${t.kind} ${t.target}\n`;
  if (t.kind === "module") {
    const syms = q(`SELECT s.name, s.kind FROM symbols s JOIN files f ON f.id=s.file_id
                    WHERE f.path LIKE ? AND s.kind IN ('class','type') LIMIT 25`, t.target + "/%");
    const topics = q(`SELECT DISTINCT m.topic, m.direction FROM msg_edges m JOIN files f ON f.id=m.file_id WHERE f.path LIKE ?${PROD}`, t.target + "/%");
    const tables = q(`SELECT DISTINCT a.tbl, a.mode FROM db_access a JOIN files f ON f.id=a.file_id WHERE f.path LIKE ?${PROD}`, t.target + "/%");
    const eps = q(`SELECT e.method, e.path FROM http_endpoints e JOIN files f ON f.id=e.file_id WHERE f.path LIKE ?${PROD} LIMIT 15`, t.target + "/%");
    return header +
      `Classes/types: ${syms.map((s) => s.name).join(", ") || "n/a"}\n` +
      `Kafka: ${topics.map((x) => `${x.direction} ${x.topic}`).join(", ") || "none"}\n` +
      `DB tables: ${tables.map((x) => `${x.tbl}(${x.mode})`).join(", ") || "none"}\n` +
      `HTTP endpoints: ${eps.map((e) => `${e.method} ${e.path}`).join(", ") || "none"}\n`;
  }
  const outline = q(`SELECT s.name, s.kind, s.parent FROM symbols s JOIN files f ON f.id=s.file_id
                     WHERE f.path=? ORDER BY s.line LIMIT 40`, t.target);
  const callers = q(`SELECT COUNT(*) c FROM edges e JOIN files f ON f.id=e.dst WHERE f.path=?`, t.target)[0]?.c ?? 0;
  return header +
    `Outline: ${outline.map((s) => (s.parent ? s.parent + "." : "") + s.name + ":" + s.kind).join(", ")}\n` +
    `Dependent files: ${callers} (high blast radius)\n`;
}

/* ---------------- plan/apply: external drivers (e.g. Copilot via the VS Code extension) ---------------- */
const allTargets = [...moduleTargets(), ...hotspotTargets()];
if (PLAN) {
  const get0 = db.prepare("SELECT hash FROM insights WHERE target=?");
  const plan = allTargets
    .filter((t) => { try { const p = get0.get(t.target); return !p || p.hash !== t.hash; } catch { return true; } })
    .slice(0, LIMIT)
    .map((t) => ({ ...t, prompt: promptFor(t) }));
  console.log(JSON.stringify(plan));
  process.exit(0);
}
if (APPLY) {
  const items = JSON.parse(fs.readFileSync(APPLY, "utf8")); // [{target,kind,hash,summary,model}]
  const putA = db.prepare(`INSERT OR REPLACE INTO insights(target, kind, hash, summary, model, generated_at)
                           VALUES(?,?,?,?,?,?)`);
  for (const it of items) putA.run(it.target, it.kind, it.hash, String(it.summary).slice(0, 4000), it.model ?? "external", Date.now() / 1000);
  console.log(`Applied ${items.length} insights.`);
  writeInsightsMd();
  process.exit(0);
}

/* ---------------- run ---------------- */
const targets = allTargets;
const get = db.prepare("SELECT hash FROM insights WHERE target=?");
const put = db.prepare(`INSERT OR REPLACE INTO insights(target, kind, hash, summary, model, generated_at)
                        VALUES(?,?,?,?,?,?)`);
let fresh = 0, cached = 0, failed = 0;
for (const t of targets) {
  if (fresh >= LIMIT) break;
  const prev = get.get(t.target);
  if (prev && prev.hash === t.hash) { cached++; continue; }
  try {
    const summary = (await complete(promptFor(t))).trim();
    put.run(t.target, t.kind, t.hash, summary, PROVIDER === "mock" ? "mock" : (process.env.AEGIS_MODEL ?? PROVIDER), Date.now() / 1000);
    fresh++;
    console.log(`  + ${t.kind}: ${t.target}`);
  } catch (e) { failed++; console.error(`  ! ${t.target}: ${e.message}`); }
}
console.log(`Enrichment: ${fresh} generated, ${cached} cached (hash-unchanged), ${failed} failed.`);

/* ---------------- insights.md ---------------- */
writeInsightsMd();
function writeInsightsMd() {
const rows = q("SELECT target, kind, summary, model, generated_at FROM insights ORDER BY kind, target");
if (rows.length) {
  const out = path.join(ROOT, "docs", "generated");
  fs.mkdirSync(out, { recursive: true });
  let md = `<!-- generated by aegis enrich, cached by content hash; do not edit -->\n\n# Semantic Insights (LLM-enriched)\n\n`;
  md += `_Each entry is regenerated only when its content hash changes. Provider/model per entry._\n\n`;
  for (const r of rows.filter((x) => x.kind === "module")) md += `## Module: ${r.target}\n${r.summary}\n\n`;
  const hot = rows.filter((x) => x.kind === "file");
  if (hot.length) md += `## High-blast-radius files\n\n` + hot.map((r) => `**\`${r.target}\`**, ${r.summary}`).join("\n\n") + "\n";
  fs.writeFileSync(path.join(out, "insights.md"), md);
  console.log("  + docs/generated/insights.md");
}
}
db.close();
