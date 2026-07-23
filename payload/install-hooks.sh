#!/usr/bin/env bash
# Installs git hooks that keep the Ariadne (GraphRAG-style) index updated on every commit,
# merge, and branch switch. Auto-detects runtime (Node or Python edition)
# by which indexer file is present in .ariadne/. Idempotent; chains to
# existing hooks; never blocks git operations.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_DIR="$(git rev-parse --git-path hooks)"
GR="$REPO_ROOT/.ariadne"

# --- detect runtime ---
if [ -f "$GR/indexer.mjs" ]; then
  RUNTIME=node
  command -v node >/dev/null || { echo "Error: Node >=18 required (https://nodejs.org)"; exit 1; }
  echo "Runtime: Node ($(node --version))"
  (cd "$GR" && npm install --silent --no-audit --no-fund)
elif [ -f "$GR/indexer.py" ]; then
  RUNTIME=python
  PY="$(command -v python3 || command -v python || true)"
  [ -n "$PY" ] || { echo "Error: Python 3.10+ required"; exit 1; }
  echo "Runtime: Python ($($PY --version 2>&1))"
  "$PY" -m pip install -r "$GR/requirements.txt" --quiet 2>/dev/null \
    || "$PY" -m pip install -r "$GR/requirements.txt" --break-system-packages --quiet \
    || echo "WARN: pip install failed; run manually: pip install -r .ariadne/requirements.txt"
else
  echo "Error: no indexer found in $GR (expected indexer.mjs or indexer.py)"; exit 1
fi

install_hook () {
  local name="$1"
  local hook="$HOOKS_DIR/$name"
  if [ -f "$hook" ] && grep -q "aegis-index-hook" "$hook"; then echo "  hook exists: $name"; return; fi
  [ -f "$hook" ] || echo "#!/usr/bin/env bash" > "$hook"
  # QUOTED heredoc: nothing expands at install time, so the hook resolves the
  # repo root, the runtime, and the interpreter when it RUNS. No baked absolute
  # paths (survives moving the repo), and paths with spaces stay quoted.
  cat >> "$hook" <<'HOOK'

# aegis-index-hook: keep the codebase graph fresh (background; never blocks git; lockfile prevents overlap)
(nohup bash -c '
  AR="$(git rev-parse --show-toplevel)/.ariadne"
  [ -d "$AR" ] || exit 0
  {
    if [ -f "$AR/indexer.mjs" ]; then
      node "$AR/indexer.mjs" --incremental && node "$AR/docgen.mjs"
    elif [ -f "$AR/indexer.py" ]; then
      PY="$(command -v python3 || command -v python)"
      "$PY" "$AR/indexer.py" --incremental && "$PY" "$AR/docgen.py"
    fi
  } >> "$AR/index.log" 2>&1' >/dev/null 2>&1 &) || true
HOOK
  chmod +x "$hook"
  echo "  installed: $name"
}
echo "Installing hooks..."
install_hook post-commit
install_hook post-merge
install_hook post-checkout

GITIGNORE="$REPO_ROOT/.gitignore"
for entry in ".ariadne/index.db" ".ariadne/index.db-wal" ".ariadne/index.db-shm" \
             ".ariadne/index.log" ".ariadne/.index.lock" ".ariadne/node_modules/"; do
  grep -qxF "$entry" "$GITIGNORE" 2>/dev/null || echo "$entry" >> "$GITIGNORE"
done
echo ".gitignore updated"

echo "Building initial index..."
if [ "$RUNTIME" = node ]; then node "$GR/indexer.mjs" --full; else "$PY" "$GR/indexer.py" --full; fi
echo "Done. Index refreshes automatically on commit/merge/checkout (per-clone; each teammate runs this once)."
