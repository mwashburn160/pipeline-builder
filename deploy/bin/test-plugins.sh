#!/usr/bin/env bash
set -euo pipefail

# Validate all plugins: spec schema + catalog metadata, Dockerfile structure and
# supply-chain hygiene (non-root final USER, no pipe-to-shell installers, every
# download through fetch-verified), optional Docker build + smoke run.
#
# Usage:
#   ./test-plugins.sh                       # test all plugins
#   ./test-plugins.sh language/java         # test a specific plugin
#   ./test-plugins.sh --spec-only           # only validate specs (no Docker checks)
#   ./test-plugins.sh --build               # build Docker images (slow)
#   PLUGINS_DIR=/tmp/p ./test-plugins.sh security/my-scan  # a tree outside the repo

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

# PLUGINS_DIR overrides the catalog root (a `<category>/<plugin>` tree), e.g. to
# check a scaffold from `pipeline-manager plugin new` outside the repo.
PLUGINS_DIR="${PLUGINS_DIR:-$DEPLOY_DIR/plugins}"
SPEC_ONLY=false
BUILD_IMAGES=false
SPECIFIC_PLUGIN=""
# PASSED/FAILED/SKIPPED/ERRORS are read & mutated by common.sh's
# log_*/print_results/print_errors_and_exit (sourced-globals contract).
# shellcheck disable=SC2034
PASSED=0
# shellcheck disable=SC2034
FAILED=0
# shellcheck disable=SC2034
SKIPPED=0
# shellcheck disable=SC2034
ERRORS=()

# ---- Argument parsing ----

while [ $# -gt 0 ]; do
  case "$1" in
    --spec-only) SPEC_ONLY=true; shift ;;
    --build)     BUILD_IMAGES=true; shift ;;
    --help|-h)
      echo "Usage: $0 [options] [category/plugin]"
      echo ""
      echo "Options:"
      echo "  --spec-only  Only validate specs (no Docker checks)"
      echo "  --build      Build Docker images (slow, requires Docker)"
      echo "  category/plugin  Test a specific plugin (e.g., language/java)"
      exit 0
      ;;
    *) SPECIFIC_PLUGIN="$1"; shift ;;
  esac
done

# ---- Validation constants ----

REQUIRED_FIELDS=("name" "description" "keywords" "category" "version" "pluginType" "computeType")
CODEBUILD_FIELDS=("primaryOutputDirectory" "dockerfile" "installCommands" "commands")
V2_FIELDS=("timeout" "failureBehavior" "secrets")
# Enums mirror the Zod schema in packages/api-core/src/validation/plugin-spec-schema.ts exactly —
# a value the upload API rejects must fail here first. Every list and limit
# below is checked against api-core by
# packages/pipeline-manager/test/test-plugins-constants.test.ts (drift guard).
VALID_COMPUTE_TYPES=("SMALL" "MEDIUM" "LARGE" "X2_LARGE")
VALID_PLUGIN_TYPES=("CodeBuildStep" "ShellStep" "ManualApprovalStep")
VALID_FAILURE_BEHAVIORS=("fail" "warn" "ignore")
VALID_CATEGORIES=("language" "security" "quality" "monitoring" "artifact" "deploy" "infrastructure" "testing" "notification" "ai")
VALID_BUILD_TYPES=("build_image" "prebuilt" "metadata_only")

