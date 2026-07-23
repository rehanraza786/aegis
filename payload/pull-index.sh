#!/usr/bin/env bash
# Pull the latest team-shared ariadne index built by CI (job/workflow: aegis-index).
# Provider is auto-detected from the origin remote: GitLab (any host) or GitHub.
#
# GitLab (first available wins):
#   1. glab CLI (https://gitlab.com/gitlab-org/cli), `glab auth login` once
#   2. curl + $GITLAB_TOKEN (a read_api Project Access Token is enough)
# GitHub (first available wins):
#   1. gh CLI (https://cli.github.com), `gh auth login` once
#   2. curl + $GITHUB_TOKEN (repo read + actions read)
#
# Optional env overrides:
#   AEGIS_CI_HOST   (default: auto-detected from `git remote get-url origin`)
#   AEGIS_CI_BRANCH (default: repo default branch, else main)
#   GITLAB_HOST/GITLAB_BRANCH are honored as legacy aliases.
#
# Usage: bash .ariadne/pull-index.sh
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
JOB_NAME="aegis-index"
ARTIFACT_PATH=".ariadne/index.db"
PYBIN="$(command -v python3 || command -v python || true)"

# --- derive host + project path from the git remote --------------------------
ORIGIN="$(git remote get-url origin)"
if [[ "$ORIGIN" =~ ^ssh://([^@]+@)?([^:/]+)(:[0-9]+)?/(.+)$ ]]; then
  HOST="${BASH_REMATCH[2]}"; PROJECT="${BASH_REMATCH[4]%.git}"
elif [[ "$ORIGIN" =~ ^[^@]+@([^:]+):(.+)$ ]]; then
  HOST="${BASH_REMATCH[1]}"; PROJECT="${BASH_REMATCH[2]%.git}"
elif [[ "$ORIGIN" =~ ^https?://([^/]+)/(.+)$ ]]; then
  HOST="${BASH_REMATCH[1]}"; PROJECT="${BASH_REMATCH[2]%.git}"
else
  echo "Could not parse origin remote '$ORIGIN'. Set AEGIS_CI_HOST and edit this script."; exit 1
fi
HOST="${AEGIS_CI_HOST:-${GITLAB_HOST:-$HOST}}"
BRANCH="${AEGIS_CI_BRANCH:-${GITLAB_BRANCH:-$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|origin/||' || echo main)}}"

fallback_local () {
  echo "Falling back to a local build..."
  if [ -f .ariadne/indexer.mjs ]; then node .ariadne/indexer.mjs --full
  elif [ -n "$PYBIN" ]; then "$PYBIN" .ariadne/indexer.py --full
  else echo "No runtime found to build locally."; exit 1; fi
  exit 0
}

show_status () {
  if [ -f .ariadne/indexer.mjs ]; then node .ariadne/indexer.mjs --status
  elif [ -n "$PYBIN" ]; then "$PYBIN" .ariadne/indexer.py --status; fi
}

urlencode () {  # portable percent-encoding via whichever runtime exists
  if [ -n "$PYBIN" ]; then
    "$PYBIN" -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"
  else
    node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
  fi
}

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# =============================== GitHub ======================================
if [[ "$HOST" == *github* ]]; then
  # --- path 1: gh CLI ---------------------------------------------------------
  if command -v gh >/dev/null 2>&1; then
    echo "Using gh to fetch the latest '$JOB_NAME' artifact from $BRANCH..."
    RUN_ID="$(gh run list -R "$PROJECT" --branch "$BRANCH" --workflow "$JOB_NAME" \
      --status success --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
    if [ -n "$RUN_ID" ] && gh run download "$RUN_ID" -R "$PROJECT" -n "$JOB_NAME" --dir "$TMP" >/dev/null 2>&1 \
       && [ -f "$TMP/$ARTIFACT_PATH" ]; then
      mv "$TMP/$ARTIFACT_PATH" .ariadne/index.db
      echo "Pulled shared index via gh:"; show_status; exit 0
    fi
    echo "gh fetch failed (no successful '$JOB_NAME' run on $BRANCH yet, or run: gh auth login)."
  fi
  # --- path 2: curl + GITHUB_TOKEN --------------------------------------------
  if [ -n "${GITHUB_TOKEN:-}" ] && [ -n "$PYBIN" ]; then
    API="https://api.${HOST#*.}"; [[ "$HOST" == github.com ]] && API="https://api.github.com"
    DL_URL="$(curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" \
      "$API/repos/$PROJECT/actions/artifacts?name=$JOB_NAME&per_page=1" \
      | "$PYBIN" -c "import json,sys; a=json.load(sys.stdin).get('artifacts') or []; print(a[0]['archive_download_url'] if a else '')")"
    if [ -n "$DL_URL" ] && curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$DL_URL" -o "$TMP/a.zip"; then
      "$PYBIN" -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$TMP/a.zip" "$TMP"
      SRC="$TMP/$ARTIFACT_PATH"; [ -f "$SRC" ] || SRC="$TMP/index.db"
      if [ -f "$SRC" ]; then
        mv "$SRC" .ariadne/index.db
        echo "Pulled shared index via GitHub API:"; show_status; exit 0
      fi
    fi
    echo "GitHub API fetch failed (token needs repo+actions read; workflow must have run on $BRANCH)."
  fi
  echo "No gh CLI found and no \$GITHUB_TOKEN set."
  fallback_local
fi

# =============================== GitLab ======================================
# --- path 1: glab CLI ---------------------------------------------------------
if command -v glab >/dev/null 2>&1; then
  echo "Using glab to fetch latest '$JOB_NAME' artifact from $BRANCH..."
  if glab ci artifact "$BRANCH" "$JOB_NAME" --path "$TMP/" -R "$PROJECT" >/dev/null 2>&1 \
     && [ -f "$TMP/$ARTIFACT_PATH" ]; then
    mv "$TMP/$ARTIFACT_PATH" .ariadne/index.db
    echo "Pulled shared index via glab:"; show_status; exit 0
  fi
  echo "glab fetch failed (no successful run yet, or run: glab auth login)."
fi

# --- path 2: curl + GITLAB_TOKEN ----------------------------------------------
if [ -n "${GITLAB_TOKEN:-}" ]; then
  ENC_PROJECT="$(urlencode "$PROJECT")"
  URL="https://$HOST/api/v4/projects/$ENC_PROJECT/jobs/artifacts/$BRANCH/raw/$ARTIFACT_PATH?job=$JOB_NAME"
  if curl -fsSL --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "$URL" -o "$TMP/index.db"; then
    mv "$TMP/index.db" .ariadne/index.db
    echo "Pulled shared index via API:"; show_status; exit 0
  fi
  echo "API fetch failed (token needs read_api scope; job must have run on $BRANCH)."
fi

echo "No glab CLI found and no \$GITLAB_TOKEN set."
fallback_local
