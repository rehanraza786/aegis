#!/usr/bin/env bash
# Pull the latest team-shared ariadne index built by GitLab CI (job: aegis-index).
#
# Works two ways (first available wins):
#   1. glab CLI (free, official: https://gitlab.com/gitlab-org/cli) — `glab auth login` once
#   2. curl + a token in $GITLAB_TOKEN (a read_api Project Access Token is enough)
#
# Optional env overrides:
#   GITLAB_HOST   (default: auto-detected from `git remote get-url origin`)
#   GITLAB_BRANCH (default: repo default branch, else main)
#
# Usage: bash .ariadne/pull-index.sh
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
JOB_NAME="aegis-index"
ARTIFACT_PATH=".ariadne/index.db"

# --- derive host + project path from the git remote --------------------------
ORIGIN="$(git remote get-url origin)"
if [[ "$ORIGIN" =~ ^git@([^:]+):(.+)\.git$ ]]; then
  HOST="${GITLAB_HOST:-${BASH_REMATCH[1]}}"; PROJECT="${BASH_REMATCH[2]}"
elif [[ "$ORIGIN" =~ ^https?://([^/]+)/(.+)$ ]]; then
  HOST="${GITLAB_HOST:-${BASH_REMATCH[1]}}"; PROJECT="${BASH_REMATCH[2]%.git}"
else
  echo "Could not parse origin remote '$ORIGIN'. Set GITLAB_HOST and edit this script."; exit 1
fi
BRANCH="${GITLAB_BRANCH:-$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|origin/||' || echo main)}"

fallback_local () {
  echo "Falling back to a local build..."
  if [ -f .ariadne/indexer.mjs ]; then node .ariadne/indexer.mjs --full; else python3 .ariadne/indexer.py --full; fi
  exit 0
}

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# --- path 1: glab CLI ---------------------------------------------------------
if command -v glab >/dev/null 2>&1; then
  echo "Using glab to fetch latest '$JOB_NAME' artifact from $BRANCH..."
  if glab ci artifact "$BRANCH" "$JOB_NAME" --path "$TMP/" -R "$PROJECT" >/dev/null 2>&1 \
     && [ -f "$TMP/$ARTIFACT_PATH" ]; then
    mv "$TMP/$ARTIFACT_PATH" .ariadne/index.db
    echo "Pulled shared index via glab:"; if [ -f .ariadne/indexer.mjs ]; then node .ariadne/indexer.mjs --status; else python3 .ariadne/indexer.py --status; fi
    exit 0
  fi
  echo "glab fetch failed (no successful run yet, or run: glab auth login)."
fi

# --- path 2: curl + GITLAB_TOKEN ----------------------------------------------
if [ -n "${GITLAB_TOKEN:-}" ]; then
  ENC_PROJECT=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$PROJECT")
  URL="https://$HOST/api/v4/projects/$ENC_PROJECT/jobs/artifacts/$BRANCH/raw/$ARTIFACT_PATH?job=$JOB_NAME"
  if curl -fsSL --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "$URL" -o "$TMP/index.db"; then
    mv "$TMP/index.db" .ariadne/index.db
    echo "Pulled shared index via API:"; if [ -f .ariadne/indexer.mjs ]; then node .ariadne/indexer.mjs --status; else python3 .ariadne/indexer.py --status; fi
    exit 0
  fi
  echo "API fetch failed (token needs read_api scope; job must have run on $BRANCH)."
fi

echo "No glab CLI found and no \$GITLAB_TOKEN set."
fallback_local