# Catalog documentation + trust metadata (docs/plans/plugin-ecosystem.md W0.2).
# Mirrors packages/api-core/src/validation/plugin-spec-schema.ts and plugin-catalog-metadata.ts — keep them in sync.
README_MAX_BYTES=$((64 * 1024))
CHANGELOG_MAX_BYTES=$((32 * 1024))
EGRESS_MAX_HOSTS=50
SPDX_LICENSE_IDS=(
  "Apache-2.0" "MIT" "MIT-0" "ISC" "0BSD" "Unlicense" "CC0-1.0" "Zlib" "BSL-1.0"
  "BSD-2-Clause" "BSD-3-Clause"
  "MPL-2.0" "EPL-1.0" "EPL-2.0"
  "LGPL-2.1-only" "LGPL-2.1-or-later" "LGPL-3.0-only" "LGPL-3.0-or-later"
  "GPL-2.0-only" "GPL-2.0-or-later" "GPL-3.0-only" "GPL-3.0-or-later"
  "AGPL-3.0-only" "AGPL-3.0-or-later"
  "CC-BY-4.0" "CC-BY-SA-4.0" "Python-2.0" "PostgreSQL" "Artistic-2.0"
  "BUSL-1.1" "Elastic-2.0" "SSPL-1.0"
  "LicenseRef-Proprietary"
)
URL_SHORTENER_HOSTS=("bit.ly" "t.co" "tinyurl.com" "goo.gl" "ow.ly" "is.gd" "buff.ly" "rebrand.ly" "cutt.ly" "shorturl.at")
ICON_KEY_RE='^[a-z0-9-]+$'
# Bare DNS hostname, optionally one leading `*.` label; lowercase only (the TS
# regex has no `i` flag). No scheme, port, path, userinfo or IP literal.
EGRESS_HOST_RE='^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$'

# Literal membership test. Replaces `[[ " ${arr[*]} " =~ " $v " ]]`, whose
# quoted RHS is still a regex — a value with a metachar (e.g. SM.LL) would
# wrongly match SMALL (SC2076).
_in_list() {
  local _needle="$1"; shift
  local _x
  for _x in "$@"; do [ "$_x" = "$_needle" ] && return 0; done
  return 1
}

# Lowercase via tr — keeps the script runnable on macOS's stock bash 3.2 (no ${v,,}).
_lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# _yq <expr> <file> — mikefarah yq, empty string (not an abort under set -e)
# when the expression errors.
_yq() { yq eval "$1" "$2" 2>/dev/null || true; }

