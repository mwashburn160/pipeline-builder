#!/usr/bin/env bash
# Shared functions for deploy/bin scripts.
# Source this file: . "$(dirname "$0")/common.sh"
# Note: Requires bash (uses arrays, ERRORS+=(), ${#ERRORS[@]}).
#
# SHELL OPTIONS: this file is SOURCED, never executed, so it deliberately sets
# NO `set -euo pipefail`. `set` inside a sourced file mutates the CALLER's shell
# — it would silently turn on errexit for whatever sourced us (including an
# interactive shell, where a failed command would then close the terminal).
# Every caller already runs under `set -euo pipefail`; these functions therefore
# propagate failure the portable way, by RETURNING non-zero, so they behave the
# same whether or not the caller has errexit on.
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
DEPLOY_TARGET="${DEPLOY_TARGET:-docker}"

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

# ---------------------------------------------------------------------------
# mc_setup_aliases — configure the two MinIO client aliases used by backup/restore:
#   pbsrc = this deploy's MinIO (MINIO_ENDPOINT + root creds)
#   pbdst = the backup target    (MINIO_BACKUP_TARGET_URL + its creds)
#   $1 = mc --config-dir (isolated per-run config). Exits 2 on failure (sourced,
#   so the exit propagates to the caller, matching the previous inline behavior).
# ---------------------------------------------------------------------------
mc_setup_aliases() {
  local _cfg="$1"
  mc --config-dir "$_cfg" alias set pbsrc "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null \
    || { echo "ERROR: mc alias set (source) failed" >&2; exit 2; }
  mc --config-dir "$_cfg" alias set pbdst "$MINIO_BACKUP_TARGET_URL" "$MINIO_BACKUP_TARGET_ACCESS_KEY" "$MINIO_BACKUP_TARGET_SECRET_KEY" >/dev/null \
    || { echo "ERROR: mc alias set (target) failed" >&2; exit 2; }
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
# build-plugin-images.sh — those parsers broke on
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

# ---------------------------------------------------------------------------
# preflight — assert a set of required tools are on PATH before a long-running
# entrypoint proceeds, so operators get ONE actionable error up front instead of
# a failure deep into provisioning. Usage: `preflight docker kubectl jq openssl`.
# ---------------------------------------------------------------------------
preflight() {
  local _missing=""
  local _t
  for _t in "$@"; do
    command -v "$_t" >/dev/null 2>&1 || _missing="$_missing $_t"
  done
  if [ -n "$_missing" ]; then
    echo "ERROR: missing required tool(s):$_missing" >&2
    echo "  Install them and re-run. (macOS: brew install <tool>)" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# ensure_istioctl <version> — guarantee an ambient-capable istioctl (>= 1.24) is
# on PATH, auto-downloading <version> and installing it to /usr/local/bin when the
# host has none (or too old). SHARED by every target's mesh install so istioctl is
# handled identically everywhere (minikube / ec2 / eks). Uses sudo only when
# /usr/local/bin isn't already writable (root — e.g. ec2 first boot — needs none).
# OS/arch aware (linux|osx, amd64|arm64). Usage: `ensure_istioctl "$ISTIO_VERSION"`.
# ---------------------------------------------------------------------------
ensure_istioctl() {
  local _want="${1:?ensure_istioctl needs an ISTIO_VERSION}"
  # Already have an ambient-capable istioctl (>= 1.24) on PATH? Use it as-is.
  local _maj _min _probe
  local _have=""
  # Probe the installed istioctl's version — but ONLY if it exists, and guard the
  # pipeline with `|| true`. The caller runs `set -euo pipefail`, so when istioctl
  # is ABSENT (the fresh-box auto-install path) `grep` matches nothing and exits 1;
  # under pipefail the pipeline is non-zero, and `_have="$(…)"` then fails the
  # ASSIGNMENT, which `set -e` turns into a silent whole-script exit BEFORE we ever
  # reach the install below. That is the exact case this function must handle, so
  # skip the probe entirely when istioctl isn't on PATH and never let it abort.
  #
  # CLIENT-ONLY probe (when istioctl IS present): it runs BEFORE the cluster exists
  # (bring-up calls ensure_istioctl before `minikube start`), so it must not reach a
  # control plane — a bare `istioctl version` blocks on the down/stale apiserver in
  # the caller's kubeconfig. `--remote=false` asks for client-only, KUBECONFIG=/dev/null
  # guarantees no context is found even if the flag is ignored, and `timeout` (Linux
  # always has it; macOS may not) caps any residual hang.
  _probe="istioctl version --remote=false"
  command -v timeout >/dev/null 2>&1 && _probe="timeout 10 $_probe"
  if command -v istioctl >/dev/null 2>&1; then
    _have="$(KUBECONFIG=/dev/null $_probe 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1 || true)"
  fi
  if [ -n "$_have" ]; then
    _maj="${_have%%.*}"; _min="${_have#*.}"
    if [ "$_maj" -gt 1 ] || { [ "$_maj" -eq 1 ] && [ "$_min" -ge 24 ]; }; then
      return 0
    fi
    echo "  istioctl $_have is too old for ambient (need >= 1.24) — installing $_want..."
  else
    echo "  istioctl not found — installing $_want..."
  fi
  local _os _arch _tmp
  _os="$(uname -s | tr '[:upper:]' '[:lower:]')"; case "$_os" in darwin) _os=osx ;; esac
  _arch="$(uname -m)"; case "$_arch" in x86_64) _arch=amd64 ;; arm64|aarch64) _arch=arm64 ;; esac
  _tmp="$(mktemp -d)"
  if ! curl -fsSL "https://github.com/istio/istio/releases/download/${_want}/istioctl-${_want}-${_os}-${_arch}.tar.gz" \
       | tar -xz -C "$_tmp" istioctl 2>/dev/null; then
    echo "ERROR: failed to download istioctl ${_want} (${_os}-${_arch})." >&2
    echo "  Install it manually and re-run: https://istio.io/latest/docs/setup/getting-started/#download" >&2
    rm -rf "$_tmp"; exit 1
  fi
  if [ -w /usr/local/bin ]; then
    install -m 0755 "$_tmp/istioctl" /usr/local/bin/istioctl
  else
    sudo install -m 0755 "$_tmp/istioctl" /usr/local/bin/istioctl
  fi
  rm -rf "$_tmp"
  echo "  istioctl ${_want} installed to /usr/local/bin"
}

