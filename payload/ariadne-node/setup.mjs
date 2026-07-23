#!/usr/bin/env node
/** Cross-platform AEGIS setup (Windows/mac/Linux): installs git hooks in every
 * workspace repo, adds gitignore entries, runs the initial index + docgen.
 * Git-for-Windows executes hook files with its bundled sh, so POSIX hook
 * bodies work on all three OSes; this installer itself is pure Node. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// fileURLToPath decodes percent-encoding and handles drive letters; the old
// URL.pathname hack left e.g. RUNNER~1 as RUNNER%7E1, so on Windows HERE was
// a nonexistent path and the runtime probe below misdetected the edition.
const HERE = path.dirname(fileURLToPath(import.meta.url));
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

// Escape a baked path for use inside the hook's single-quoted bash -c script:
// a double-quoted shell literal with \ ` $ " escaped keeps spaces intact.
const dq = (s) => `"${String(s).replaceAll("\\", "/").replace(/([`$"])/g, "\\$1")}"`;
const REPOS = gitRepos();
const MULTI = REPOS.length > 1 || !!process.env.ARIADNE_ROOTS;
// Single repo: the hook resolves everything at RUN time (survives repo moves).
// Multi-repo workspace: the workspace root cannot be derived from inside one
// member repo, so it is baked here — along with ARIADNE_ROOTS/ARIADNE_HOME so
// the incremental index actually runs in workspace mode with the shared DB.
const arBlock = MULTI
  ? `  AR=${dq(CWD + "/.ariadne")}\n  export ARIADNE_HOME=${dq(CWD)}\n  export ARIADNE_ROOTS=${dq(REPOS.join(","))}`
  : `  AR="$(git rev-parse --show-toplevel)/.ariadne"`;
const HOOK_BLOCK = `
# aegis-index-hook: keep the codebase graph fresh (background; never blocks git; lockfile prevents overlap)
(nohup bash -c '
${arBlock}
  [ -d "$AR" ] || exit 0
  {
    if [ -f "$AR/indexer.mjs" ]; then
      node "$AR/indexer.mjs" --incremental && node "$AR/docgen.mjs"
    elif [ -f "$AR/indexer.py" ]; then
      PY="$(command -v python3 || command -v python)"
      "$PY" "$AR/indexer.py" --incremental && "$PY" "$AR/docgen.py"
    fi
  } >> "$AR/index.log" 2>&1' >/dev/null 2>&1 &) || true
`;

let hooks = 0;
for (const repo of REPOS) {
  // git resolves the real hooks dir (worktrees, submodules, core.hooksPath);
  // .git/hooks was wrong for all three, silently skipping them
  let hookDir;
  try {
    hookDir = path.resolve(repo, execFileSync("git", ["rev-parse", "--git-path", "hooks"],
      { encoding: "utf8", cwd: repo }).trim());
  } catch { continue; /* not a git repo */ }
  fs.mkdirSync(hookDir, { recursive: true });
  for (const h of ["post-commit", "post-merge", "post-checkout"]) {
    const f = path.join(hookDir, h);
    const existing = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
    if (existing?.includes("aegis-index-hook")) { continue; }
    if (existing && /# AEGIS: refresh the codebase graph/.test(existing)) {
      // migrate a hook written by the previous installer (whole file was ours)
      fs.writeFileSync(f, "#!/bin/sh" + HOOK_BLOCK);
    } else if (existing) {
      // chain onto an existing hook instead of refusing (matches install-hooks.sh)
      fs.appendFileSync(f, HOOK_BLOCK);
    } else {
      fs.writeFileSync(f, "#!/bin/sh" + HOOK_BLOCK);
    }
    try { fs.chmodSync(f, 0o755); } catch { /* windows: mode ignored */ }
    hooks++;
  }
  const gi = path.join(repo, ".gitignore");
  const entries = "\n# AEGIS\n.ariadne/index.db*\n.ariadne/index.log\n.ariadne/.index.lock\n.ariadne/node_modules/\ndocs/generated/\n";
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
