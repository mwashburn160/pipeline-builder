#!/usr/bin/env bash
set -euo pipefail

# Verify that every PUBLISHED @pipeline-builder/* package pins @pipeline-builder/*
# dependency versions that ACTUALLY resolve on the npm registry. The npm analog of
# verify-image-tags.sh — run in CI AFTER `pnpm publish` to catch the gap where a
# package is published with an internal dependency version that was never published
# (e.g. pipeline-manager pinning ai-core@<unpublished>, which 404s on install).
#
# Usage:
#   deploy/bin/verify-npm-deps.sh [pkg ...]    # default: the published libraries
#
# Exit codes: 0 = every internal dep resolves · 1 = one or more missing.

SCOPE='@pipeline-builder'
REGISTRY='https://registry.npmjs.org'

# npm CDN propagation can lag a few seconds after `pnpm publish`, so retry a
# "missing" lookup before declaring a version genuinely unpublished (avoids a
# false release failure on the publish→serve race). Existing versions return on
# the first try, so this only costs time when something actually looks missing.
ATTEMPTS=6
DELAY=10
resolve() {  # <name> <version> → 0 if the exact version resolves on npm
  local dep="$1" want="$2" i
  for ((i = 1; i <= ATTEMPTS; i++)); do
    curl -fsS -o /dev/null "${REGISTRY}/${SCOPE}/${dep}/${want}" 2>/dev/null && return 0
    [ "$i" -lt "$ATTEMPTS" ] && sleep "$DELAY"
  done
  return 1
}

LIBS=("$@")
if [ "${#LIBS[@]}" -eq 0 ]; then
  # The published libraries (mirror LIBRARY_PROJECTS in projenrc/workflow.ts).
  LIBS=(api-core ai-core api-server pipeline-core pipeline-data pipeline-events pipeline-manager)
fi

echo "Verifying internal npm deps of ${#LIBS[@]} published package(s) …"
MISSING=()
for lib in "${LIBS[@]}"; do
  # Latest published version + its @pipeline-builder deps, as `VERSION x` / `DEP name req` lines.
  info="$(curl -fsSL "${REGISTRY}/${SCOPE}/${lib}" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
v = d['dist-tags']['latest']
print('VERSION', v)
for k, req in d['versions'][v].get('dependencies', {}).items():
    if k.startswith('${SCOPE}/'):
        print('DEP', k.split('/', 1)[1], req)
" 2>/dev/null || true)"

  ver="$(awk '/^VERSION /{print $2; exit}' <<<"$info")"
  if [ -z "$ver" ]; then
    echo "  warn  ${SCOPE}/${lib}: not published / unreadable — skipping"
    continue
  fi
  echo "${SCOPE}/${lib}@${ver}:"
  while read -r tag dep req; do
    [ "$tag" = DEP ] || continue
    want="${req#^}"; want="${want#~}"          # internal deps are pinned exact; tolerate ^/~
    if resolve "$dep" "$want"; then
      echo "  ok      ${SCOPE}/${dep}@${req}"
    else
      echo "  MISSING ${SCOPE}/${dep}@${req}"
      MISSING+=("${SCOPE}/${lib}@${ver} → ${SCOPE}/${dep}@${req}")
    fi
  done <<<"$info"
done

if [ "${#MISSING[@]}" -gt 0 ]; then
  {
    echo
    echo "ERROR: ${#MISSING[@]} internal dependency version(s) are NOT published on npm:"
    printf '  - %s\n' "${MISSING[@]}"
    echo "Publish the missing version(s) — a published package must not pin an unpublished internal dep."
  } >&2
  exit 1
fi

echo
echo "All internal @pipeline-builder npm deps resolve ✓"