# ensure_kubectl <k8s-version> — guarantee the `kubectl` used by the rest of the
# script is within Kubernetes' supported ±1 MINOR version skew of the cluster.
#
# Why: the kubectl on a dev Mac is usually Docker Desktop's symlink
# (/usr/local/bin/kubectl -> /Applications/Docker.app/...), which tracks Docker
# Desktop's own bundled k8s and lags badly — e.g. v1.32.2 against a minikube
# v1.35.1 cluster (3 minors). minikube prints a "may have incompatibilities"
# notice and carries on, but a skewed client is not cosmetic here: `kubectl apply
# --server-side`, CRD applies, and `kubectl wait` all negotiate against API
# versions the old client doesn't know, so bring-up fails in ways that look like
# cluster problems.
#
# We do NOT overwrite /usr/local/bin/kubectl the way ensure_istioctl installs
# istioctl — that path is Docker Desktop's symlink and Docker Desktop restores
# it, so the "fix" would silently revert. Instead fetch the version-matched
# binary into minikube's own cache (the exact path `minikube kubectl` uses, so
# there's no duplicate download) and prepend that dir to PATH for this script.
# The caller's `kubectl` calls then resolve to the matched binary; nothing on the
# system changes.
ensure_kubectl() {
  local _want="${1:?ensure_kubectl needs a Kubernetes version}"   # e.g. v1.35.1
  _want="v${_want#v}"                                             # tolerate 1.35.1
  local _want_min="${_want#v}"; _want_min="${_want_min#*.}"; _want_min="${_want_min%%.*}"

  # Probe the client version. Guarded with `|| true`: callers run `set -euo
  # pipefail`, and when kubectl is absent the pipeline exits non-zero, which
  # would abort the whole script at the ASSIGNMENT instead of installing.
  local _have="" _have_min _skew
  if command -v kubectl >/dev/null 2>&1; then
    _have="$(kubectl version --client 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+' | head -1 || true)"
  fi
  if [ -n "$_have" ]; then
    _have_min="${_have#v}"; _have_min="${_have_min#*.}"; _have_min="${_have_min%%.*}"
    _skew=$(( _have_min > _want_min ? _have_min - _want_min : _want_min - _have_min ))
    if [ "$_skew" -le 1 ]; then
      return 0
    fi
    echo "  kubectl ${_have} is ${_skew} minors from the cluster (${_want}) — using a version-matched client..."
  else
    echo "  kubectl not found — installing ${_want}..."
  fi

  local _os _arch _dir
  _os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  _arch="$(uname -m)"; case "$_arch" in x86_64) _arch=amd64 ;; arm64|aarch64) _arch=arm64 ;; esac
  _dir="${MINIKUBE_HOME:-$HOME/.minikube}/cache/${_os}/${_arch}/${_want}"

  if [ ! -x "$_dir/kubectl" ]; then
    mkdir -p "$_dir"
    if ! curl -fsSL -o "$_dir/kubectl" \
         "https://dl.k8s.io/release/${_want}/bin/${_os}/${_arch}/kubectl"; then
      rm -f "$_dir/kubectl"
      echo "  WARNING: could not download kubectl ${_want} (${_os}-${_arch})." >&2
      echo "  WARNING: continuing with ${_have:-no} client — bring-up may fail on version skew." >&2
      echo "  WARNING: install it manually: https://kubernetes.io/docs/tasks/tools/" >&2
      return 0
    fi
    chmod 0755 "$_dir/kubectl"
  fi
  export PATH="$_dir:$PATH"
  echo "  kubectl ${_want} active for this run (${_dir})"
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
  # docker AND minikube are local dev targets (deploy/local/*) — accept the dev
  # default; ec2/eks are remote and must set a real password.
  case "${DEPLOY_TARGET:-docker}" in docker|minikube) _is_local=true ;; *) _is_local=false ;; esac

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
        # Local-only convenience fallback so `init-platform.sh docker` can
        # still be hit-enter through. Never shown in the prompt, never
        # accepted on non-local targets.
        PLATFORM_PASSWORD="Pipeline-Builder-Dev-2026!"
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

  # Bootstrap-admin MFA exception (#8). On a fresh install the admin has no
  # second factor, so their session is limited to enrolment, sign-out and the
  # setup calls this script makes — enough for init, and nothing more. Say so,
  # because the limit is otherwise only discovered as a 403 on the dashboard.
  if [ "$(printf '%s' "$_resp" | jq -r '.data.mfaEnrollmentPending // false' 2>/dev/null)" = "true" ]; then
    echo "  NOTE: this administrator has no second factor yet, so the session can only reach"
    echo "        enrolment, sign-out and the setup calls below. Sign in to the dashboard and add"
    echo "        a passkey or an authenticator app (Settings → Security) as soon as init finishes —"
    echo "        the exception closes permanently at the first enrolment and cannot be reopened."
  fi
}

