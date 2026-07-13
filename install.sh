#!/usr/bin/env bash
# aegis-toolkit installer
# Run FROM THE ROOT of the repo you want to enhance:
#   bash /path/to/aegis-toolkit/install.sh [--no-ariadne] [--no-hooks]
#
# Installs: Agent Skills, custom agents, the Ariadne MCP server, git hooks,
# VS Code MCP config, and the copilot-instructions routing snippet.
# Idempotent: safe to re-run; never overwrites files you've modified without asking.
set -euo pipefail

TOOLKIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$TOOLKIT_DIR/payload"
TARGET="$(git rev-parse --show-toplevel 2>/dev/null || true)"

if [ -z "$TARGET" ]; then
  echo "Error: run this from inside the git repo you want to set up."; exit 1
fi
cd "$TARGET"
echo "Installing aegis-toolkit into: $TARGET"

WITH_GRAPHRAG=1; WITH_HOOKS=1; RUNTIME=node; ENGINE=ariadne
for arg in "$@"; do
  case "$arg" in
    --engine=*)       ENGINE="${arg#--engine=}" ;;
    --no-graph)       WITH_GRAPHRAG=0 ;;
    --no-ariadne)     WITH_GRAPHRAG=0 ;;
    --no-hooks)       WITH_HOOKS=0 ;;
    --runtime=node)   RUNTIME=node ;;
    --runtime=python) RUNTIME=python ;;
  esac
done
echo "graph engine: $ENGINE (override with --engine=ariadne|codebase-memory|code-graph|custom)"
case "$ENGINE" in ariadne|codebase-memory|code-graph|custom) ;; *) echo "Unknown engine '$ENGINE'"; exit 1 ;; esac
[ "$ENGINE" = ariadne ] && echo "ariadne runtime: $RUNTIME (override with --runtime=python|node)"

copy_if_absent () {  # $1=src $2=dst
  if [ -e "$2" ]; then
    echo "  skip (exists): $2"
  else
    mkdir -p "$(dirname "$2")"
    cp -r "$1" "$2"
    echo "  + $2"
  fi
}

echo "-- Skills"
for d in "$PAYLOAD"/.github/skills/*/; do
  copy_if_absent "$d" ".github/skills/$(basename "$d")"
done

echo "-- Agents"
for f in "$PAYLOAD"/.github/agents/*.agent.md; do
  copy_if_absent "$f" ".github/agents/$(basename "$f")"
done

echo "-- Project constitution"
copy_if_absent "$PAYLOAD/constitution-template.md" "docs/constitution.md"

echo "-- Copilot instructions routing"
append_engine_hints() {
  local hints
  hints=$(python3 -c "import json; print(json.load(open('$PAYLOAD/engines.json'))['$ENGINE']['toolHints'])")
  if ! grep -q "## Codebase graph engine" .github/copilot-instructions.md 2>/dev/null; then
    mkdir -p .github
    printf '\n## Codebase graph engine\nThis repo uses the %s graph engine (see aegis.json). %s\n' "$ENGINE" "$hints" >> .github/copilot-instructions.md
  fi
}
SNIPPET="$PAYLOAD/copilot-instructions-snippet.md"
CI_FILE=".github/copilot-instructions.md"
if [ -f "$CI_FILE" ] && grep -q "Codebase knowledge base" "$CI_FILE"; then
  echo "  skip (already contains routing section)"
else
  mkdir -p .github
  # strip the instructional comment block (everything before the first blank line)
  printf '\n' >> "$CI_FILE" 2>/dev/null || true
  sed '1,/^$/d' "$SNIPPET" >> "$CI_FILE"
  echo "  + appended routing section to $CI_FILE"
fi
[ "$WITH_GRAPHRAG" = 1 ] && append_engine_hints && echo "  + engine tool hints ($ENGINE)"

if [ "$WITH_GRAPHRAG" = 1 ]; then
  echo "-- Graph engine config (aegis.json)"
  if [ ! -f aegis.json ]; then
    python3 - "$ENGINE" "$PAYLOAD/engines.json" > aegis.json <<'PYEOF'
import json, sys
engine, registry_path = sys.argv[1], sys.argv[2]
reg = json.load(open(registry_path))[engine]
cfg = {"graphEngine": engine}
if not reg.get("managed"):
    cfg["mcp"] = {"command": reg.get("command", "REPLACE_ME"), "args": reg.get("args", [])}
print(json.dumps(cfg, indent=2))
PYEOF
    echo "  + aegis.json (engine: $ENGINE)"
  else
    echo "  skip (exists): aegis.json — edit graphEngine there to switch"
  fi

  if [ "$ENGINE" = ariadne ]; then
    echo "-- Ariadne MCP server ($RUNTIME edition)"
    copy_if_absent "$PAYLOAD/ariadne-$RUNTIME" ".ariadne"
    copy_if_absent "$PAYLOAD/install-hooks.sh" ".ariadne/install-hooks.sh"
    copy_if_absent "$PAYLOAD/pull-index.sh" ".ariadne/pull-index.sh"
    copy_if_absent "$PAYLOAD/gitlab-ci-aegis.yml" "gitlab-ci-aegis.yml"
  else
    echo "-- External graph engine '$ENGINE' selected: skipping .ariadne install, git hooks, and CI job (the engine manages its own index)."
    grep -o '"installHint":[^,}]*' "$PAYLOAD/engines.json" >/dev/null 2>&1 &&       python3 -c "import json,sys; print('  NOTE:', json.load(open('$PAYLOAD/engines.json'))['$ENGINE'].get('installHint','see the engine README'))"
    WITH_HOOKS=0
  fi

  echo "-- VS Code MCP config"
  if [ -f .vscode/mcp.json ]; then
    echo "  skip (exists): .vscode/mcp.json — add the ariadne server manually (see SETUP.md)"
  else
    mkdir -p .vscode
    if [ "$ENGINE" = ariadne ]; then
      if [ "$RUNTIME" = node ]; then CMD=node; ARGS='"${workspaceFolder}/.ariadne/server.mjs"'
      else CMD=python3; ARGS='"${workspaceFolder}/.ariadne/server.py"'; fi
    else
      CMD=$(python3 -c "import json; print(json.load(open('aegis.json'))['mcp']['command'])")
      ARGS=$(python3 -c "import json; print(', '.join(json.dumps(a) for a in json.load(open('aegis.json'))['mcp']['args']))")
    fi
    cat > .vscode/mcp.json <<JSON
{
  "servers": {
    "$ENGINE": {
      "type": "stdio",
      "command": "$CMD",
      "args": [$ARGS]
    }
  }
}
JSON
    echo "  + .vscode/mcp.json ($RUNTIME)"
  fi

  if [ "$WITH_HOOKS" = 1 ]; then
    echo "-- Git hooks + initial index"
    bash .ariadne/install-hooks.sh
  else
    echo "-- Skipping hooks (--no-hooks). Build index manually: python3 .ariadne/indexer.py --full"
  fi
fi

echo
echo "Done. Next steps:"
echo "  1. Review changes:  git status"
echo "  2. Commit the .github/, .ariadne/, .vscode/ additions"
echo "  3. GitLab teams: merge the job from gitlab-ci-aegis.yml into .gitlab-ci.yml"
echo "  4. In VS Code: open .vscode/mcp.json and click Start; verify tools in Copilot agent mode"
echo "  5. Read SETUP.md in the toolkit for daily-use guidance"
