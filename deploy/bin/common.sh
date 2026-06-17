#!/usr/bin/env bash
# Shared functions for deploy/bin scripts.
# Source this file: . "$(dirname "$0")/common.sh"
# Note: Requires bash (uses arrays, ERRORS+=(), ${#ERRORS[@]}).
#
# ── BASH 3.2 / macOS PORTABILITY ─────────────────────────────────────────────
# These scripts must run on the stock macOS bash (3.2). The recurring foot-guns,
# documented here ONCE so they aren't re-learned (and re-broken) per script:
#   • Expand a possibly-EMPTY array under `set -u` with the `+` form, never bare:
#       docker build "${args[@]+"${args[@]}"}" ...   # bare "${args[@]}" → "unbound variable"
#   • No `mapfile`/`readarray` (bash 4+) — use `read_lines <arr>` below (or `while read`).
#   • No associative arrays (`declare -A`) and no case-mod (`${v^^}` / `${v,,}`).
# A function can't safely expand an array (command substitution drops quoting), so the
# `"${arr[@]+...}"` idiom must stay inline — this block is its single source of truth.
# ─────────────────────────────────────────────────────────────────────────────

# Common paths.
#
# Callers SHOULD set `SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"` before
# sourcing — the value below is only a fallback for callers that forgot.
# Because this file is sourced (not exec'd), `$0` here resolves to the
# OUTER script's path, not common.sh's. So the fallback already gives the
# caller's dir; we don't gain anything by computing it twice.
SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "$0")" 2>/dev/null && pwd || pwd)}"
# Consumed by the sibling scripts that source this file (sourced-globals contract).
# shellcheck disable=SC2034
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)"
PLATFORM_BASE_URL="${PLATFORM_BASE_URL:-https://localhost:8443}"
DEPLOY_TARGET="${DEPLOY_TARGET:-local}"

# Move out of any cwd we might not be able to restore. When the script is
# invoked via `sudo -u minikube ...` from `/home/ec2-user`, every `find`
# subprocess emits "Failed to restore initial working directory" because
# the new user can't read ec2-user's home. Working from /tmp (world-readable)
# sidesteps that entirely. Done in common.sh so EVERY script that sources
# it inherits the fix without per-script edits.
#
# CALLER CONTRACT: do NOT use relative paths in any consumer of common.sh.
# `pwd` after sourcing is `/tmp`, not the caller's invocation dir. Use
# absolute paths derived from SCRIPT_DIR / DEPLOY_DIR / "$1".
cd /tmp 2>/dev/null || cd / 2>/dev/null || true

# ---- Colors ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ---- Logging helpers ----
# Callers must initialize: PASSED=0 FAILED=0 SKIPPED=0 ERRORS=()

log_pass() { echo -e "  ${GREEN}PASS${NC} $1"; PASSED=$((PASSED + 1)); }
log_fail() { echo -e "  ${RED}FAIL${NC} $1"; FAILED=$((FAILED + 1)); ERRORS+=("$2: $1"); }
log_skip() { echo -e "  ${YELLOW}SKIP${NC} $1"; SKIPPED=$((SKIPPED + 1)); }
log_warn() { echo -e "  ${YELLOW}WARN${NC} $1"; }
log_info() { echo -e "${BLUE}==>${NC} $1"; }

# read_lines ARRAY < input — portable `mapfile -t` (bash 3.2 has none). Reads each
# line of stdin into the named array (no nameref in 3.2, so it goes via eval).
#   Usage:  read_lines REFS < <(grep -rhoE '…' "$dir" | sort -u)
read_lines() {
  local __name="$1" __line
  eval "$__name=()"
  while IFS= read -r __line; do eval "$__name+=(\"\$__line\")"; done
}

# ---------------------------------------------------------------------------
# get_spec_field — extract a top-level field from a YAML file (e.g. plugin-spec.yaml)
#   $1 field name   $2 YAML file path
#   Echoes the value (trimmed), empty string if not found
# ---------------------------------------------------------------------------
get_spec_field() {
  # Trim the leading "field:" + spaces AND any trailing whitespace, including a
  # trailing CR, so CRLF-edited specs don't yield values with a stray \r.
  grep "^${1}:" "$2" 2>/dev/null | head -1 | sed -E "s/^${1}:[[:space:]]*//; s/[[:space:]]+$//"
}