# ---------------------------------------------------------------------------
# sign_service_jwt — mint a short-lived INTERNAL SERVICE token (no Node deps)
# for the deploy's own registry pushes. Used by push-base-images.sh and
# build-plugin-images.sh to authenticate against the in-cluster image registry.
# Same shape api-core's `signServiceToken` mints, and the same one the plugin
# service uses for its runtime builds.
#
#   $1   path to the `deploy-bootstrap` EC P-256 private key (PKCS#8 PEM)
#   $2   path to the service key bundle (bundle.json) — supplies the `kid`
#   $3?  expiry seconds (default 300)
#   echoes the compact JWT; exits 1 if openssl/jq is missing or the key is not
#   in the bundle.
#
# ES256, not HMAC: since #14 every service signs with its OWN key and a verifier
# resolves the key by `kid` and then requires the token's `sub` to name that
# key's owner. So this signs as `service:deploy-bootstrap` with the deploy's own
# key (deploy/bin/service-signing-keys.sh), which is published in the bundle like
# any other service's. There is no shared secret left to sign with.
#
# It is a SERVICE principal, not a user: every token that speaks for a PERSON is
# ES256 signed only by PLATFORM, with a key this host does not have.
#
# Image-registry's auth resolver requires `organizationId` (not `orgId`) and a
# well-formed service identity (`principalType`, `token_use`, a `service:<name>`
# subject); `isAdmin`/`isSuperAdmin` gate access to `library/*` and `system/*`
# via the admin-priority rule in `token-service.ts authorizeScope`.
# ---------------------------------------------------------------------------
_b64url_jwt() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