# _project_url_problem <url> — why <url> is not an acceptable homepageUrl /
# sourceUrl, or nothing when it is. Mirrors projectUrlProblem() in
# plugin-catalog-metadata.ts: absolute https URL, no embedded credentials, host (or any
# parent domain of it) not a known URL shortener.
_project_url_problem() {
  local _url="$1" _rest _auth _host _label _suffix
  if [ "${#_url}" -gt 2048 ]; then echo "must be at most 2048 characters"; return; fi
  case "$(_lower "${_url%%://*}")://" in
    https://) ;;
    *://) if [[ "$_url" == *://* ]]; then echo "must use https"; else echo "must be an absolute URL"; fi; return ;;
  esac
  _rest="${_url#*://}"
  _auth="${_rest%%[/?#]*}"
  if [ -z "$_auth" ]; then echo "must be an absolute URL"; return; fi
  if [[ "$_auth" == *@* ]]; then echo "must not embed credentials"; return; fi
  _host="$(_lower "${_auth%%:*}")"; _host="${_host%.}"
  if [ -z "$_host" ]; then echo "must be an absolute URL"; return; fi
  # The host itself and every parent domain (a.b.bit.ly → b.bit.ly → bit.ly).
  _suffix="$_host"
  while [[ "$_suffix" == *.* ]]; do
    for _label in "${URL_SHORTENER_HOSTS[@]}"; do
      if [ "$_suffix" = "$_label" ]; then echo "must not use a URL shortener (${_host})"; return; fi
    done
    _suffix="${_suffix#*.}"
  done
}

# validate_metadata <specfile> <plugin_dir> <fqn> — the documentation + trust
# metadata the upload API enforces (api-core plugin-spec-schema.ts + plugin-catalog-metadata.ts). Every
# field is optional there; each is validated only when present. The icon KEY
# format is checked here; whether the icon file exists is not.
validate_metadata() {
  local specfile="$1" plugin_dir="$2" fqn="$3"
  local _t _v _n _h _bad

  # Every probe below goes through _yq, which maps a yq error to "" (field
  # absent). Prove yq can actually read this spec first, so a broken yq (or a
  # dockerized wrapper that can't see the path) fails loudly instead of
  # silently skipping every metadata check.
  if ! yq eval '.' "$specfile" >/dev/null 2>&1; then
    log_fail "plugin-spec.yaml is not readable by yq (invalid YAML or unusable yq)" "$fqn"
    return
  fi

  # license — SPDX id from the allowlist (case-sensitive).
  if [ "$(_yq 'has("license")' "$specfile")" = "true" ]; then
    _v="$(_yq '.license' "$specfile")"
    if [ "$(_yq '.license | type' "$specfile")" = "!!str" ] && _in_list "$_v" "${SPDX_LICENSE_IDS[@]}"; then
      log_pass "Valid license: ${_v}"
    else
      log_fail "Invalid license: '${_v}' (must be a supported SPDX id, e.g. Apache-2.0, MIT)" "$fqn"
    fi
  fi

  # homepageUrl / sourceUrl — https, no credentials, no shortener.
  local _field _problem
  for _field in homepageUrl sourceUrl; do
    [ "$(_yq "has(\"${_field}\")" "$specfile")" = "true" ] || continue
    _v="$(_yq ".${_field}" "$specfile")"
    if [ "$(_yq ".${_field} | type" "$specfile")" != "!!str" ]; then
      log_fail "Invalid ${_field}: must be a string" "$fqn"; continue
    fi
    _problem="$(_project_url_problem "$_v")"
    if [ -n "$_problem" ]; then
      log_fail "Invalid ${_field}: ${_problem} (${_v})" "$fqn"
    else
      log_pass "Valid ${_field}"
    fi
  done

  # changelog — string, ≤ CHANGELOG_MAX_BYTES (UTF-8 bytes).
  if [ "$(_yq 'has("changelog")' "$specfile")" = "true" ]; then
    if [ "$(_yq '.changelog | type' "$specfile")" != "!!str" ]; then
      log_fail "Invalid changelog: must be a string" "$fqn"
    else
      _n=$(_yq '.changelog' "$specfile" | wc -c | tr -d ' ')
      if [ "$_n" -gt "$CHANGELOG_MAX_BYTES" ]; then
        log_fail "changelog is ${_n} bytes (max ${CHANGELOG_MAX_BYTES})" "$fqn"
      else
        log_pass "changelog within ${CHANGELOG_MAX_BYTES} bytes"
      fi
    fi
  fi

  # README.md (plugin dir = zip root) — ≤ README_MAX_BYTES.
  if [ -f "${plugin_dir}/README.md" ]; then
    _n=$(wc -c < "${plugin_dir}/README.md" | tr -d ' ')
    if [ "$_n" -gt "$README_MAX_BYTES" ]; then
      log_fail "README.md is ${_n} bytes (max ${README_MAX_BYTES})" "$fqn"
    else
      log_pass "README.md within ${README_MAX_BYTES} bytes"
    fi
  fi

  # icon — a key string, or { key, badge? } with nothing else; keys ^[a-z0-9-]+$ (≤ 64).
  if [ "$(_yq 'has("icon")' "$specfile")" = "true" ]; then
    _t="$(_yq '.icon | type' "$specfile")"
    _bad=""
    case "$_t" in
      '!!str')
        _v="$(_yq '.icon' "$specfile")"
        { [ "${#_v}" -le 64 ] && [[ "$_v" =~ $ICON_KEY_RE ]]; } || _bad="icon key '${_v}' must match ${ICON_KEY_RE} (≤ 64 chars)"
        ;;
      '!!map')
        for _h in $(_yq '.icon | keys | .[]' "$specfile"); do
          case "$_h" in key|badge) ;; *) _bad="icon has unknown field '${_h}' (allowed: key, badge)" ;; esac
        done
        if [ -z "$_bad" ]; then
          for _field in key badge; do
            [ "$(_yq ".icon | has(\"${_field}\")" "$specfile")" = "true" ] || { [ "$_field" = key ] && _bad="icon.key is required"; continue; }
            _v="$(_yq ".icon.${_field}" "$specfile")"
            { [ "$(_yq ".icon.${_field} | type" "$specfile")" = "!!str" ] && [ "${#_v}" -le 64 ] && [[ "$_v" =~ $ICON_KEY_RE ]]; } \
              || _bad="icon.${_field} '${_v}' must match ${ICON_KEY_RE} (≤ 64 chars)"
          done
        fi
        ;;
      *) _bad="icon must be a key string or { key, badge }" ;;
    esac
    if [ -n "$_bad" ]; then log_fail "Invalid icon: ${_bad}" "$fqn"; else log_pass "Valid icon key"; fi
  fi

  # network — { egress: [bare hostnames] } only; ≤ EGRESS_MAX_HOSTS entries.
  if [ "$(_yq 'has("network")' "$specfile")" = "true" ]; then
    _bad=""
    if [ "$(_yq '.network | type' "$specfile")" != "!!map" ]; then
      _bad="network must be a mapping"
    else
      for _h in $(_yq '.network | keys | .[]' "$specfile"); do
        [ "$_h" = "egress" ] || _bad="network has unknown field '${_h}' (allowed: egress)"
      done
      if [ -z "$_bad" ] && [ "$(_yq '.network | has("egress")' "$specfile")" = "true" ]; then
        if [ "$(_yq '.network.egress | type' "$specfile")" != "!!seq" ]; then
          _bad="network.egress must be a list"
        else
          _n="$(_yq '.network.egress | length' "$specfile")"
          if [ "${_n:-0}" -gt "$EGRESS_MAX_HOSTS" ]; then
            _bad="network.egress has ${_n} hosts (max ${EGRESS_MAX_HOSTS})"
          elif [ "$(_yq '[.network.egress[] | select(type != "!!str")] | length' "$specfile")" != "0" ]; then
            _bad="network.egress entries must be strings"
          else
            for _h in $(_yq '.network.egress[]' "$specfile"); do
              if [ "${#_h}" -gt 253 ] || ! [[ "$_h" =~ $EGRESS_HOST_RE ]]; then
                _bad="network.egress '${_h}' must be a bare hostname (no scheme, port or path; one leading *. allowed)"
                break
              fi
            done
          fi
        fi
      fi
    fi
    if [ -n "$_bad" ]; then log_fail "Invalid ${_bad}" "$fqn"; else log_pass "Valid network.egress"; fi
  fi
}

