#!/usr/bin/env bash
set -euo pipefail

# Verify every `ghcr.io/<owner>/<svc>:<version>` referenced under deploy/** is
# actually PUBLICLY pullable from GHCR. Run in CI AFTER the image push +
# `sync-image-tags.sh` and BEFORE committing the synced manifests — it fails the
# release if a referenced tag is missing (the "sync-ahead-of-publish" gap that left
# compliance:3.4.78 / the ai-core / pipeline-events versions dangling).
#
# The contract being checked is ANONYMOUS pullability, not mere existence: every
# deploy path (docker-compose, the k8s manifests, both .env.example files) states
# the ghcr.io/<owner>/* images are public and pulls them with no registry login.
# So the pull token is requested ANONYMOUSLY and that is what decides the verdict.
# A token in GHCR_TOKEN / GITHUB_TOKEN is used only to CLASSIFY a failure — to say
# "published but private" instead of "absent" — never to make a private image pass.
# (Authenticating the probe itself is what would let a private package green the
# release and then 401 for every real user.)
#
# Usage:
#   deploy/bin/verify-image-tags.sh [owner]        # default owner: mwashburn160
#
# Exit codes — THE convention shared by every deploy/bin/verify-*.sh:
#   0  verified: everything checked passed
#   1  FAILED: a real verdict — something is missing, unsigned or unreachable
#   2  nothing to verify (no refs / no files). Non-zero on purpose: a gate must
#      not go green having checked nothing.
#   3  could not verify — an infra error, never a verdict: a missing tool, a bad
#      argument, or the registry/network answering 5xx / rate-limiting.
# Here: 1 = a referenced tag is missing or not public; 3 = could not reach GHCR.

OWNER="${1:-mwashburn160}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Optional token — ONLY used to tell "private" apart from "never published" when
# the anonymous probe has already failed. It cannot turn a failure into a pass.
TOKEN="${GHCR_TOKEN:-${GITHUB_TOKEN:-}}"

# Request a pull token for $1. Anonymous unless $2 is non-empty (classify mode).
# Emits "<http-code> <token>" on ONE line — a command substitution runs in a
# subshell, so the status cannot come back via a global.
ghcr_token() {
  local repo="$1" tok_auth="${2:-}" body code tok auth=()
  [ -n "$tok_auth" ] && auth=(-u "${GHCR_USER:-${GITHUB_ACTOR:-ghcr}}:${tok_auth}")
  body="$(curl -sS ${auth[@]+"${auth[@]}"} -w $'\n%{http_code}' --max-time 30 \
    "https://ghcr.io/token?scope=repository:${OWNER}/${repo}:pull" 2>/dev/null || printf '\n000')"
  code="${body##*$'\n'}"
  # `|| true`: no match is a normal outcome here (error bodies carry no token),
  # not a script-aborting failure under `set -e -o pipefail`.
  tok="$(printf '%s' "${body%$'\n'*}" | grep -o '"token":"[^"]*"' | cut -d'"' -f4 || true)"
  printf '%s %s' "${code:-000}" "$tok"
}

# HTTP status of the manifest for <repo>:<tag> using pull token <tok>.
manifest_code() {
  local out
  out="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
    -H "Authorization: Bearer $3" \
    -H 'Accept: application/vnd.oci.image.index.v1+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/${OWNER}/$1/manifests/$2" 2>/dev/null || true)"
  printf '%s' "${out:-000}"
}

# Distinct semver-pinned ghcr refs across compose / k8s / CloudFormation under deploy/.
# while-read, not `mapfile` (bash 4+), so this also runs on macOS bash 3.2.
REFS=()
while IFS= read -r _ref; do REFS+=("$_ref"); done < <(
  grep -rhoE "ghcr\.io/${OWNER}/[a-z0-9-]+:[0-9]+\.[0-9]+\.[0-9]+" "$ROOT/deploy" 2>/dev/null | sort -u
)

if [ "${#REFS[@]}" -eq 0 ]; then
  echo "No ghcr.io/${OWNER}/*:<version> references found under deploy/ — nothing to verify."
  exit 2
fi

echo "Verifying ${#REFS[@]} deploy image tag(s) are publicly pullable from ghcr.io …"
MISSING=()
for ref in "${REFS[@]}"; do
  repo="${ref#ghcr.io/${OWNER}/}"; tag="${repo##*:}"; repo="${repo%%:*}"

  read -r tok_code tok <<<"$(ghcr_token "$repo")"
  if [ "$tok_code" = "401" ] || [ "$tok_code" = "403" ]; then
    # Verdict, NOT an infra error: the package is not anonymously readable.
    # Use the token (if any) only to make the message accurate.
    reason="not publicly pullable (package is private)"
    if [ -n "$TOKEN" ]; then
      read -r _acode atok <<<"$(ghcr_token "$repo" "$TOKEN")"
      if [ -n "$atok" ] && [ "$(manifest_code "$repo" "$tag" "$atok")" != "200" ]; then
        reason="not publicly pullable AND tag absent even with credentials"
      fi
    fi
    echo "  PRIVATE ${ref}  (${reason})"
    MISSING+=("${ref}  — ${reason}")
    continue
  fi
  if [ -z "$tok" ]; then
    echo "ERROR: could not reach the GHCR token endpoint for ${OWNER}/${repo} (HTTP ${tok_code:-000}) — network/rate-limit, not a verdict." >&2
    exit 3
  fi

  code="$(manifest_code "$repo" "$tag" "$tok")"
  case "$code" in
    200) echo "  ok      ${ref}" ;;
    404) echo "  MISSING ${ref}  (tag not published)"; MISSING+=("${ref}  — tag not published") ;;
    000|5??|429)
      echo "ERROR: GHCR manifest lookup for ${ref} failed with HTTP ${code} — network/rate-limit, not a verdict." >&2
      exit 3 ;;
    *) echo "  MISSING ${ref}  (HTTP ${code})"; MISSING+=("${ref}  — HTTP ${code}") ;;
  esac
done

if [ "${#MISSING[@]}" -gt 0 ]; then
  {
    echo
    echo "ERROR: ${#MISSING[@]} image tag(s) referenced under deploy/ are NOT publicly pullable from ghcr.io:"
    printf '  - %s\n' "${MISSING[@]}"
    echo "Publish the missing image(s) (and set the GHCR package visibility to Public),"
    echo "or pin the manifest(s) to a published tag, before releasing."
  } >&2
  exit 1
fi

echo
echo "All ${#REFS[@]} deploy image tags are publicly pullable from ghcr.io ✓"
