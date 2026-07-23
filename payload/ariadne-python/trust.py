"""Extension trust gate (Python edition; mirror of trust.mjs).

`.ariadne/extensions/` is committed and shared, which means anyone with push
access could otherwise execute code in every teammate's MCP server process and
post-commit hook the moment they pull — and cloning a third-party repo and
starting the server would run whatever the repo happened to contain. So
extensions follow the same discipline as graph assertions: EXPLICITLY
approved, git-versioned, reviewed in PRs.

Approval lives in `.ariadne/extensions.lock` — a JSON map of filename to
sha256. A file executes only when its current hash matches its lock entry;
anything else (new file, edited file, missing/malformed lock) is skipped with
a WARN naming the file and the approval command. Approving is:

    python3 .ariadne/indexer.py --approve-extensions   (then commit the lock)

The lock is edition-agnostic (it hashes both .mjs and .py extension files), so
switching runtimes never invalidates approvals. ARIADNE_TRUST_EXTENSIONS=1
bypasses the gate for hermetic CI environments that construct the extensions
directory themselves.
"""
import hashlib
import json
import os
import re
from pathlib import Path

LOCK_NAME = "extensions.lock"


def _sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _read_lock(dir_: Path) -> dict:
    try:
        data = json.loads((dir_ / LOCK_NAME).read_text(encoding="utf-8"))
        return data.get("files", {}) if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001 - missing or malformed lock approves nothing
        return {}


def approved_files(dir_: Path, pattern: str, log=None):
    """Filenames in dir_ matching regex `pattern` approved to execute.
    Unapproved files are reported via log.warning and never loaded."""
    if not dir_.exists():
        return []
    rx = re.compile(pattern)
    files = sorted(f.name for f in dir_.iterdir() if rx.search(f.name))
    if not files:
        return []
    if os.environ.get("ARIADNE_TRUST_EXTENSIONS") == "1":
        return files
    lock = _read_lock(dir_)
    ok, skipped = [], []
    for f in files:
        try:
            h = _sha256(dir_ / f)
        except OSError:
            h = None
        (ok if h and lock.get(f) == h else skipped).append(f)
    if skipped and log is not None:
        log.warning(
            "extensions NOT loaded (unapproved, or changed since approval): %s. "
            "Review them, then run: python3 .ariadne/indexer.py --approve-extensions "
            "and commit .ariadne/%s (approval is PR-reviewed, exactly like graph assertions).",
            ", ".join(skipped), LOCK_NAME)
    return ok


def approve_all(dir_: Path) -> dict:
    """Hash every extension file (both editions) into the lock. Returns what changed."""
    if not dir_.exists():
        return {"approved": [], "changed": []}
    files = sorted(f.name for f in dir_.iterdir() if re.search(r"\.(mjs|py)$", f.name))
    prev = _read_lock(dir_)
    nxt = {f: _sha256(dir_ / f) for f in files}
    (dir_ / LOCK_NAME).write_text(json.dumps({
        "_comment": "AEGIS extension approvals: sha256 per extension file. Only files whose hash "
                    "matches may execute. Regenerate with --approve-extensions after reviewing "
                    "changes; commit this file.",
        "files": nxt,
    }, indent=2) + "\n", encoding="utf-8")
    return {"approved": files, "changed": [f for f in files if prev.get(f) != nxt[f]]}
