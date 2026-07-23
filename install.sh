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

WITH_GRAPHRAG=1; WITH_HOOKS=1; RUNTIME=node; ENGINE=ariadne; HOST=copilot
for arg in "$@"; do
  case "$arg" in
    --engine=*)       ENGINE="${arg#--engine=}" ;;
    --host=*)         HOST="${arg#--host=}" ;;
    --no-graph)       WITH_GRAPHRAG=0 ;;
    --no-ariadne)     WITH_GRAPHRAG=0 ;;
    --no-hooks)       WITH_HOOKS=0 ;;
    --runtime=node)   RUNTIME=node ;;
    --runtime=python) RUNTIME=python ;;
  esac
done
# Which agent host(s) get the prompt layer. copilot = today's flow; claude =
# Claude Code (.claude/skills, .claude/agents, CLAUDE.md, .mcp.json); cursor =
# .cursor/rules + .cursor/mcp.json; agents = a generic AGENTS.md host (Zed,
# Codex CLI, ...). Comma-combine, or --host=all for everything.
for h in $(echo "$HOST" | tr ',' ' '); do
  case "$h" in copilot|claude|cursor|agents|all) ;; *) echo "Unknown host '$h' (copilot|claude|cursor|agents|all)"; exit 1 ;; esac
done
host_wants() { case ",$HOST," in *",$1,"*|*",all,"*) return 0 ;; *) return 1 ;; esac; }
echo "prompt-layer host(s): $HOST (override with --host=copilot|claude|cursor|agents|all, comma-combinable)"
echo "graph engine: $ENGINE (override with --engine=ariadne|codebase-memory|code-graph|custom)"
case "$ENGINE" in ariadne|codebase-memory|code-graph|custom) ;; *) echo "Unknown engine '$ENGINE'"; exit 1 ;; esac
[ "$ENGINE" = ariadne ] && echo "ariadne runtime: $RUNTIME (override with --runtime=python|node)"

# JSON helper: use whichever runtime exists. The old hard python3 dependency
# broke node-only machines (and killed the install mid-way with set -e after
# `> aegis.json` had already created an empty file); python-only Windows boxes
# ship `python`, not `python3`.
JSON_BIN=""
for c in node python3 python; do command -v "$c" >/dev/null 2>&1 && { JSON_BIN=$c; break; }; done
[ -n "$JSON_BIN" ] || { echo "Error: need node or python on PATH."; exit 1; }
json_engine_field() {  # $1=field -> engines.json[$ENGINE][$1], "" if absent
  case "$JSON_BIN" in
    node) node -e 'const v=(require(process.argv[1])[process.argv[2]]||{})[process.argv[3]];if(v!=null)process.stdout.write(typeof v==="string"?v:JSON.stringify(v))' "$PAYLOAD/engines.json" "$ENGINE" "$1" ;;
    *) "$JSON_BIN" -c 'import json,sys
v=json.load(open(sys.argv[1])).get(sys.argv[2],{}).get(sys.argv[3])
sys.stdout.write("" if v is None else v if isinstance(v,str) else json.dumps(v))' "$PAYLOAD/engines.json" "$ENGINE" "$1" ;;
  esac
}
json_aegis_mcp() {  # $1=command|args -> from ./aegis.json .mcp, tolerating missing keys
  case "$JSON_BIN" in
    node) node -e 'const m=require(process.argv[1]).mcp||{};process.stdout.write(process.argv[2]==="command"?(m.command||"REPLACE_ME"):(m.args||[]).map(a=>JSON.stringify(a)).join(", "))' "$PWD/aegis.json" "$1" ;;
    *) "$JSON_BIN" -c 'import json,sys
