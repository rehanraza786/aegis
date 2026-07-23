#!/usr/bin/env python3
"""Cross-platform AEGIS setup (python-runtime twin of setup.mjs)."""
import os
import stat
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CWD = Path.cwd()
RUNTIME = "node" if (HERE / "indexer.mjs").exists() else "python"
PY = "python" if os.name == "nt" else "python3"


def git_repos():
    env = os.environ.get("ARIADNE_ROOTS")
    if env:
        return [Path(p.strip()) for p in env.split(",")]
    r = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, cwd=CWD)
    if r.returncode == 0 and r.stdout.strip():
        return [Path(r.stdout.strip())]
    return [d for d in CWD.iterdir() if d.is_dir() and not d.name.startswith(".") and (d / ".git").exists()]


def _dq(s) -> str:
    """Escape a baked path for the hook's single-quoted bash -c script: a
    double-quoted shell literal with backslash/backtick/dollar/quote escaped."""
    s = str(s).replace("\\", "/")
    for ch in ("`", "$", '"'):
        s = s.replace(ch, "\\" + ch)
    return f'"{s}"'


REPOS = git_repos()
MULTI = len(REPOS) > 1 or bool(os.environ.get("ARIADNE_ROOTS"))
# Single repo: the hook resolves everything at RUN time (survives repo moves).
# Multi-repo workspace: the workspace root cannot be derived from inside one
# member repo, so it is baked here — along with ARIADNE_ROOTS/ARIADNE_HOME so
# the incremental index actually runs in workspace mode with the shared DB.
if MULTI:
    AR_BLOCK = (f"  AR={_dq(CWD.as_posix() + '/.ariadne')}\n"
                f"  export ARIADNE_HOME={_dq(CWD.as_posix())}\n"
                f"  export ARIADNE_ROOTS={_dq(','.join(str(r) for r in REPOS))}")
else:
    AR_BLOCK = '  AR="$(git rev-parse --show-toplevel)/.ariadne"'
HOOK_BLOCK = f"""
# aegis-index-hook: keep the codebase graph fresh (background; never blocks git; lockfile prevents overlap)
(nohup bash -c '
{AR_BLOCK}
  [ -d "$AR" ] || exit 0
  {{
    if [ -f "$AR/indexer.mjs" ]; then
      node "$AR/indexer.mjs" --incremental && node "$AR/docgen.mjs"
    elif [ -f "$AR/indexer.py" ]; then
      PY="$(command -v python3 || command -v python)"
      "$PY" "$AR/indexer.py" --incremental && "$PY" "$AR/docgen.py"
    fi
  }} >> "$AR/index.log" 2>&1' >/dev/null 2>&1 &) || true
"""

hooks = 0
for repo in REPOS:
    # git resolves the real hooks dir (worktrees, submodules, core.hooksPath);
    # .git/hooks was wrong for all three, silently skipping them
    r = subprocess.run(["git", "rev-parse", "--git-path", "hooks"],
                       capture_output=True, text=True, cwd=repo)
    if r.returncode != 0:
        continue  # not a git repo
    hook_dir = (Path(repo) / r.stdout.strip()).resolve() if not Path(r.stdout.strip()).is_absolute() \
        else Path(r.stdout.strip())
    hook_dir.mkdir(parents=True, exist_ok=True)
    for h in ("post-commit", "post-merge", "post-checkout"):
        f = hook_dir / h
        existing = f.read_text(encoding="utf-8", errors="replace") if f.exists() else None
        if existing and "aegis-index-hook" in existing:
            continue
        if existing and "# AEGIS: refresh the codebase graph" in existing:
            # migrate a hook written by the previous installer (whole file was ours)
            f.write_text("#!/bin/sh" + HOOK_BLOCK, encoding="utf-8")
        elif existing:
            # chain onto an existing hook instead of refusing (matches install-hooks.sh)
            with f.open("a", encoding="utf-8") as fh:
                fh.write(HOOK_BLOCK)
        else:
            f.write_text("#!/bin/sh" + HOOK_BLOCK, encoding="utf-8")
        try:
            f.chmod(f.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        except OSError:
            pass
        hooks += 1
    gi = repo / ".gitignore"
    entries = "\n# AEGIS\n.ariadne/index.db*\n.ariadne/index.log\n.ariadne/.index.lock\n.ariadne/node_modules/\ndocs/generated/\n"
    if not gi.exists() or ".ariadne/index.db" not in gi.read_text(encoding="utf-8", errors="replace"):
        with gi.open("a", encoding="utf-8") as fh:
            fh.write(entries)
print(f"Hooks installed: {hooks}")

print("Building initial index...")
if RUNTIME == "node":
    cmd = ["node", str(HERE / "indexer.mjs"), "--full"]
else:
    cmd = [PY, str(HERE / "indexer.py"), "--full"]
if subprocess.run(cmd, cwd=CWD).returncode != 0:
    sys.exit("Index failed, see .ariadne/index.log")
dg = HERE / ("docgen.mjs" if RUNTIME == "node" else "docgen.py")
subprocess.run((["node"] if RUNTIME == "node" else [PY]) + [str(dg)], cwd=CWD)
print("AEGIS setup complete.")
