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


HOOK = f"""#!/bin/sh
# AEGIS: refresh the codebase graph in the background (never blocks git)
AR="{CWD.as_posix()}/.ariadne"
[ -f "$AR/indexer.mjs" ] && IDX="node \\"$AR/indexer.mjs\\"" || IDX="${{PYTHON:-python3}} \\"$AR/indexer.py\\""
command -v python3 >/dev/null 2>&1 || PYTHON=python
( eval "$IDX --incremental" >> "$AR/index.log" 2>&1
  if [ -f "$AR/docgen.mjs" ]; then node "$AR/docgen.mjs" >> "$AR/index.log" 2>&1; \\
  elif [ -f "$AR/docgen.py" ]; then ${{PYTHON:-python3}} "$AR/docgen.py" >> "$AR/index.log" 2>&1; fi ) &
exit 0
"""

hooks = 0
for repo in git_repos():
    hook_dir = repo / ".git" / "hooks"
    if not hook_dir.exists():
        continue
    for h in ("post-commit", "post-merge", "post-checkout"):
        f = hook_dir / h
        if f.exists() and "AEGIS" not in f.read_text(errors="replace"):
            print(f"  skip {h} in {repo.name} (existing non-AEGIS hook)")
            continue
        f.write_text(HOOK)
        try:
            f.chmod(f.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        except OSError:
            pass
        hooks += 1
    gi = repo / ".gitignore"
    entries = "\n# AEGIS\n.ariadne/index.db*\n.ariadne/index.log\n.ariadne/index.lock\n.ariadne/node_modules/\ndocs/generated/\n"
    if not gi.exists() or ".ariadne/index.db" not in gi.read_text(errors="replace"):
        with gi.open("a") as fh:
            fh.write(entries)
print(f"Hooks installed: {hooks}")

print("Building initial index...")
if RUNTIME == "node":
    cmd = ["node", str(HERE / "indexer.mjs"), "--full"]
else:
    cmd = [PY, str(HERE / "indexer.py"), "--full"]
if subprocess.run(cmd, cwd=CWD).returncode != 0:
    sys.exit("Index failed — see .ariadne/index.log")
dg = HERE / ("docgen.mjs" if RUNTIME == "node" else "docgen.py")
subprocess.run((["node"] if RUNTIME == "node" else [PY]) + [str(dg)], cwd=CWD)
print("AEGIS setup complete.")
