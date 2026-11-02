#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Rescan every image digest the deploy tree pins, for vulnerabilities that have
# a FIX available.
#
# WHY: the release scans an image once, when it is built. Advisories keep being
# published after that, against OS packages and runtimes the image froze — and
# an image nothing changed in is never rebuilt (the release is nx-affected
# only). Third-party images (postgres, redis, grafana, …) are pinned by digest
# too, so they never pick up a fix on their own either. This is the check that
# notices: run nightly by .github/workflows/image-rescan.yml.
#
# Source of truth: deploy/local/docker/docker-compose.yml — every platform
# service AND every third-party image, each pinned `<repo>[:tag]@sha256:<digest>`.
# The k8s trees pin the same digests (sync-image-tags.sh writes all of them in
# one pass, and test/deploy-contracts holds them equal), so scanning compose
# covers every target without scanning the same digest four times.
#
# The CodeBuild bootstrap image (pipeline-bootstrap — the default build image
# of every pipeline step without a plugin image, and the base of cdk-synth) is
# built PER DEPLOYMENT into the platform's own registry, so it is not in
# compose. Pass its digest-pinned ref as BOOTSTRAP_IMAGE_REF
# (`<registry>/library/pipeline-bootstrap@sha256:…`, i.e. the image +
# CODEBUILD_DEFAULT_IMAGE_DIGEST) to scan it with the rest; CI's
# plugin-base-freshness rebuilds and scans the image from source weekly.
#
# Usage: scan-pinned-images.sh [compose-file]
#   BOOTSTRAP_IMAGE_REF  digest-pinned bootstrap image ref to include (optional)
#   FAIL_ON   grype severity threshold (default: high — fixable High/Critical)
#   REPORT    markdown summary path (default: none; CI points it at the job
#             summary and the issue body)
#
# Needs grype on PATH (the workflow installs the SAME pinned version the release
# gate uses). Every image is scanned before the verdict, so one run lists every
# finding. Exit: 0 clean, 1 at least one image has fixable findings at/above
# FAIL_ON, 2 an image could not be scanned (pull/auth/network — a scan that did
# not run is not a pass).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="${1:-$ROOT/deploy/local/docker/docker-compose.yml}"
FAIL_ON="${FAIL_ON:-high}"
case "$FAIL_ON" in negligible|low|medium|high|critical) ;; *) echo "ERROR: FAIL_ON must be negligible|low|medium|high|critical (got '$FAIL_ON')" >&2; exit 2 ;; esac
REPORT="${REPORT:-}"

command -v grype >/dev/null 2>&1 || { echo "ERROR: grype not on PATH" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq not on PATH" >&2; exit 2; }
[ -f "$COMPOSE" ] || { echo "ERROR: $COMPOSE not found" >&2; exit 2; }

# `image: '<ref>'  # comment` → <ref>. Unique, and only digest-pinned refs: a
# tag-only ref has no fixed artifact to rescan (and the hardening contract
# already forbids one in compose).
IMAGES=()
while IFS= read -r _ref; do IMAGES+=("$_ref"); done < <(
  sed -nE "s/^[[:space:]]*image:[[:space:]]*['\"]?([^'\" #]+)['\"]?.*/\1/p" "$COMPOSE" \
    | grep '@sha256:' | sort -u
)
[ "${#IMAGES[@]}" -gt 0 ] || { echo "ERROR: no digest-pinned images found in $COMPOSE" >&2; exit 2; }
if [ -n "${BOOTSTRAP_IMAGE_REF:-}" ]; then
  case "$BOOTSTRAP_IMAGE_REF" in
    *@sha256:*) IMAGES+=("$BOOTSTRAP_IMAGE_REF") ;;
    *) echo "ERROR: BOOTSTRAP_IMAGE_REF must be digest-pinned (<repo>@sha256:<digest>), got '$BOOTSTRAP_IMAGE_REF'" >&2; exit 2 ;;
  esac
fi

echo "Scanning ${#IMAGES[@]} pinned image(s) from ${COMPOSE#"$ROOT"/} (fixable, fail-on ${FAIL_ON})"

vulnerable=()
unscanned=()
rows=()
for ref in "${IMAGES[@]}"; do
  echo "::group::grype $ref"
  out=$(mktemp)
  # `registry:` scans straight from the registry — no docker daemon, no pull into
  # local storage. Severity counts come from the JSON so the summary does not
  # depend on grype's table layout.
  if ! grype "registry:${ref}" --only-fixed -o json --file "$out" -q; then
    echo "  could not scan $ref"
    unscanned+=("$ref")
    rows+=("| \`${ref%%@*}\` | — | — | scan failed |")
    rm -f "$out"; echo "::endgroup::"; continue
  fi
  crit=$(jq '[.matches[] | select(.vulnerability.severity == "Critical")] | length' "$out")
  high=$(jq '[.matches[] | select(.vulnerability.severity == "High")] | length' "$out")
  # The threshold, applied to the JSON with grype's own severity order
  # (negligible < low < medium < high < critical). --only-fixed above already
  # dropped the findings with no fix.
  over=$(jq --arg t "$FAIL_ON" '
    def rank: ({"negligible":1,"low":2,"medium":3,"high":4,"critical":5}[ascii_downcase] // 0);
    [.matches[] | select((.vulnerability.severity | rank) >= ($t | rank))] | length' "$out")
  if [ "$over" -eq 0 ]; then
    verdict=ok
  else
    verdict=FIXABLE
    vulnerable+=("$ref")
  fi
  jq -r '.matches[] | select(.vulnerability.severity == "Critical" or .vulnerability.severity == "High")
    | "  \(.vulnerability.severity)\t\(.vulnerability.id)\t\(.artifact.name) \(.artifact.version) -> \(.vulnerability.fix.versions | join(","))"' "$out" | sort -u
  rows+=("| \`${ref%%@*}\` | ${crit} | ${high} | ${verdict} |")
  rm -f "$out"
  echo "::endgroup::"
done

if [ -n "$REPORT" ]; then
  {
    echo "## Pinned image rescan — fixable vulnerabilities"
    echo
    echo "Source: \`${COMPOSE#"$ROOT"/}\` · grype \`$(grype version -o json 2>/dev/null | jq -r .version)\` · threshold: fixable ${FAIL_ON}+"
    echo
    echo "| image | fixable critical | fixable high | verdict |"
    echo "|---|---|---|---|"
    printf '%s\n' "${rows[@]}"
    echo
    if [ "${#vulnerable[@]}" -gt 0 ]; then
      echo "**Action:** platform images → dispatch the \`release\` workflow with \`rebuild_all: true\`"
      echo "(rebuilds every image on fresh bases, patch-bumps the unchanged ones, re-gates and re-pins deploy/**)."
      echo "Third-party images → bump the pinned digest (Renovate proposes these; see renovate.json)."
    fi
  } > "$REPORT"
fi

if [ "${#unscanned[@]}" -gt 0 ]; then
  echo "ERROR: ${#unscanned[@]} image(s) could not be scanned:" >&2
  printf '  %s\n' "${unscanned[@]}" >&2
  exit 2
fi
if [ "${#vulnerable[@]}" -gt 0 ]; then
  echo "FAIL: ${#vulnerable[@]} image(s) carry fixable ${FAIL_ON}+ vulnerabilities:" >&2
  printf '  %s\n' "${vulnerable[@]}" >&2
  exit 1
fi
echo "OK: no fixable ${FAIL_ON}+ vulnerabilities in ${#IMAGES[@]} image(s)."
