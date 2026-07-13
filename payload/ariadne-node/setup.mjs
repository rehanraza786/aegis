#!/usr/bin/env node
/** Cross-platform AEGIS setup (Windows/mac/Linux): installs git hooks in every
 * workspace repo, adds gitignore entries, runs the initial index + docgen.
 * Git-for-Windows executes hook files with its bundled sh, so POSIX hook
 * bodies work on all three OSes; this installer itself is pure Node. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const CWD = process.cwd();
const runtime = fs.existsSync(path.join(HERE, "indexer.mjs")) ? "node" : "python";

function gitRepos() {
  if (process.env.ARIADNE_ROOTS) return process.env.ARIADNE_ROOTS.split(",").map((p) => p.trim());
  try { return [execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", cwd: CWD }).trim()]; }
  catch { /* workspace parent */ }
  return fs.readdirSync(CWD, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && fs.existsSync(path.join(CWD, d.name, ".git")))
    .map((d) => path.join(CWD, d.name));
}

const HOOK_BODY = `#!/bin/sh
# AEGIS: refresh the codebase graph in the background (never blocks git)
AR="${CWD.replaceAll("\\", "/")}/.ariadne"
[ -f "$AR/indexer.mjs" ] && IDX="node \\"$AR/indexer.mjs\\"" || IDX="\${PYTHON:-python3} \\"$AR/indexer.py\\""
command -v python3 >/dev/null 2>&1 || PYTHON=python
(eval "$IDX --incremental" >> "$AR/index.log" 2>&1
  if [ -f "$AR/docgen.mjs" ]; then node "$AR/docgen.mjs" >> "$AR/index.log" 2>&1; \\
  elif [ -f "$AR/docgen.py" ]; then \${PYTHON:-python3} "$AR/docgen.py" >> "$AR/index.log" 2>&1; fi) &
exit 0
`;

let hooks = 0;
for (const repo of gitRepos()) {
  const hookDir = path.join(repo, ".git", "hooks");
  if (!fs.existsSync(hookDir)) continue;
  for (const h of ["post-commit", "post-merge", "post-checkout"]) {
    const f = path.join(hookDir, h);
    if (fs.existsSync(f) && !fs.readFileSync(f, "utf8").includes("AEGIS")) {
      console.log(`  skip ${h} in ${path.basename(repo)} (existing non-AEGIS hook, append manually)`);
      continue;
    }
    fs.writeFileSync(f, HOOK_BODY);
    try { fs.chmodSync(f, 0o755); } catch { /* windows: mode ignored */ }
    hooks++;
  }
  const gi = path.join(repo, ".gitignore");
  const entries = "\n# AEGIS\n.ariadne/index.db*\n.ariadne/index.log\n.ariadne/index.lock\n.ariadne/node_modules/\ndocs/generated/\n";
  if (!fs.existsSync(gi) || !fs.readFileSync(gi, "utf8").includes(".ariadne/index.db")) fs.appendFileSync(gi, entries);
}
console.log(`Hooks installed: ${hooks}`);

console.log("Building initial index (this can take a minute on large workspaces)...");
const exe = runtime === "node" ? ["node", [path.join(HERE, "indexer.mjs"), "--full"]]
  : [process.platform === "win32" ? "python" : "python3", [path.join(HERE, "indexer.py"), "--full"]];
let r = spawnSync(exe[0], exe[1], { stdio: "inherit", cwd: CWD });
if (r.status !== 0) { console.error("Index failed, see .ariadne/index.log"); process.exit(1); }
const dg = runtime === "node" ? ["node", [path.join(HERE, "docgen.mjs")]]
  : [exe[0], [path.join(HERE, "docgen.py")]];
spawnSync(dg[0], dg[1], { stdio: "inherit", cwd: CWD });
console.log("AEGIS setup complete.");