# ---------------------------------------------------------------------------
# sha256_hash — portable SHA-256 (works on Linux and macOS)
#   Reads stdin, outputs 64-char hex digest
# ---------------------------------------------------------------------------
sha256_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

# ---------------------------------------------------------------------------
# require_yq — ensure `yq` (mikefarah's Go YAML parser) is on PATH.
#
# Replaced ~150 lines of brittle awk YAML state-machine code in
# build-plugin-images.sh and generate-plugins.sh — those parsers broke on
# multi-line values, comments after value, single-quoted strings with
# embedded commas, etc. Call this once at the top of any script that uses
# the `yq_*` helpers below.
# ---------------------------------------------------------------------------
require_yq() {
  if ! command -v yq >/dev/null 2>&1; then
    echo "ERROR: yq is required but not installed." >&2
    echo "  macOS:  brew install yq" >&2
    echo "  Linux:  https://github.com/mikefarah/yq#install" >&2
    exit 1
  fi
}

# yq_buildargs — emit `--build-arg KEY=VALUE` flags for plugin-spec.yaml
# Outputs nothing if `buildArgs` is absent. Quoting is yq's responsibility.
yq_buildargs() {
  local _spec="$1"
  yq eval '
    .buildArgs // {}
    | to_entries
    | map("--build-arg " + .key + "=" + (.value | tostring))
    | .[]
  ' "$_spec"
}

