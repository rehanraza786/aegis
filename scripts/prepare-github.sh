#!/usr/bin/env bash
# Stamp your GitHub identity into the repo before the first push.
#
#   bash scripts/prepare-github.sh <github-username>/<repo> ["Your Name"]
#
# Example (personal account):
#   bash scripts/prepare-github.sh jsmith/aegis "Jane Smith"
#
# Personal accounts and organizations work identically here — a GitHub URL is
# github.com/<owner>/<repo> either way.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <github-username>/<repo> [\"Your Name\"]" >&2
  exit 1
fi

SLUG="$1"                     # e.g. jsmith/aegis
OWNER="${SLUG%%/*}"           # e.g. jsmith
NAME="${2:-$OWNER}"           # copyright holder; defaults to the username

case "$SLUG" in
  */*) ;;
  *) echo "error: expected <owner>/<repo>, got '$SLUG'" >&2; exit 1 ;;
esac

# Repo URL, badges, docs
for f in README.md SETUP.md docs/RELEASING.md extension/package.json; do
  [ -f "$f" ] || continue
  sed -i.bak "s|YOUR-USERNAME/aegis|${SLUG}|g; s|YOUR-ORG/aegis|${SLUG}|g" "$f" && rm -f "$f.bak"
done

# Extension publisher. Only needs to be a *registered* VS Code Marketplace
# publisher ID if you ever run `vsce publish`; for installing the .vsix straight
# from a GitHub Release it is just the name shown in the Extensions panel.
python3 - "$OWNER" <<'PY'
import json, sys
p = json.load(open("extension/package.json"))
p["publisher"] = sys.argv[1]
json.dump(p, open("extension/package.json", "w"), indent=2)
PY

# Copyright holder
sed -i.bak "s|Copyright (c) 2026 AEGIS contributors|Copyright (c) 2026 ${NAME}|" LICENSE && rm -f LICENSE.bak

echo "Stamped:"
echo "  repo        ${SLUG}"
echo "  publisher   ${OWNER}"
echo "  copyright   ${NAME}"
echo
echo "Review with: git diff  (or just: grep -rn '${SLUG}' README.md extension/package.json)"
