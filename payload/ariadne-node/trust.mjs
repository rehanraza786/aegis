/**
 * Extension trust gate. `.ariadne/extensions/` is committed and shared, which
 * means anyone with push access could otherwise execute code in every
 * teammate's MCP server process and post-commit hook the moment they pull —
 * and cloning a third-party repo and starting the server would run whatever
 * the repo happened to contain. So extensions follow the same discipline as
 * graph assertions: EXPLICITLY approved, git-versioned, reviewed in PRs.
 *
 * Approval lives in `.ariadne/extensions.lock` — a JSON map of filename to
 * sha256. A file executes only when its current hash matches its lock entry;
 * anything else (new file, edited file, missing/malformed lock) is skipped
 * with a WARN naming the file and the approval command. Approving is:
 *
 *   node .ariadne/indexer.mjs --approve-extensions   (then commit the lock)
 *
 * The lock is edition-agnostic (it hashes both .mjs and .py extension files),
 * so switching runtimes never invalidates approvals. ARIADNE_TRUST_EXTENSIONS=1
 * bypasses the gate for hermetic CI environments that construct the extensions
 * directory themselves.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const LOCK_NAME = "extensions.lock";

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function readLock(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, LOCK_NAME), "utf8"));
    return data && typeof data.files === "object" ? data.files : {};
  } catch { return {}; }
}

/** Filenames in `dir` matching `pattern` that are approved to execute.
 *  Unapproved files are reported through `log(level, msg)` and never loaded. */
export function approvedFiles(dir, pattern, log = (l, m) => console.error(m)) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((x) => pattern.test(x)).sort();
  if (!files.length) return [];
  if (process.env.ARIADNE_TRUST_EXTENSIONS === "1") return files;
  const lock = readLock(dir);
  const ok = [], skipped = [];
  for (const f of files) {
    let h = null;
    try { h = sha256(path.join(dir, f)); } catch { /* unreadable */ }
    (h && lock[f] === h ? ok : skipped).push(f);
  }
  if (skipped.length) {
    log("WARN", `extensions NOT loaded (unapproved, or changed since approval): ${skipped.join(", ")}. ` +
      `Review them, then run: node .ariadne/indexer.mjs --approve-extensions ` +
      `and commit .ariadne/${LOCK_NAME} (approval is PR-reviewed, exactly like graph assertions).`);
  }
  return ok;
}

/** Hash every extension file (both editions) into the lock. Returns what changed. */
export function approveAll(dir) {
  if (!fs.existsSync(dir)) return { approved: [], changed: [] };
  const files = fs.readdirSync(dir).filter((x) => /\.(mjs|py)$/.test(x)).sort();
  const prev = readLock(dir);
  const next = {};
  for (const f of files) next[f] = sha256(path.join(dir, f));
  fs.writeFileSync(path.join(dir, LOCK_NAME), JSON.stringify({
    _comment: "AEGIS extension approvals: sha256 per extension file. Only files whose hash matches " +
      "may execute. Regenerate with --approve-extensions after reviewing changes; commit this file.",
    files: next,
  }, null, 2) + "\n");
  return { approved: files, changed: files.filter((f) => prev[f] !== next[f]) };
}