# ---------------------------------------------------------------------------
# compute_image_tag — deterministic image tag from plugin directory contents
#
# Hashes the SHA256 of every file in the plugin directory (except the build
# outputs `image.tar`, `plugin.zip`, and the `.image-hash` cache sidecar),
# plus the plugin-spec.yaml buildArgs.
# Files are listed in sorted order so the hash is stable across runs.
#
# Why hash the whole directory: previously this hashed only the Dockerfile +
# buildArgs, which silently shipped stale `image.tar`s when COPY'd files
# (entrypoint scripts, configs, sibling sources) changed. Anything visible
# to the build context now bumps the tag.
#
#   $1 plugin directory
#   Outputs: p-{name}-{sha256-first-12}
# ---------------------------------------------------------------------------
compute_image_tag() {
  local _plugin_dir="$1"
  local _name
  _name=$(get_spec_field name "$_plugin_dir/plugin-spec.yaml")
  local _name_clean
  _name_clean=$(echo "$_name" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')

  # Hash every file in the plugin directory in sorted order, excluding build
  # outputs that aren't part of the source. We hash filename+content so a
  # rename also invalidates the tag.
  #
  # Why config.yaml is excluded: build-plugin-images.sh writes the computed
  # tag into config.yaml as `imageTag:`. If we hashed config.yaml we'd
  # get a self-referential dependency — the hash would change on every
  # build because the file it's hashed from contains the previous build's
  # tag. config.yaml only carries build metadata (pluginSpec/buildType/
  # imageTag), not source the platform executes; plugin-spec.yaml is the
  # contract that actually changes behaviour, and it IS hashed.
  #
  # `cd` first so find doesn't try (and fail) to restore cwd when the
  # script is invoked via `sudo -u <other>` from a directory the new user
  # can't read (typical EC2 case: cwd=/home/ec2-user, running as minikube).
  local _content_hash
  _content_hash=$(
    cd "$_plugin_dir" && \
    find . -type f \
      -not -name 'image.tar' \
      -not -name 'plugin.zip' \
      -not -name '.image-hash' \
      -not -name 'config.yaml' \
      -not -name '.DS_Store' \
      | LC_ALL=C sort \
      | while read -r _f; do
          printf '%s\n' "${_f#./}"
          cat "$_f"
        done \
      | sha256_hash
  )

  # buildArgs hashed via yq for the same reason `parse_build_arg_flags`
  # delegates to it: awk-based YAML parsing was fragile across quoting.
  # yq is REQUIRED here — a soft fallback would omit buildArgs from the hash on
  # a host without yq, so the same plugin would compute a different tag there
  # (cache misses / shipping a stale image). Fail loudly instead.
  command -v yq >/dev/null 2>&1 || {
    echo "ERROR: yq is required for compute_image_tag (the image-tag hash depends on it)" >&2
    return 1
  }
  local _build_args
  _build_args=$(yq eval '
    .buildArgs // {}
    | to_entries
    | map(.key + "=" + (.value | tostring))
    | sort
    | .[]
  ' "$_plugin_dir/plugin-spec.yaml" 2>/dev/null || true)

  local _hash
  _hash=$(printf '%s\n%s' "$_content_hash" "$_build_args" | sha256_hash)
  echo "p-${_name_clean}-${_hash:0:12}"
}

# ---------------------------------------------------------------------------
# print_results — display test/verify results summary
#   Uses: PASSED, FAILED, SKIPPED
# ---------------------------------------------------------------------------
print_results() {
  echo ""
  echo "========================"
  echo -e "Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, ${YELLOW}${SKIPPED} skipped${NC}"
}

# ---------------------------------------------------------------------------
# print_errors_and_exit — print error list and exit 1 if any, else print success
#   $1 success message (e.g. "All tests passed!")
#   Uses: ERRORS[]
# ---------------------------------------------------------------------------
print_errors_and_exit() {
  if [ ${#ERRORS[@]} -gt 0 ]; then
    echo ""
    echo -e "${RED}Failures:${NC}"
    for err in "${ERRORS[@]}"; do
      echo "  - $err"
    done
    exit 1
  fi
  echo -e "\n${GREEN}${1}${NC}"
}

# ---------------------------------------------------------------------------
# wait_for_health — poll $PLATFORM_BASE_URL/ready until 200
#   $1  max retries  (default 30)
#   $2  interval sec (default 5)
# ---------------------------------------------------------------------------
wait_for_health() {
  local _max="${1:-30}"
  local _interval="${2:-5}"
  # Poll /ready (proxies to platform:3000/health) — NOT /health, which is nginx's
  # static stub that returns 200 instantly even while the platform is still starting.
  echo "Waiting for platform to be ready at ${PLATFORM_BASE_URL}/ready ..."
  local _i=1
  while [ "$_i" -le "$_max" ]; do
    local _status
    _status=$(curl -s -k -o /dev/null -w "%{http_code}" "${PLATFORM_BASE_URL}/ready" 2>/dev/null || true)
    if [ "$_status" = "200" ]; then
      echo "Platform is healthy."
      return 0
    fi
    if [ "$_i" = "$_max" ]; then
      echo "Platform failed to become healthy after $((_max * _interval))s — aborting." >&2
      return 1
    fi
    sleep "$_interval"
    _i=$((_i + 1))
  done
}

# ---------------------------------------------------------------------------
# wait_for_service_ready — poll $PLATFORM_BASE_URL/ready/<svc> until the named
#   backend service reports ready (its own /ready, surfaced by the nginx
#   /ready/<svc> route). Used to gate the sample loads on their *dependent*
#   services (compliance/pipeline/plugin) so a load never races ahead of a
#   still-starting service (e.g. compliance crash-looping on its DB connection).
#
#   $1  service name (plugin|pipeline|compliance)
#   $2  max retries  (default 60)
#   $3  interval sec (default 5)
#
#   Returns 0 once the service reports ready (HTTP 200). If the gateway has no
#   /ready/<svc> route (HTTP 404 — e.g. an older nginx.conf), it warns and
#   returns 0 so behaviour degrades to the previous no-gate path rather than
#   blocking forever. Returns 1 only if the service never became ready in time.
# ---------------------------------------------------------------------------
wait_for_service_ready() {
  local _svc="$1"
  local _max="${2:-60}"
  local _interval="${3:-5}"
  echo "Waiting for '${_svc}' service to be ready at ${PLATFORM_BASE_URL}/ready/${_svc} ..."
  local _i=1
  local _status
  while [ "$_i" -le "$_max" ]; do
    _status=$(curl -s -k -o /dev/null -w "%{http_code}" "${PLATFORM_BASE_URL}/ready/${_svc}" 2>/dev/null || true)
    if [ "$_status" = "200" ]; then
      echo "  '${_svc}' is ready."
      return 0
    fi
    if [ "$_status" = "404" ]; then
      log_warn "Gateway has no /ready/${_svc} route — skipping readiness gate for '${_svc}'."
      return 0
    fi
    if [ "$_i" = "$_max" ]; then
      echo "  '${_svc}' not ready after $((_max * _interval))s (last HTTP ${_status:-000})." >&2
      return 1
    fi
    sleep "$_interval"
    _i=$((_i + 1))
  done
}

# ---------------------------------------------------------------------------
# list_categories <plugins_dir> — print plugin category names (one per line,
#   sorted), skipping `_`-prefixed dirs (e.g. _base — a shared base image, not a
#   category). Shared by build-plugin-images.sh / load-plugins.sh / init-platform.sh.
# ---------------------------------------------------------------------------
list_categories() {
  find -L "$1" -mindepth 1 -maxdepth 1 -type d ! -name '_*' | sort | xargs -I{} basename {}
}

# ---------------------------------------------------------------------------
# prompt_toggle <varname> <prompt-text> — resolve a y/n toggle. An env-set value
#   (automation) is honored as-is; otherwise prompt on a TTY; otherwise default "n".
#   Sets the named variable in place — no eval (indirect read `${!var}` + printf -v).
# ---------------------------------------------------------------------------
prompt_toggle() {
  local _var="$1" _prompt="$2" _val
  _val="${!_var:-}"                       # bash indirect read (no eval)
  if [ -z "$_val" ] && [ -t 0 ]; then
    printf '%s ' "$_prompt"
    read -r _val
  fi
  printf -v "$_var" '%s' "${_val:-n}"
}

# ---------------------------------------------------------------------------
# prompt_credentials — prompt for identifier/password if not already set
#   Sets PLATFORM_IDENTIFIER and PLATFORM_PASSWORD
#
#   - Password is masked with `*` per keystroke (so input is visible as feedback
#     without echoing the value); a piped/non-interactive stdin uses a silent read.
#   - Default identifier (`admin@internal`) is shown in the prompt only on
#     the `local` deploy target — for ec2/eks/minikube, the operator is
#     forced to type a value to avoid accidentally creating a production
#     admin with the local-dev default.
#   - Default password is NEVER shown in the prompt. It's still accepted as
#     a fallback ONLY on the `local` target, again to keep the trivial
#     dev-default out of any real environment.
# ---------------------------------------------------------------------------
prompt_credentials() {
  local _is_local
  [ "${DEPLOY_TARGET:-local}" = "local" ] && _is_local=true || _is_local=false

  if [ -z "${PLATFORM_IDENTIFIER:-}" ]; then
    if [ "$_is_local" = true ]; then
      printf "Identifier [admin@internal]: "
      read -r PLATFORM_IDENTIFIER
      PLATFORM_IDENTIFIER="${PLATFORM_IDENTIFIER:-admin@internal}"
    else
      printf "Identifier: "
      read -r PLATFORM_IDENTIFIER
      [ -z "$PLATFORM_IDENTIFIER" ] && { echo "ERROR: identifier required on target=${DEPLOY_TARGET}" >&2; return 1; }
    fi
  fi

  if [ -z "${PLATFORM_PASSWORD:-}" ]; then
    printf "Password: "
    # Echo a `*` per keystroke so the user can see input is registering (plain
    # `read -s` shows nothing at all). Handles backspace; the value itself never
    # echoes. Non-interactive stdin (pipe) falls back to a silent read.
    if [ -t 0 ]; then
      PLATFORM_PASSWORD=''
      local _ch
      while IFS= read -rsn1 _ch; do
        case "$_ch" in
          '') break ;;                                   # Enter
          $'\177'|$'\b')                                  # Backspace / Delete
            if [ -n "$PLATFORM_PASSWORD" ]; then
              PLATFORM_PASSWORD="${PLATFORM_PASSWORD%?}"
              printf '\b \b'
            fi ;;
          *) PLATFORM_PASSWORD="${PLATFORM_PASSWORD}${_ch}"; printf '*' ;;
        esac
      done
    else
      read -rs PLATFORM_PASSWORD
    fi
    printf "\n"
    if [ -z "$PLATFORM_PASSWORD" ]; then
      if [ "$_is_local" = true ]; then
        # Local-only convenience fallback so `init-platform.sh local` can
        # still be hit-enter through. Never shown in the prompt, never
        # accepted on non-local targets.
        PLATFORM_PASSWORD="SecurePassword123!"
      else
        echo "ERROR: password required on target=${DEPLOY_TARGET}" >&2
        return 1
      fi
    fi
  fi
}

# ---------------------------------------------------------------------------
# login — authenticate against $PLATFORM_BASE_URL and set JWT_TOKEN
#   Requires PLATFORM_IDENTIFIER and PLATFORM_PASSWORD to be set.
# ---------------------------------------------------------------------------
login() {
  local _resp _err
  _resp=$(curl -X POST "${PLATFORM_BASE_URL}/api/auth/login" \
    -k -s \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg id "$PLATFORM_IDENTIFIER" --arg pw "$PLATFORM_PASSWORD" \
      '{identifier: $id, password: $pw}')" 2>&1) || true

  JWT_TOKEN=$(printf '%s' "$_resp" | jq -r '.data.accessToken' 2>/dev/null) || true

  if [ -z "${JWT_TOKEN}" ] || [ "${JWT_TOKEN}" = "null" ]; then
    # Only print the server's explicit `.error`/`.message` if present;
    # avoid dumping the full response which could leak details about the
    # auth endpoint's internal error shape.
    _err=$(printf '%s' "$_resp" | jq -r '.error // .message // empty' 2>/dev/null)
    echo "Login failed — could not obtain JWT token" >&2
    [ -n "$_err" ] && echo "  ${_err}" >&2
    return 1
  fi
  echo "  Logged in successfully."
}

# ---------------------------------------------------------------------------
# sign_platform_jwt — mint a short-lived HS256 platform JWT for system
# admin access (no Node deps). Used by push-base-images.sh to authenticate
# against the in-cluster image registry. Same trick the plugin service
# uses for runtime builds.
#
#   $1   JWT_SECRET (HMAC key)
#   $2?  expiry seconds (default 300)
#   echoes the compact JWT, exits 1 if openssl is missing.
#
# Lives in common.sh so any deploy script needing a platform-scoped JWT
# (registry pushes, smoke tests, signed API checks) reuses the same
# signing path. Image-registry's `auth-resolver.ts verifyPlatformJwt`
# requires `organizationId` (not `orgId`); `isAdmin`/`isSuperAdmin` gate
# access to `library/*` and `system/*` via the admin-priority rule in
# `token-service.ts authorizeScope`.
# ---------------------------------------------------------------------------
_b64url_jwt() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}
# ---------------------------------------------------------------------------
# require_env — assert that one or more env vars are non-empty.
#   $@  env var names
#   Exits 1 on first missing var with a clear message.
# Used by backup.sh/restore.sh and any other script that needs to fail
# fast on configuration gaps.
# ---------------------------------------------------------------------------
require_env() {
  local _var
  for _var in "$@"; do
    if [ -z "${!_var:-}" ]; then
      echo "ERROR: required env var '$_var' is not set" >&2
      exit 1
    fi
  done
}