# ---- Dockerfile hygiene helpers ----

# _dockerfile_instructions <Dockerfile> — one logical instruction per line:
# comment lines dropped (Docker strips them even inside a `\` continuation)
# and continuations joined, so the checks below see what BuildKit executes.
_dockerfile_instructions() {
  awk '
    /^[[:space:]]*#/ { next }
    {
      line = $0
      if (line ~ /\\[[:space:]]*$/) { sub(/\\[[:space:]]*$/, "", line); buf = buf line " "; next }
      buf = buf line
      if (buf ~ /[^[:space:]]/) print buf
      buf = ""
    }
    END { if (buf ~ /[^[:space:]]/) print buf }
  ' "$1"
}

# _final_user <Dockerfile> — the last USER in the FINAL build stage (empty when
# that stage sets none and would silently inherit its base's).
_final_user() {
  _dockerfile_instructions "$1" | awk '
    toupper($1) == "FROM" { user = ""; next }
    toupper($1) == "USER" { user = $2 }
    END { print user }
  '
}

# _pipe_installers <Dockerfile> — RUN instructions that pipe into a shell
# (`curl … | bash`, `wget -O- … | sh`): unpinned remote code executed as-is.
_pipe_installers() {
  _dockerfile_instructions "$1" | awk '
    toupper($1) == "RUN" && $0 ~ /(^|[^|])\|[[:space:]]*(sudo[[:space:]]+)?(\/usr)?(\/bin\/)?(ba|da|z|k)?sh([[:space:]]|$)/ { print }
  '
}

