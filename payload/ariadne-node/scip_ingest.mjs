#!/usr/bin/env node
/**
 * Ingest compiler-grade SCIP indexes (scip-typescript, scip-java) into the
 * .ariadne SQLite DB. Node edition — parses SCIP protobuf via protobufjs
 * using the bundled scip.proto (no codegen step).
 *
 * Usage: node scip_ingest.mjs index.scip [more.scip ...]
 */
import Database from "better-sqlite3";
import protobuf from "protobufjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
function git(args) {
  try { return execFileSync("git", args, { encoding: "utf8", timeout: 15_000 }).trim(); }
  catch { return ""; }
}
const REPO_ROOT = git(["rev-parse", "--show-toplevel"]) || process.cwd();
const DB_PATH = path.join(REPO_ROOT, ".ariadne", "index.db");
const DEFINITION_ROLE = 0x1;

const args = process.argv.slice(2);
if (!args.length) {
  console.log("Usage: node scip_ingest.mjs <index.scip> [more.scip ...]");
  process.exit(1);
}
if (!fs.existsSync(DB_PATH)) {
  console.error("Run the baseline indexer first: node .ariadne/indexer.mjs --full");
  process.exit(1);
}

const root = await protobuf.load(path.join(HERE, "scip.proto"));
const Index = root.lookupType("scip.Index");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.exec(`
  CREATE TABLE IF NOT EXISTS scip_defs(
    symbol TEXT, path TEXT, line INTEGER, docs TEXT, PRIMARY KEY(symbol, path, line));
  CREATE TABLE IF NOT EXISTS scip_refs(
    symbol TEXT, path TEXT, line INTEGER, PRIMARY KEY(symbol, path, line));
  CREATE INDEX IF NOT EXISTS idx_refs_symbol ON scip_refs(symbol);
  CREATE INDEX IF NOT EXISTS idx_defs_path ON scip_defs(path);
`);

const filesByPath = new Map(db.prepare("SELECT id, path FROM files").all().map((r) => [r.path, r.id]));
const insDef = db.prepare("INSERT OR REPLACE INTO scip_defs VALUES(?,?,?,?)");
const insRef = db.prepare("INSERT OR REPLACE INTO scip_refs VALUES(?,?,?)");
const delDefs = db.prepare("DELETE FROM scip_defs WHERE path=?");
const delRefs = db.prepare("DELETE FROM scip_refs WHERE path=?");
const insEdge = db.prepare("INSERT OR IGNORE INTO edges(src, dst, kind) VALUES(?,?,'ref')");

let totalDefs = 0, totalRefs = 0, edgeCount = 0;
const defFileBySymbol = new Map();

const ingest = db.transaction((scipPaths) => {
  for (const scipPath of scipPaths) {
    let idx;
    try {
      idx = Index.decode(fs.readFileSync(scipPath));
    } catch (e) {
      console.error(`WARN: could not parse ${scipPath}: ${e.message}`); continue;
    }
    const projectRoot = (idx.metadata?.projectRoot ?? "").replace("file://", "");
    let prefix = "";
    try {
      const rel = path.relative(REPO_ROOT, path.resolve(projectRoot)).replaceAll("\\", "/");
      if (rel && rel !== "." && !rel.startsWith("..")) prefix = rel + "/";
    } catch { /* keep empty prefix */ }

    for (const doc of idx.documents ?? []) {
      const rel = prefix + doc.relativePath;
      delDefs.run(rel); delRefs.run(rel);
      const docsBySymbol = new Map((doc.symbols ?? []).map((s) => [s.symbol, (s.documentation ?? []).join("\n").slice(0, 300)]));
      for (const occ of doc.occurrences ?? []) {
        if (!occ.symbol || occ.symbol.startsWith("local ")) continue;
        const line = ((occ.range?.[0] ?? 0) | 0) + 1;
        if ((occ.symbolRoles ?? 0) & DEFINITION_ROLE) {
          insDef.run(occ.symbol, rel, line, docsBySymbol.get(occ.symbol) ?? "");
          defFileBySymbol.set(occ.symbol, rel);
          totalDefs++;
        } else {
          insRef.run(occ.symbol, rel, line);
          totalRefs++;
        }
      }
    }
  }
  for (const { symbol, path: refPath } of db.prepare("SELECT DISTINCT symbol, path FROM scip_refs").all()) {
    const defPath = defFileBySymbol.get(symbol);
    if (!defPath || defPath === refPath) continue;
    const src = filesByPath.get(refPath), dst = filesByPath.get(defPath);
    if (src && dst) { insEdge.run(src, dst); edgeCount++; }
  }
  db.prepare("INSERT OR REPLACE INTO meta VALUES('scip_ingested_at', ?)").run(String(Date.now() / 1000));
  db.prepare("INSERT OR REPLACE INTO meta VALUES('scip_sha', ?)").run(git(["rev-parse", "HEAD"]));
});

ingest(args);
console.log(`SCIP ingest: ${totalDefs} definitions, ${totalRefs} references, ${edgeCount} ref-edges from ${args.length} index file(s).`);