sign_platform_jwt() {
  local _secret="$1"
  local _ttl="${2:-300}"
  command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl required for sign_platform_jwt" >&2; return 1; }
  local _now _exp _header _payload _signing _sig
  _now=$(date +%s)
  _exp=$((_now + _ttl))
  _header='{"alg":"HS256","typ":"JWT"}'
  _payload=$(printf '{"sub":"bootstrap-push","organizationId":"system","isAdmin":true,"isSuperAdmin":true,"iat":%s,"exp":%s}' "$_now" "$_exp")
  _signing="$(printf %s "$_header" | _b64url_jwt).$(printf %s "$_payload" | _b64url_jwt)"
  # Prefer python3 (key via env, off the argv) so the HMAC secret isn't visible
  # in `ps`/`/proc` to other users on the host. `openssl dgst -hmac` has no
  # off-argv key option, so it's the fallback when python3 is unavailable.
  # Both compute HMAC-SHA256 → base64url(no pad), so the signature is identical.
  if command -v python3 >/dev/null 2>&1; then
    _sig=$(_PB_HMAC_KEY="$_secret" python3 -c '
import hmac, hashlib, os, sys, base64
sig = hmac.new(os.environ["_PB_HMAC_KEY"].encode(), sys.argv[1].encode(), hashlib.sha256).digest()
sys.stdout.write(base64.urlsafe_b64encode(sig).decode().rstrip("="))
' "$_signing")
  else
    _sig=$(printf %s "$_signing" | openssl dgst -binary -sha256 -hmac "$_secret" | _b64url_jwt)
  fi
  printf '%s.%s\n' "$_signing" "$_sig"
}

# ---------------------------------------------------------------------------
# require_auth — ensure JWT_TOKEN is set (via PLATFORM_TOKEN or login)
#   Sets JWT_TOKEN for the calling script.
# ---------------------------------------------------------------------------
require_auth() {
  if [ -n "${PLATFORM_TOKEN:-}" ]; then
    JWT_TOKEN="$PLATFORM_TOKEN"
    echo "=== Using provided PLATFORM_TOKEN ==="
    echo ""
    return 0
  fi

  prompt_credentials
  echo "=== Authenticating ==="
  login
  echo ""
}

# ---------------------------------------------------------------------------
# check_url — verify a URL is reachable (HTTP 200/301/302)
#   $1 url  $2 label
#   Uses/increments: PASSED, FAILED, ERRORS[], CHECK_TIMEOUT (default 15)
# ---------------------------------------------------------------------------
check_url() {
  local _curl_code
  _curl_code=$(curl -sSL -o /dev/null -w "%{http_code}" --head --max-time "${CHECK_TIMEOUT:-15}" "$1" 2>/dev/null) || _curl_code="000"
  if [ "$_curl_code" = "200" ] || [ "$_curl_code" = "302" ] || [ "$_curl_code" = "301" ]; then
    echo -e "    ${GREEN}OK${NC}  $2"
    PASSED=$((PASSED + 1))
  else
    echo -e "    ${RED}FAIL${NC} HTTP $_curl_code — $2"
    FAILED=$((FAILED + 1))
    ERRORS+=("$2 (HTTP $_curl_code)")
  fi
}

# ---------------------------------------------------------------------------
# check_docker_image — verify a Docker image exists
#   $1 image  $2 label
#   Uses/increments: PASSED, FAILED, ERRORS[], CHECK_TIMEOUT (default 15)
# ---------------------------------------------------------------------------
check_docker_image() {
  if docker manifest inspect "$1" > /dev/null 2>&1; then
    echo -e "    ${GREEN}OK${NC}  $2"
    PASSED=$((PASSED + 1))
    return
  fi
  # Fallback: Docker Hub Tags API (avoids unauthenticated pull rate limits)
  _img_repo="${1%%:*}"
  _img_tag="${1#*:}"
  _api_result=$(curl -s --max-time "${CHECK_TIMEOUT:-15}" "https://hub.docker.com/v2/repositories/${_img_repo}/tags/${_img_tag}" 2>/dev/null)
  if echo "$_api_result" | grep -q '"name"'; then
    echo -e "    ${GREEN}OK${NC}  $2 (via hub API)"
    PASSED=$((PASSED + 1))
  else
    echo -e "    ${RED}FAIL${NC} image not found — $2"
    FAILED=$((FAILED + 1))
    ERRORS+=("$2 (image not found)")
  fi
}

# ---------------------------------------------------------------------------
# select_categories — interactive numbered category picker
#   $1 plugins directory
#   Sets: SELECTED_CATEGORIES (comma-separated, empty if "all" chosen)
#   Returns 0 if categories selected, 1 if user cancelled
# ---------------------------------------------------------------------------
select_categories() {
  local _plugins_dir="$1"
  local _available
  # cd into plugins dir first so `find` doesn't try (and fail) to restore
  # cwd when called as sudo -u from a directory the new user can't read.
  # Skip `_`-prefixed dirs (build infrastructure like _base — not loadable
  # plugins, would confuse the operator's category selection).
  _available=$(cd "$_plugins_dir" && find -L . -mindepth 1 -maxdepth 1 -type d ! -name '_*' | sort | sed 's|^\./||')

  echo ""
  # Show running user + the plugins-dir owner. If they differ, find/sed/etc.
  # may hit permission errors — the most common cause of the "Failed to
  # restore initial working directory" error operators see when running
  # this script via `sudo -u minikube ...`.
  local _running_user _dir_owner _dir_perms
  _running_user=$(id -un 2>/dev/null || echo "?")
  _dir_owner=$(stat -c '%U:%G' "$_plugins_dir" 2>/dev/null || stat -f '%Su:%Sg' "$_plugins_dir" 2>/dev/null || echo "?")
  _dir_perms=$(stat -c '%a' "$_plugins_dir" 2>/dev/null || stat -f '%Lp' "$_plugins_dir" 2>/dev/null || echo "?")
  echo "  Running as: ${_running_user}    Plugins dir: ${_dir_owner} (${_dir_perms})"
  echo ""
  echo "  Available categories:"
  local _i=0 _cat _count _cat_owner
  for _cat in $_available; do
    _i=$((_i + 1))
    _count=$(cd "$_plugins_dir/$_cat" 2>/dev/null && find -L . -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
    _cat_owner=$(stat -c '%U:%G' "$_plugins_dir/$_cat" 2>/dev/null || stat -f '%Su:%Sg' "$_plugins_dir/$_cat" 2>/dev/null || echo "?")
    printf "    %2d) %-20s %3d plugins   [%s]\n" "${_i}" "${_cat}" "${_count}" "${_cat_owner}"
  done

  echo ""
  local _answer
  printf "  Load all categories? [Y/n]: "
  read -r _answer

  if [ "$_answer" = "n" ] || [ "$_answer" = "N" ]; then
    local _selected_nums _picked="" _num _idx
    printf "  Enter category numbers (comma-separated, e.g. 1,3,4): "
    read -r _selected_nums
    for _num in $(echo "$_selected_nums" | tr ',' ' '); do
      _idx=0
      for _cat in $_available; do
        _idx=$((_idx + 1))
        [ "$_idx" = "$_num" ] && _picked="${_picked}${_cat},"
      done
    done
    SELECTED_CATEGORIES="${_picked%,}"
    [ -n "$SELECTED_CATEGORIES" ] || { echo "  No valid categories selected."; return 1; }
    echo "  Selected: $SELECTED_CATEGORIES"
  else
    SELECTED_CATEGORIES=$(echo "$_available" | tr ' ' ',' | tr '\n' ',' | sed 's/,$//')
  fi
}

# ---------------------------------------------------------------------------
# classify_status — map an HTTP status code to a result keyword
#   $1  HTTP status code
#   Echoes: "ok", "exists", or "fail"
# ---------------------------------------------------------------------------
classify_status() {
  case "$1" in
    200|201|202) echo "ok" ;;
    409)         echo "exists" ;;
    *)           echo "fail" ;;
  esac
}