# Hex string on $1 → raw bytes on stdout. Used to rebuild the ECDSA signature
# from the two integers `openssl asn1parse` prints, with no extra tooling.
_hex_to_bin() {
  local _h="$1" _i
  for (( _i=0; _i<${#_h}; _i+=2 )); do printf '\x'"${_h:_i:2}"; done
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

sign_service_jwt() {
  local _key="${1:?sign_service_jwt needs the deploy-bootstrap key file}"
  local _bundle="${2:?sign_service_jwt needs the service key bundle}"
  local _ttl="${3:-300}"
  command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl required for sign_service_jwt" >&2; return 1; }
  command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required for sign_service_jwt" >&2; return 1; }
  [ -f "$_key" ] || { echo "ERROR: deploy-bootstrap signing key not found: $_key" >&2; return 1; }
  [ -f "$_bundle" ] || { echo "ERROR: service key bundle not found: $_bundle" >&2; return 1; }

  local _kid _now _exp _header _payload _signing _der _rs _sig
  # The FIRST key published for deploy-bootstrap is the current one (the
  # generator writes current, then any retiring key).
  _kid="$(jq -r '.services["deploy-bootstrap"].keys[0].kid // empty' "$_bundle")"
  [ -n "$_kid" ] || { echo "ERROR: no deploy-bootstrap key in $_bundle (run deploy/bin/service-signing-keys.sh)" >&2; return 1; }

  _now=$(date +%s)
  _exp=$((_now + _ttl))
  _header="$(printf '{"alg":"ES256","typ":"JWT","kid":"%s"}' "$_kid")"
  _payload=$(printf '{"sub":"service:deploy-bootstrap","username":"deploy-bootstrap-service","email":"deploy-bootstrap@internal","principalType":"service","token_use":"access","type":"access","role":"admin","organizationId":"system","organizationName":"system","isAdmin":true,"isSuperAdmin":true,"iat":%s,"exp":%s}' "$_now" "$_exp")
  _signing="$(printf %s "$_header" | _b64url_jwt).$(printf %s "$_payload" | _b64url_jwt)"

  # openssl signs ECDSA into ASN.1 DER (SEQUENCE of two INTEGERs); JOSE wants the
  # raw r||s, each left-padded to the 32-byte curve width. `asn1parse` prints both
  # integers as hex, which is all that is needed to rebuild it.
  _der="$(mktemp)"
  printf %s "$_signing" | openssl dgst -sha256 -sign "$_key" -out "$_der" || { rm -f "$_der"; return 1; }
  _rs=""
  while read -r _int; do
    # Strip DER's sign-padding byte, then left-pad back to 64 hex chars (32 bytes).
    _int="${_int#00}"
    while [ ${#_int} -lt 64 ]; do _int="0$_int"; done
    _rs="$_rs$_int"
  done < <(openssl asn1parse -inform DER -in "$_der" | sed -n 's/.*INTEGER *://p')
  rm -f "$_der"
  [ ${#_rs} -eq 128 ] || { echo "ERROR: unexpected ECDSA signature shape (${#_rs} hex chars)" >&2; return 1; }
  _sig="$(_hex_to_bin "$_rs" | _b64url_jwt)"

  printf '%s.%s\n' "$_signing" "$_sig"
}

# ---------------------------------------------------------------------------
# step_up_token — mint a short-lived step-up token for the signed-in admin.
#
# Every service-account write (create account, issue key) is step-up gated, the
# same as creating a personal access key. A step-up token is SINGLE-USE and
# lives ~60s, so mint one immediately before each gated call.
#
#   uses: PLATFORM_BASE_URL, JWT_TOKEN, PLATFORM_PASSWORD
#   echoes the token; returns 1 (with a message on stderr) if it can't be minted.
# ---------------------------------------------------------------------------
step_up_token() {
  local _resp _token
  _resp=$(curl -X POST "${PLATFORM_BASE_URL}/api/auth/step-up" \
    -k -s \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -d "$(jq -n --arg pw "$PLATFORM_PASSWORD" '{password: $pw}')" 2>&1) || true
  _token=$(printf '%s' "$_resp" | jq -r '.data.stepUpToken // empty' 2>/dev/null) || true
  if [ -z "$_token" ]; then
    echo "ERROR: could not obtain a step-up token (is PLATFORM_PASSWORD correct?)" >&2
    return 1
  fi
  printf '%s\n' "$_token"
}

# ---------------------------------------------------------------------------
# setup_service_account_key — create (or reuse) the system-org `setup` service
# account and issue ONE short-lived key for the remaining init steps.
#
# Why: the plugin, template and compliance loads used to re-run `login` with the
# admin's PASSWORD between steps, which both kept a human credential in the
# script's environment and burned a refresh-session slot per run. A service
# account is the org's own machine identity: it holds the system org's roles, it
# takes no seat, its key expires on its own (24h by default), and every action it
# performs is audited as the ACCOUNT rather than as the operator.
#
#   uses: PLATFORM_BASE_URL, JWT_TOKEN (admin), PLATFORM_PASSWORD
#   sets: SETUP_SA_KEY (the raw pb_sa_ key), SETUP_SA_ID
#   IDEMPOTENT: an existing `setup` account is reused, and its previous keys are
#   revoked first so re-running init can never hit the 5-active-key cap.
# ---------------------------------------------------------------------------
setup_service_account_key() {
  local _ttl="${SETUP_KEY_TTL_SECONDS:-86400}"
  local _org_id _roles _role_id _resp _status _step_up _key_name _old

  _org_id=$(curl -k -s "${PLATFORM_BASE_URL}/api/organization" \
    -H "Authorization: Bearer ${JWT_TOKEN}" | jq -r '.data.organization.id // empty') || true
  if [ -z "$_org_id" ]; then
    echo "ERROR: could not resolve the admin's organization for the setup service account" >&2
    return 1
  fi

  # The setup account needs the SAME authority the admin login had, because the
  # loads publish shared content (published compliance rules, policy templates).
  # In the system org that is the Super Admin role; only a platform superadmin
  # may grant it, which the bootstrap admin is.
  _roles=$(curl -k -s "${PLATFORM_BASE_URL}/api/organization/${_org_id}/roles" \
    -H "Authorization: Bearer ${JWT_TOKEN}") || true
  _role_id=$(printf '%s' "$_roles" | jq -r '[.data.roles[]? | select(.grantsRole == "superadmin")][0].id // empty')
  if [ -z "$_role_id" ]; then
    _role_id=$(printf '%s' "$_roles" | jq -r '[.data.roles[]? | select(.grantsRole == "admin")][0].id // empty')
  fi
  if [ -z "$_role_id" ]; then
    echo "ERROR: the system organization has no admin role to give the setup service account" >&2
    return 1
  fi

  _step_up=$(step_up_token) || return 1
  _resp=$(curl -X POST "${PLATFORM_BASE_URL}/api/organization/${_org_id}/service-accounts" \
    -k -s -w '\n%{http_code}' \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -H "X-Step-Up-Token: ${_step_up}" \
    -d "$(jq -n --arg role "$_role_id" \
      '{name: "setup", description: "Platform bootstrap automation (init-platform.sh)", roleIds: [$role]}')") || true
  _status=$(printf '%s' "$_resp" | tail -n1)
  SETUP_SA_ID=$(printf '%s' "$_resp" | sed '$d' | jq -r '.data.serviceAccount.id // empty')

  case "$_status" in
    20*) echo "  Created the 'setup' service account." ;;
    409)
      # Already there from a previous run — reuse it (idempotent).
      SETUP_SA_ID=$(curl -k -s "${PLATFORM_BASE_URL}/api/organization/${_org_id}/service-accounts" \
        -H "Authorization: Bearer ${JWT_TOKEN}" \
        | jq -r '[.data.serviceAccounts[]? | select(.name == "setup")][0].id // empty')
      echo "  Reusing the existing 'setup' service account."
      ;;
    *)
      echo "ERROR: could not create the setup service account (HTTP $_status)" >&2
      return 1 ;;
  esac
  if [ -z "$SETUP_SA_ID" ]; then
    echo "ERROR: could not resolve the setup service account id" >&2
    return 1
  fi

  # Revoke any key left by an earlier run: init issues exactly ONE key per run,
  # and the per-account cap (5 active keys) must never be what fails a re-run.
  for _old in $(curl -k -s "${PLATFORM_BASE_URL}/api/organization/${_org_id}/service-accounts/${SETUP_SA_ID}" \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    | jq -r '[.data.serviceAccount.keys[]? | select(.status == "active") | .id][]'); do
    curl -X DELETE -k -s -o /dev/null \
      "${PLATFORM_BASE_URL}/api/organization/${_org_id}/service-accounts/${SETUP_SA_ID}/keys/${_old}" \
      -H "Authorization: Bearer ${JWT_TOKEN}" || true
  done

  _key_name="init-$(date +%Y%m%d%H%M%S)"
  _step_up=$(step_up_token) || return 1
  _resp=$(curl -X POST "${PLATFORM_BASE_URL}/api/organization/${_org_id}/service-accounts/${SETUP_SA_ID}/keys" \
    -k -s \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -H "X-Step-Up-Token: ${_step_up}" \
    -d "$(jq -n --arg name "$_key_name" --argjson ttl "$_ttl" '{name: $name, expiresIn: $ttl}')") || true
  SETUP_SA_KEY=$(printf '%s' "$_resp" | jq -r '.data.key // empty')
  if [ -z "$SETUP_SA_KEY" ]; then
    echo "ERROR: could not issue a key for the setup service account" >&2
    return 1
  fi
  echo "  Issued a ${_ttl}s setup key (shown once; it expires on its own)."
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
  local _img_repo _img_tag _api_result
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
  # Fail clearly if the plugins tree is absent — otherwise the `cd` below prints
  # a cryptic "No such file or directory", the category list comes back empty,
  # and the operator just sees "No valid categories selected" with no cause.
  # `deploy/plugins/` is tracked in git, so a missing dir means an incomplete
  # checkout (sparse/partial clone) rather than a config problem.
  if [ ! -d "$_plugins_dir" ]; then
    echo "ERROR: plugins directory not found at: $_plugins_dir" >&2
    echo "  'deploy/plugins/' is tracked in git but missing here — this looks like an incomplete checkout." >&2
    echo "  Re-clone or sync the repo so deploy/plugins/ is present, then re-run this step." >&2
    return 1
  fi
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
  # Reached only if the loop never ran (UPLOAD_RETRIES < 1 / non-numeric) — treat
  # as a failure rather than returning the loop condition's spurious exit code.
  echo -e "  ${RED}FAIL${NC} $_label (no attempts made; check UPLOAD_RETRIES)" >&2
  return 1
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