m=json.load(open("aegis.json")).get("mcp") or {}
sys.stdout.write(m.get("command","REPLACE_ME") if sys.argv[1]=="command" else ", ".join(json.dumps(a) for a in m.get("args") or []))' "$1" ;;
  esac
}

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
if host_wants copilot; then
  for d in "$PAYLOAD"/.github/skills/*/; do
    copy_if_absent "$d" ".github/skills/$(basename "$d")"
  done
fi
if host_wants claude; then
  # same Agent Skills format, Claude Code's location
  for d in "$PAYLOAD"/.github/skills/*/; do
    copy_if_absent "$d" ".claude/skills/$(basename "$d")"
  done
fi

echo "-- Agents"
if host_wants copilot; then
  for f in "$PAYLOAD"/.github/agents/*.agent.md; do
    copy_if_absent "$f" ".github/agents/$(basename "$f")"
  done
fi
if host_wants claude; then
  # Claude Code subagents: same frontmatter (name/description), .md filenames
  for f in "$PAYLOAD"/.github/agents/*.agent.md; do
    base="$(basename "$f" .agent.md)"
    copy_if_absent "$f" ".claude/agents/$base.md"
  done
fi

echo "-- Project constitution"
copy_if_absent "$PAYLOAD/constitution-template.md" "docs/constitution.md"

echo "-- Agent routing instructions"
SNIPPET="$PAYLOAD/copilot-instructions-snippet.md"
append_router() {  # $1 = target file; appends the routing section once
  if [ -f "$1" ] && grep -q "Codebase knowledge base" "$1"; then
    echo "  skip (already contains routing section): $1"
    return
  fi
  mkdir -p "$(dirname "$1")"
  # strip the instructional comment block (everything before the first blank line)
  printf '\n' >> "$1" 2>/dev/null || true
  sed '1,/^$/d' "$SNIPPET" >> "$1"
  echo "  + appended routing section to $1"
}
append_engine_hints() {  # $1 = target file
  local hints
  hints=$(json_engine_field toolHints)
  if ! grep -q "## Codebase graph engine" "$1" 2>/dev/null; then
    printf '\n## Codebase graph engine\nThis repo uses the %s graph engine (see aegis.json). %s\n' "$ENGINE" "$hints" >> "$1"
  fi
}
ROUTER_FILES=()
host_wants copilot && ROUTER_FILES+=(".github/copilot-instructions.md")
host_wants claude && ROUTER_FILES+=("CLAUDE.md")
host_wants agents && ROUTER_FILES+=("AGENTS.md")
for rf in ${ROUTER_FILES[@]+"${ROUTER_FILES[@]}"}; do
  append_router "$rf"
  [ "$WITH_GRAPHRAG" = 1 ] && append_engine_hints "$rf" && echo "  + engine tool hints ($ENGINE) in $rf"
done
if host_wants cursor; then
  RULE=".cursor/rules/aegis-graph.mdc"
  if [ -f "$RULE" ]; then
    echo "  skip (exists): $RULE"
  else
    mkdir -p .cursor/rules
    printf -- '---\ndescription: AEGIS codebase-graph routing (always applied)\nalwaysApply: true\n---\n' > "$RULE"
    sed '1,/^$/d' "$SNIPPET" >> "$RULE"
    [ "$WITH_GRAPHRAG" = 1 ] && append_engine_hints "$RULE"
    echo "  + $RULE"
  fi
fi

if [ "$WITH_GRAPHRAG" = 1 ]; then
  echo "-- Graph engine config (aegis.json)"
  if [ ! -f aegis.json ]; then
    # write to a temp file then mv: a failure mid-generation must never leave a
    # truncated aegis.json behind (re-runs used to skip it as "exists" and wedge)
    TMP_JSON="$(mktemp)"
    if [ "$(json_engine_field managed)" = "true" ]; then
      printf '{\n  "graphEngine": "%s"\n}\n' "$ENGINE" > "$TMP_JSON"
    else
      MCP_CMD="$(json_engine_field command)"; [ -n "$MCP_CMD" ] || MCP_CMD=REPLACE_ME
      MCP_ARGS="$(json_engine_field args)"; [ -n "$MCP_ARGS" ] || MCP_ARGS='[]'
      printf '{\n  "graphEngine": "%s",\n  "mcp": { "command": "%s", "args": %s }\n}\n' \
        "$ENGINE" "$MCP_CMD" "$MCP_ARGS" > "$TMP_JSON"
    fi
    mv "$TMP_JSON" aegis.json
    echo "  + aegis.json (engine: $ENGINE)"
  else
    echo "  skip (exists): aegis.json, edit graphEngine there to switch"
  fi

  if [ "$ENGINE" = ariadne ]; then
    echo "-- Ariadne MCP server ($RUNTIME edition)"
    copy_if_absent "$PAYLOAD/ariadne-$RUNTIME" ".ariadne"
    copy_if_absent "$PAYLOAD/install-hooks.sh" ".ariadne/install-hooks.sh"
    copy_if_absent "$PAYLOAD/pull-index.sh" ".ariadne/pull-index.sh"
    copy_if_absent "$PAYLOAD/gitlab-ci-aegis.yml" "gitlab-ci-aegis.yml"
    copy_if_absent "$PAYLOAD/github-actions-aegis.yml" "github-actions-aegis.yml"
  else
    echo "-- External graph engine '$ENGINE' selected: skipping .ariadne install, git hooks, and CI job (the engine manages its own index)."
    HINT="$(json_engine_field installHint)"
    [ -n "$HINT" ] && echo "  NOTE: $HINT"
    WITH_HOOKS=0
  fi

  echo "-- MCP client config"
  if [ "$ENGINE" = ariadne ]; then
    if [ "$RUNTIME" = node ]; then
      CMD=node; ARGS_REL='".ariadne/server.mjs"'; ARGS_VSC='"${workspaceFolder}/.ariadne/server.mjs"'
    else
      CMD=python3; ARGS_REL='".ariadne/server.py"'; ARGS_VSC='"${workspaceFolder}/.ariadne/server.py"'
    fi
  else
    CMD=$(json_aegis_mcp command)
    ARGS_REL=$(json_aegis_mcp args)
    ARGS_VSC="$ARGS_REL"
  fi
  if host_wants copilot; then
    if [ -f .vscode/mcp.json ]; then
      echo "  skip (exists): .vscode/mcp.json, add the ariadne server manually (see SETUP.md)"
    else
      mkdir -p .vscode
      cat > .vscode/mcp.json <<JSON
{
  "servers": {
    "$ENGINE": {
      "type": "stdio",
      "command": "$CMD",
      "args": [$ARGS_VSC]
    }
  }
}
JSON
      echo "  + .vscode/mcp.json ($RUNTIME)"
    fi
  fi
  write_mcpservers_json() {  # $1 = target file (Claude Code / Cursor mcpServers shape)
    if [ -f "$1" ]; then
      echo "  skip (exists): $1, add the $ENGINE server manually"
      return
    fi
    mkdir -p "$(dirname "$1")"
    cat > "$1" <<JSON
{
  "mcpServers": {
    "$ENGINE": {
      "command": "$CMD",
      "args": [$ARGS_REL]
    }
  }
}
JSON
    echo "  + $1 ($RUNTIME)"
  }
  host_wants claude && write_mcpservers_json ".mcp.json"
  host_wants cursor && write_mcpservers_json ".cursor/mcp.json"

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
echo "  2. Commit the .github/.ariadne/.vscode/ additions"
echo "  3. GitLab teams: merge the job from gitlab-ci-aegis.yml into .gitlab-ci.yml"
echo "  4. In VS Code: open .vscode/mcp.json and click Start; verify tools in Copilot agent mode"
echo "     (other hosts: --host=claude writes .claude/ + CLAUDE.md + .mcp.json; --host=cursor writes .cursor/; --host=agents writes AGENTS.md)"
echo "  5. Read SETUP.md in the toolkit for daily-use guidance"