# _raw_downloads <Dockerfile> — curl/wget DOWNLOADS in RUN instructions (the
# command carries a URL, a $-expanded URL, or an output flag). Every download
# must go through `fetch-verified <url> <digest> <dest>` (or `fetch-apt-key`
# for an apt signing key); a bare `curl --version` is not a download. Also
# flags `ADD <url>` without `--checksum=`.
_raw_downloads() {
  _dockerfile_instructions "$1" | awk '
    toupper($1) == "ADD" && $0 ~ /https?:\/\// && $0 !~ /--checksum=/ { print "ADD " $0; next }
    toupper($1) != "RUN" { next }
    {
      s = $0
      sub(/^[[:space:]]*[Rr][Uu][Nn][[:space:]]+/, "", s)
      n = split(s, parts, /&&|\|\||;|\||\$\(|`|\(|\{/)
      for (i = 1; i <= n; i++) {
        c = parts[i]
        while (1) {
          sub(/^[[:space:]]+/, "", c)
          if (match(c, /^(if|then|do|else|elif|while|until|!|sudo|exec|command|time|--[a-z-]+(=[^[:space:]]*)?|[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*)[[:space:]]+/)) {
            c = substr(c, RLENGTH + 1)
          } else break
        }
        if (c ~ /^(curl|wget)([[:space:]]|$)/ && (c ~ /:\/\// || c ~ /\$/ || c ~ /[[:space:]](-o|-O|--output|--output-document)([[:space:]=]|$)/)) {
          print c
        }
      }
    }
  '
}

# ---- Validation functions ----

validate_spec() {
  local specfile="$1"
  local plugin_dir="$2"
  local plugin_name category
  plugin_name="$(basename "$plugin_dir")"
  category="$(basename "$(dirname "$plugin_dir")")"
  local fqn="${category}/${plugin_name}"
  local all_pass=true

  # Required fields
  for field in "${REQUIRED_FIELDS[@]}"; do
    if ! grep -q "^${field}:" "$specfile" 2>/dev/null; then
      log_fail "Missing required field: ${field}" "$fqn"
      all_pass=false
    fi
  done

  # CodeBuild-specific fields only required for CodeBuildStep plugins
  local plugin_type
  plugin_type=$(get_spec_field pluginType "$specfile")
  if [ "$plugin_type" = "CodeBuildStep" ]; then
    for field in "${CODEBUILD_FIELDS[@]}"; do
      if ! grep -q "^${field}:" "$specfile" 2>/dev/null; then
        log_fail "Missing CodeBuild field: ${field}" "$fqn"
        all_pass=false
      fi
    done
  fi

  # V2 fields
  for field in "${V2_FIELDS[@]}"; do
    if ! grep -q "^${field}:" "$specfile" 2>/dev/null; then
      log_fail "Missing v2 field: ${field}" "$fqn"
      all_pass=false
    fi
  done

  # Name matches directory
  local spec_name
  spec_name=$(get_spec_field name "$specfile")
  if [ "$spec_name" != "$plugin_name" ]; then
    log_fail "Name mismatch: spec='${spec_name}' dir='${plugin_name}'" "$fqn"
    all_pass=false
  else
    log_pass "Name matches directory"
  fi

  # Valid pluginType
  if ! _in_list "$plugin_type" "${VALID_PLUGIN_TYPES[@]}"; then
    log_fail "Invalid pluginType: ${plugin_type}" "$fqn"
    all_pass=false
  else
    log_pass "Valid pluginType: ${plugin_type}"
  fi

  # Valid computeType
  local compute_type
  compute_type=$(get_spec_field computeType "$specfile")
  if ! _in_list "$compute_type" "${VALID_COMPUTE_TYPES[@]}"; then
    log_fail "Invalid computeType: ${compute_type}" "$fqn"
    all_pass=false
  else
    log_pass "Valid computeType: ${compute_type}"
  fi

  # Valid semver
  local version
  version=$(get_spec_field version "$specfile")
  if ! echo "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    log_fail "Invalid version format: ${version} (expected semver)" "$fqn"
    all_pass=false
  else
    log_pass "Valid version: ${version}"
  fi

  # Optional: failureBehavior
  if grep -q "^failureBehavior:" "$specfile" 2>/dev/null; then
    local fb
    fb=$(get_spec_field failureBehavior "$specfile")
    if ! _in_list "$fb" "${VALID_FAILURE_BEHAVIORS[@]}"; then
      log_fail "Invalid failureBehavior: ${fb} (expected: ${VALID_FAILURE_BEHAVIORS[*]})" "$fqn"
      all_pass=false
    else
      log_pass "Valid failureBehavior: ${fb}"
    fi
  fi

  # Optional: timeout
  if grep -q "^timeout:" "$specfile" 2>/dev/null; then
    local timeout_val
    timeout_val=$(get_spec_field timeout "$specfile")
    if ! echo "$timeout_val" | grep -qE '^[0-9]+$'; then
      log_fail "Invalid timeout: ${timeout_val} (expected integer minutes)" "$fqn"
      all_pass=false
    else
      log_pass "Valid timeout: ${timeout_val}m"
    fi
  fi

  # Valid category
  if grep -q "^category:" "$specfile" 2>/dev/null; then
    local cat_val
    cat_val=$(get_spec_field category "$specfile")
    if ! _in_list "$cat_val" "${VALID_CATEGORIES[@]}"; then
      log_fail "Invalid category: ${cat_val} (expected: ${VALID_CATEGORIES[*]})" "$fqn"
      all_pass=false
    elif [ "$cat_val" != "$category" ]; then
      log_fail "Category mismatch: spec='${cat_val}' directory='${category}'" "$fqn"
      all_pass=false
    else
      log_pass "Valid category: ${cat_val}"
    fi
  fi

  # Description not empty
  local desc
  desc=$(get_spec_field description "$specfile")
  if [ -z "$desc" ]; then
    log_fail "Empty description" "$fqn"
    all_pass=false
  else
    log_pass "Has description"
  fi

  # Keywords not empty
  if grep -q "^keywords:" "$specfile" 2>/dev/null; then
    local keyword_count
    # `grep -c … || true`: under `set -euo pipefail`, an inner grep that matches
    # nothing (inline `keywords: []` or different indentation) exits 1 and the
    # bare assignment would abort the WHOLE test run mid-plugin instead of just
    # failing this one check.
    keyword_count=$(grep -A 20 "^keywords:" "$specfile" | grep -c "^  - " || true)
    keyword_count=${keyword_count:-0}
    if [ "$keyword_count" -eq 0 ]; then
      log_fail "Empty keywords list" "$fqn"
      all_pass=false
    else
      log_pass "Has ${keyword_count} keywords"
    fi
  fi

  validate_metadata "$specfile" "$plugin_dir" "$fqn"

  # No runtime tool downloads. A spec that fetches a release archive at build
  # time runs an unpinned, unverified binary — exactly what the Dockerfile's
  # fetch-verified rule forbids. Tools are baked into the image; a version the
  # image doesn't carry must fail (see "Version switches" in plugins/README.md).
  # API calls (`curl -s … -w "%{http_code}"`) don't match: only release-archive
  # and GitHub-release URLs do.
  local downloads
  downloads=$(grep -nE '(curl|wget)[[:space:]].*https?://[^[:space:]"]*(releases/download/|\.tar\.gz|\.tgz|\.tar\.xz|\.zip)' "$specfile" || true)
  if [ -n "$downloads" ]; then
    log_fail "Downloads a tool at runtime (bake it into the image via fetch-verified): $(echo "$downloads" | head -1 | cut -c1-160)" "$fqn"
    all_pass=false
  else
    log_pass "No runtime tool downloads"
  fi

  if $all_pass; then log_pass "Spec schema valid"; fi
}

validate_dockerfile() {
  local dockerfile="$1"
  local plugin_dir="$2"
  local specfile="$3"
  local fqn
  fqn="$(basename "$(dirname "$plugin_dir")")/$(basename "$plugin_dir")"

  if ! grep -q "^FROM " "$dockerfile" 2>/dev/null; then
    log_fail "Missing FROM instruction" "$fqn"
    return
  fi
  log_pass "Has FROM instruction"

  if ! grep -q "^WORKDIR " "$dockerfile" 2>/dev/null; then
    log_fail "Missing WORKDIR instruction" "$fqn"
  else
    log_pass "Has WORKDIR"
  fi

  if grep -qE "^(ENV|ARG)\s+(.*TOKEN|.*SECRET|.*PASSWORD|.*API_KEY|.*PRIVATE_KEY)" "$dockerfile" 2>/dev/null; then
    log_fail "Potential secret in ENV/ARG instruction" "$fqn"
  else
    log_pass "No secrets in ENV/ARG"
  fi

  # Final stage must end as a non-root user, stated in the plugin's OWN
  # Dockerfile (never inherited implicitly): `USER 1000:1000` — the base's
  # unprivileged `plugin` user — or another non-root name/uid.
  local final_user user_part
  final_user="$(_final_user "$dockerfile")"
  user_part="${final_user%%:*}"
  if [ -z "$final_user" ]; then
    log_fail "Final stage sets no USER (end with \`USER 1000:1000\`)" "$fqn"
  elif [ "$user_part" = "root" ] || [ "$user_part" = "0" ]; then
    log_fail "Final stage runs as root (USER ${final_user}); end with \`USER 1000:1000\`" "$fqn"
  else
    log_pass "Final USER is non-root (${final_user})"
  fi

  # No pipe-to-shell installers.
  local offenders
  offenders="$(_pipe_installers "$dockerfile")"
  if [ -n "$offenders" ]; then
    log_fail "Pipes a download into a shell (use a pinned release via fetch-verified, a fetch-apt-key apt repo, or an ecosystem base): $(echo "$offenders" | head -1 | cut -c1-160)" "$fqn"
  else
    log_pass "No pipe-to-shell installers"
  fi

  # Every download goes through fetch-verified (pinned version + digest).
  offenders="$(_raw_downloads "$dockerfile")"
  if [ -n "$offenders" ]; then
    log_fail "Raw download not via fetch-verified: $(echo "$offenders" | head -1 | cut -c1-160)" "$fqn"
  else
    log_pass "All downloads checksum-verified (fetch-verified)"
  fi

  if grep -q "apt-get install" "$dockerfile" 2>/dev/null; then
    if grep -q "rm -rf /var/lib/apt/lists" "$dockerfile" 2>/dev/null; then
      log_pass "Has apt cache cleanup"
    else
      log_fail "Missing apt cache cleanup (rm -rf /var/lib/apt/lists/*)" "$fqn"
    fi
  fi

  if [ "$BUILD_IMAGES" = true ]; then
    local tag="plugin-test-${fqn//\//-}:latest"
    log_info "Building Docker image: ${tag}"
    if docker build -t "$tag" "$plugin_dir" > /dev/null 2>&1; then
      log_pass "Docker build successful"

      # Smoke test: actually run the image. Without this, a Dockerfile that
      # builds but produces an unrunnable image (broken ENTRYPOINT, missing
      # CMD shell, fs that 'cd /app' can't enter) reports PASS but blows up
      # at the first real CodeBuild execution.
      #
      # Default smoke test: launch bash, print OK. If plugin-spec.yaml has
      # a `smokeTest:` field, run that command too — gives plugin authors a
      # way to assert tool-specific invariants like `which snyk && snyk --version`.
      if docker run --rm --entrypoint=/bin/bash "$tag" -c 'echo OK' > /dev/null 2>&1; then
        log_pass "Image launches"
      else
        log_fail "Image fails to launch (broken CMD/ENTRYPOINT or shell)" "$fqn"
      fi

      # The image's effective runtime uid must not be root.
      local run_uid
      run_uid=$(docker run --rm --entrypoint=/bin/sh "$tag" -c 'id -u' 2>/dev/null || true)
      if [ -n "$run_uid" ] && [ "$run_uid" != "0" ]; then
        log_pass "Image runs as uid ${run_uid}"
      else
        log_fail "Image runs as root (uid '${run_uid}')" "$fqn"
      fi

      local smoke
      smoke=$(yq eval '.smokeTest // ""' "$specfile" 2>/dev/null)
      if [ -n "$smoke" ] && [ "$smoke" != "null" ]; then
        if docker run --rm --entrypoint=/bin/bash "$tag" -c "$smoke" > /dev/null 2>&1; then
          log_pass "Smoke test passed: ${smoke}"
        else
          log_fail "Smoke test failed: ${smoke}" "$fqn"
        fi
      fi

      docker rmi "$tag" > /dev/null 2>&1 || true
    else
      log_fail "Docker build failed" "$fqn"
    fi
  fi

  # Heredoc commands without `set -e` are a foot-gun: an intermediate
  # failing command silently passes and the script keeps running with
  # bad state. Warn (not fail) — fixing requires per-spec review since
  # some commands deliberately swallow failures with `|| true` or case
  # fallthrough.
  if grep -q "^[[:space:]]*- |" "$specfile" 2>/dev/null; then
    if ! grep -q "set -e" "$specfile" 2>/dev/null; then
      log_warn "Has multi-line heredoc command(s) but no \`set -e\` — intermediate failures will silently pass"
    fi
  fi
}

validate_config() {
  local plugin_dir="$1"
  local fqn
  fqn="$(basename "$(dirname "$plugin_dir")")/$(basename "$plugin_dir")"
  local config="${plugin_dir}/config.yaml"

  if [ ! -f "$config" ]; then
    log_skip "No config.yaml"
    return
  fi

  local bt
  bt=$(get_spec_field buildType "$config")
  if [ -z "$bt" ]; then
    log_fail "Missing buildType in config.yaml" "$fqn"
  elif _in_list "$bt" "${VALID_BUILD_TYPES[@]}"; then
    log_pass "Valid buildType: ${bt}"
  else
    log_fail "Invalid buildType: ${bt} (expected: ${VALID_BUILD_TYPES[*]})" "$fqn"
  fi
}

test_plugin() {
  local plugin_dir="$1"
  local plugin_name category
  plugin_name="$(basename "$plugin_dir")"
  category="$(basename "$(dirname "$plugin_dir")")"
  local specfile="${plugin_dir}/plugin-spec.yaml"
  local dockerfile="${plugin_dir}/Dockerfile"

  echo ""
  log_info "Testing ${category}/${plugin_name}"

  if [ ! -f "$specfile" ]; then
    log_fail "Missing plugin-spec.yaml" "${category}/${plugin_name}"
    return
  fi

  local plugin_type
  plugin_type=$(get_spec_field pluginType "$specfile")

  # Only require Dockerfile for CodeBuildStep plugins
  if [ "$plugin_type" != "ManualApprovalStep" ] && [ ! -f "$dockerfile" ]; then
    log_fail "Missing Dockerfile" "${category}/${plugin_name}"
    return
  fi

  validate_spec "$specfile" "$plugin_dir"

  validate_config "$plugin_dir"

  if [ "$SPEC_ONLY" = false ] && [ "$plugin_type" != "ManualApprovalStep" ]; then
    validate_dockerfile "$dockerfile" "$plugin_dir" "$specfile"
  fi
}

# ---- Main ----

echo -e "${BLUE}Plugin Testing Framework${NC}"
echo "========================"
echo "  Plugins: ${PLUGINS_DIR}"
echo "  Mode:    $([ "$SPEC_ONLY" = true ] && echo "spec-only" || echo "full")$([ "$BUILD_IMAGES" = true ] && echo " +docker-build" || echo "")"

# The catalog-metadata checks (and --build's smokeTest lookup) read the spec via
# yq; --build also needs docker. Assert up front: without this a missing yq
# silently yields empty values (checks skipped, reported green) instead of
# failing loudly.
preflight yq
if [ "$BUILD_IMAGES" = true ]; then
  preflight docker
fi

if [ -n "$SPECIFIC_PLUGIN" ]; then
  plugin_path="${PLUGINS_DIR}/${SPECIFIC_PLUGIN}"
  if [ -d "$plugin_path" ]; then
    test_plugin "$plugin_path"
  else
    echo -e "${RED}Plugin not found: ${SPECIFIC_PLUGIN}${NC}"
    exit 1
  fi
else
  for category_dir in "${PLUGINS_DIR}"/*/; do
    [ -d "$category_dir" ] || continue
    # Skip `_`-prefixed dirs (e.g. _base — shared base image, not a plugin).
    case "$(basename "$category_dir")" in _*) continue ;; esac
    for plugin_dir in "${category_dir}"/*/; do
      [ -d "$plugin_dir" ] || continue
      test_plugin "$plugin_dir"
    done
  done
fi

# ---- Summary ----

print_results
print_errors_and_exit "All tests passed!"
