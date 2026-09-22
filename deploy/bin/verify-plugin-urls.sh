#!/usr/bin/env bash
set -euo pipefail

# Verify all download URLs in plugin Dockerfiles are reachable.
# Catches stale versions, moved repos, and renamed assets before they break builds.
#
# Usage:
#   ./verify-plugin-urls.sh                    # check all plugins
#   ./verify-plugin-urls.sh security/trivy     # check a specific plugin

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

PLUGINS_DIR="$DEPLOY_DIR/plugins"
SPECIFIC_PLUGIN="${1:-}"
# CHECK_TIMEOUT/PASSED/FAILED/SKIPPED/ERRORS are read & mutated by common.sh's
# check_url/check_docker_image/print_results (sourced-globals contract), so the
# SC2034 "appears unused" warnings here are false positives.
# shellcheck disable=SC2034
CHECK_TIMEOUT=15
# shellcheck disable=SC2034
PASSED=0
# shellcheck disable=SC2034
FAILED=0
# shellcheck disable=SC2034
SKIPPED=0
# shellcheck disable=SC2034
ERRORS=()

# Dockerfiles actually opened. A plugin with no downloads at all (e.g. one that
# only inherits a family base) legitimately contributes 0 URLs, so "URLs checked"
# alone can't tell "nothing to check" from "the walk found nothing".
DOCKERFILES_SEEN=0

verify_dockerfile() {
  local dockerfile="$1"
  local rel_path="${dockerfile#"$PLUGINS_DIR"/}"
  DOCKERFILES_SEEN=$((DOCKERFILES_SEEN + 1))

  log_info "$rel_path"

  # Check download URLs.
  #
  # Downloads are `fetch-verified <url> <sha256> …` / `fetch-apt-key <url> …`
  # (the base images' checksum-verifying helpers), `ADD --checksum=… <url>`, or
  # an occasional curl/wget. Versions are pinned as `ARG NAME=value` and the URL
  # spells them `${NAME}`, so this resolves each URL against the Dockerfile's
  # own ARG defaults (plus the amd64 build platform) before checking it. A URL
  # that still holds a variable after that (one computed in a RUN step, e.g. a
  # per-arch asset name) can't be checked statically and is counted as skipped.
  # Apt repository roots (`deb https://…` lines, which share a RUN with the key
  # download) and hosts where a HEAD check means nothing (package registries)
  # are filtered out.
  local flat
  # Join line continuations and drop comments, so a URL on the line after
  # `fetch-verified \` is still attributed to it.
  flat=$(awk '/^[[:space:]]*#/ { next }
    { if (sub(/\\$/, "")) { buf = buf $0 " "; next } print buf $0; buf = "" }
    END { if (buf != "") print buf }' "$dockerfile")

  # `NAME=value` pairs to substitute: the Dockerfile's ARG defaults, the build
  # platform BuildKit would supply, and the literal assignments in a RUN step's
  # `amd64)` case branch (per-arch asset names). The catalog is checked for amd64.
  local args
  args=$(printf '%s\n' 'TARGETARCH=amd64' 'TARGETOS=linux' 'TARGETPLATFORM=linux/amd64' 'BUILDARCH=amd64'
    printf '%s\n' "$flat" | sed -nE 's/^[[:space:]]*ARG[[:space:]]+([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*).*/\1/p' | tr -d '"'
    printf '%s\n' "$flat" | grep -oE '(amd64|x86_64)\)[^)]*;;' \
      | tr ';' '\n' | sed -nE 's/^[[:space:]]*(amd64\)|x86_64\))?[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9._-]+)[[:space:]]*$/\2/p'
    true)  # a Dockerfile with no ARG or case branch matches nothing — not an error

  local urls url resolved pair
  # shellcheck disable=SC2016 # the pattern matches a literal `${VAR}` in the URL
  urls=$(printf '%s\n' "$flat" \
    | grep -E '(curl|wget|fetch-verified|fetch-apt-key)[[:space:]]|^[[:space:]]*ADD[[:space:]]' \
    | sed -E 's#deb[[:space:]]+(\[[^]]*\][[:space:]]+)?https://[^[:space:]"]+##g' \
    | grep -oE 'https://[][a-zA-Z0-9._/~?=&%+:@${}-]+' \
    | grep -vE '(deb\.nodesource\.com|launchpad\.net|packagecloud\.io|registry\.npmjs\.org|repo\.maven\.apache\.org/maven2)' \
    | sort -u || true)
  while IFS= read -r url; do
    [ -z "$url" ] && continue
    resolved="$url"
    while IFS= read -r pair; do
      [ -z "$pair" ] && continue
      resolved="${resolved//\$\{${pair%%=*}\}/${pair#*=}}"
    done <<< "$args"
    case "$resolved" in
      *'$'*)
        echo -e "    ${YELLOW}SKIP${NC} $rel_path — runtime-computed URL: $url"
        SKIPPED=$((SKIPPED + 1))
        continue
        ;;
    esac
    check_url "$resolved" "$rel_path — $resolved"
  done <<< "$urls"

  # Check COPY --from Docker image references
  local images
  images=$(grep -E 'COPY[[:space:]]+--from=' "$dockerfile" 2>/dev/null \
    | sed -E 's/.*COPY[[:space:]]+--from=([^ ]+).*/\1/' || true)
  while IFS= read -r image; do
    [ -z "$image" ] && continue
    # Skip named build stages (no / in the name)
    if echo "$image" | grep -q '/'; then
      check_docker_image "$image" "$rel_path"
    fi
  done <<< "$images"
}

# ── Main ──

echo -e "${BLUE}Plugin URL Verification${NC}"
echo "========================"

if [ -n "$SPECIFIC_PLUGIN" ]; then
  dockerfile="$PLUGINS_DIR/$SPECIFIC_PLUGIN/Dockerfile"
  if [ -f "$dockerfile" ]; then
    verify_dockerfile "$dockerfile"
  else
    echo -e "${RED}Not found: $dockerfile${NC}"
    exit 1
  fi
else
  for category_dir in "$PLUGINS_DIR"/*/; do
    category_dir="${category_dir%/}"
    [ -d "$category_dir" ] || continue
    for plugin_dir in "${category_dir%/}"/*/; do
      [ -d "$plugin_dir" ] || continue
      dockerfile="${plugin_dir%/}/Dockerfile"
      [ -f "$dockerfile" ] && verify_dockerfile "$dockerfile"
    done
  done
fi

print_results

# Checking nothing is not a pass. With a missing/empty plugins tree the walk
# above opens no Dockerfile at all, and print_errors_and_exit would then print
# "All URLs verified!" and exit 0 on an empty ERRORS[] — a green CI run
# (.github/workflows/plugin-urls.yml) that verified zero URLs.
if [ "$DOCKERFILES_SEEN" -eq 0 ]; then
  echo -e "${RED}ERROR: no plugin Dockerfiles were found under $PLUGINS_DIR — refusing to report success.${NC}" >&2
  exit 1
fi
# Whole-catalog run: the catalog definitely contains downloads, so extracting
# zero URLs from all of it means the URL parsing broke, not that there is
# nothing to check. (A single-plugin run can legitimately yield zero — plenty of
# plugins only inherit a family base.)
if [ -z "$SPECIFIC_PLUGIN" ] && [ "$((PASSED + FAILED + SKIPPED))" -eq 0 ]; then
  echo -e "${RED}ERROR: walked ${DOCKERFILES_SEEN} Dockerfile(s) but extracted no download URLs — the URL parsing is broken.${NC}" >&2
  exit 1
fi

print_errors_and_exit "All URLs verified!"
