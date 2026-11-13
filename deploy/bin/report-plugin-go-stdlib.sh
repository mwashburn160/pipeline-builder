#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Report the Go toolchain that built every prebuilt Go binary the plugin images
# COPY in from an upstream image, against the repo's Go line.
#
# WHY: many plugins take a tool straight out of its vendor's image
# (`FROM aquasec/trivy:${TRIVY_VERSION} AS trivy-src` … `COPY --from=trivy-src`).
# That binary carries the Go standard library it was compiled with, and the
# vendor's Go is often several patch releases — sometimes a minor — behind. The
# plugin's own scan reports those stdlib CVEs, but nothing pointed at WHICH
# upstream image is the cause or how far behind it is. This does.
#
# The reference is GO_VERSION in deploy/plugins/_base/_go-base/Dockerfile (held
# equal to GO_IMAGE in api/plugin and api/image-registry by test/deploy-contracts).
#
# Scope: the upstream images named as build stages (`FROM <image> AS <stage>`) in
# deploy/plugins/**/Dockerfile, resolved against each Dockerfile's own ARG
# defaults. The managed toolchain root (deploy/toolchain) is not walked: its two
# Dockerfiles copy no binary out of an upstream build stage. Binaries a plugin downloads as a release tarball are NOT covered —
# their Go version shows up only in the built plugin image's scan.
#
# Usage: report-plugin-go-stdlib.sh [--strict]
#   --strict  exit 1 when any binary was built with a Go older than GO_VERSION
#             (default: report only — a vendor's Go is not something this repo
#             can fix, so the scheduled job surfaces it without going red)
#   REPORT    markdown summary path (optional)
# Needs syft + jq on PATH. Exit 2 when an image cannot be inspected.

set -euo pipefail

[ "${BASH_VERSINFO[0]}" -ge 4 ] || { echo "ERROR: needs bash >= 4 (associative arrays); on macOS run it with Homebrew bash" >&2; exit 2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STRICT=false
[ "${1:-}" = "--strict" ] && STRICT=true
REPORT="${REPORT:-}"

command -v syft >/dev/null 2>&1 || { echo "ERROR: syft not on PATH" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq not on PATH" >&2; exit 2; }

GO_LINE=$(sed -nE 's/^ARG GO_VERSION=([0-9.]+).*/\1/p' "$ROOT/deploy/plugins/_base/_go-base/Dockerfile")
[ -n "$GO_LINE" ] || { echo "ERROR: no ARG GO_VERSION in _go-base/Dockerfile" >&2; exit 2; }

# version_lt A B — true when Go version A sorts strictly before B.
version_lt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$1" ]; }

# Every `FROM <image> AS <stage>` with its Dockerfile's ARG defaults applied.
# Local bases (plugin-*) are built here from pinned sources
# and are not upstream images.
declare -A WHERE=()
while IFS= read -r df; do
  args=$(sed -nE 's/^[[:space:]]*ARG[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)=([^[:space:]]+).*/\1=\2/p' "$df" | tr -d '"')
  while IFS= read -r img; do
    while IFS= read -r pair; do
      [ -n "$pair" ] || continue
      img="${img//\$\{${pair%%=*}\}/${pair#*=}}"
    done <<< "$args"
    case "$img" in *'${'*|plugin-*|scratch) continue ;; esac
    WHERE["$img"]="${WHERE[$img]:-}${WHERE[$img]:+, }${df#"$ROOT"/deploy/plugins/}"
  done < <(sed -nE 's/^FROM[[:space:]]+(--platform=[^[:space:]]+[[:space:]]+)?([^[:space:]]+)[[:space:]]+[Aa][Ss][[:space:]]+[A-Za-z0-9_-]+.*/\2/p' "$df")
done < <(find "$ROOT/deploy/plugins" -name Dockerfile | sort)

[ "${#WHERE[@]}" -gt 0 ] || { echo "ERROR: no upstream build-stage images found" >&2; exit 2; }
echo "Go line: ${GO_LINE} · ${#WHERE[@]} upstream image(s)"

behind=0
failed=0
rows=()
while IFS= read -r img; do
  json=$(mktemp)
  if ! syft scan "registry:${img}" --platform linux/amd64 -o "json=$json" -q 2>/dev/null; then
    echo "  could not inspect $img" >&2
    rows+=("| \`$img\` | — | inspect failed | ${WHERE[$img]} |")
    failed=$((failed + 1)); rm -f "$json"; continue
  fi
  # syft records each Go binary's toolchain as a `stdlib` go-module (version
  # `go1.x.y`); several binaries in one image can disagree, so take the oldest.
  vers=$(jq -r '[.artifacts[] | select(.type == "go-module" and .name == "stdlib") | .version | ltrimstr("go")] | unique | .[]' "$json")
  rm -f "$json"
  if [ -z "$vers" ]; then
    rows+=("| \`$img\` | — | no Go binary | ${WHERE[$img]} |")
    continue
  fi
  oldest=$(printf '%s\n' "$vers" | sort -V | head -1)
  if version_lt "$oldest" "$GO_LINE"; then
    status="BEHIND (< ${GO_LINE})"; behind=$((behind + 1))
    echo "::warning::${img}: Go binaries built with go${oldest} (repo line ${GO_LINE}) — used by ${WHERE[$img]}"
  else
    status="current"
  fi
  rows+=("| \`$img\` | go$(printf '%s\n' "$vers" | paste -sd' ' - | sed 's/ /, go/g') | $status | ${WHERE[$img]} |")
done < <(printf '%s\n' "${!WHERE[@]}" | sort)

table=$(printf '%s\n' "| upstream image | Go toolchain(s) | vs go${GO_LINE} | used by |" "|---|---|---|---|" "${rows[@]}")
echo "$table"
if [ -n "$REPORT" ]; then
  { echo "## Prebuilt Go binaries in plugin images"; echo; echo "$table"; echo
    echo "A BEHIND row means that plugin ships Go standard-library CVEs fixed after that toolchain. Bump the tool's \`ARG *_VERSION\` to a release built with a current Go, or build the tool from source in the plugin."; } > "$REPORT"
fi

[ "$failed" -eq 0 ] || exit 2
if [ "$STRICT" = true ] && [ "$behind" -gt 0 ]; then exit 1; fi
exit 0