# ---------------------------------------------------------------------------
# is_retryable_status — check if an HTTP status code is worth retrying
#   $1  HTTP status code
#   Returns 0 (retryable) or 1 (not retryable)
# ---------------------------------------------------------------------------
is_retryable_status() {
  case "$1" in
    429|502|503|504|000) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# curl_with_retry — POST with retry loop on retryable HTTP status codes
#   $1  label (display name for logging)
#   $2+ curl arguments (URL, headers, data, etc.)
#   Env: UPLOAD_RETRIES (default 3), UPLOAD_RETRY_DELAY (default 30)
#        CURL_BODY_FILE (optional): write response body to this path so the
#          caller can parse partial-failure detail. Do NOT pass `-o` in
#          "$@" — curl only honors one `-o` per URL and the hardcoded
#          `-o /dev/null` below would silently win.
#   Exits: 0=ok, 1=fail, 2=exists (skip)
# ---------------------------------------------------------------------------
curl_with_retry() {
  local _label="$1"; shift
  local _retries="${UPLOAD_RETRIES:-3}"
  local _delay="${UPLOAD_RETRY_DELAY:-30}"
  local _out="${CURL_BODY_FILE:-/dev/null}"
  local _attempt=1 _status _result

  while [ "$_attempt" -le "$_retries" ]; do
    _status=$(curl -s -o "$_out" -w "%{http_code}" --insecure "$@" 2>/dev/null || echo "000")
    _result="$(classify_status "$_status")"

    if [ "$_result" = "fail" ] && is_retryable_status "$_status" && [ "$_attempt" -lt "$_retries" ]; then
      echo -e "  ${YELLOW}RETRY${NC} $_label (HTTP $_status) attempt ${_attempt}/${_retries}"
      sleep "$_delay"
      _attempt=$((_attempt + 1))
      continue
    fi

    case "$_result" in
      ok)     echo -e "  ${GREEN}OK${NC}   $_label (HTTP $_status)"; return 0 ;;
      exists) echo -e "  ${YELLOW}SKIP${NC} $_label (exists)";       return 2 ;;
      *)      echo -e "  ${RED}FAIL${NC} $_label (HTTP $_status)";   return 1 ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# print_summary — display the standard upload/create summary
#   $1 total  $2 succeeded  $3 failed  $4 skipped  $5 duration_seconds
# ---------------------------------------------------------------------------
print_summary() {
  echo ""
  echo "=== Summary ==="
  echo "  Total:     $1"
  echo "  Succeeded: $2"
  echo "  Failed:    $3"
  echo "  Skipped:   $4"
  echo "  Duration:  ${5}s"

  if [ "$3" -gt 0 ]; then
    echo ""
    echo "WARNING: $3 item(s) failed"
  fi
}
