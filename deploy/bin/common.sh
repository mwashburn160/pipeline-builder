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
#   • No `mapfile`/`readarray` (bash 4+) — read line-by-line with `while IFS= read -r`.
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

# Every MinIO bucket the stack creates — THE canonical list. backup.sh/restore.sh
# mirror these by default, and each target's minio-init (compose + the k8s
# minio.yaml files) plus the eks backup CronJob must create/mirror the same set
# (deploy contract test). A bucket missing here is silently left out of backups.
# shellcheck disable=SC2034
PB_MINIO_BUCKETS="message-attachments registry loki thanos plugins plugin-quarantine audit-heads"

# THE Kubernetes version for the minikube-backed targets (local/minikube and
# aws/ec2). Both the cluster (`minikube start --kubernetes-version`) and the
# kubectl each target installs come from this one value, so a client can never
# drift outside kubectl's supported ±1-minor skew from its own cluster.
#
# ec2 previously pinned NEITHER: it took minikube's bundled default for the
# cluster and `dl.k8s.io/release/stable.txt` for kubectl — upstream's newest,
# which is already two minors ahead here. Only applies when a cluster is
# CREATED; an existing one keeps the version it was built with.
#
# aws/eks is deliberately NOT covered: EKS is a managed control plane on its own
# release track, pinned separately as EKS_VERSION in its setup.sh.
# shellcheck disable=SC2034
PB_K8S_VERSION="${PB_K8S_VERSION:-v1.35.1}"

# ---------------------------------------------------------------------------
# mc_setup_aliases — configure the two MinIO client aliases used by backup/restore:
#   pbsrc = this deploy's MinIO (MINIO_ENDPOINT + root creds)
#   pbdst = the backup target    (MINIO_BACKUP_TARGET_URL + its creds)
#   $1 = mc --config-dir (isolated per-run config). Exits 2 on failure (sourced,
#   so the exit propagates to the caller, matching the previous inline behavior).
# ---------------------------------------------------------------------------
mc_setup_aliases() {
  export MC_HOST_pbsrc MC_HOST_pbdst
  MC_HOST_pbsrc="$(_mc_host_url "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" source)" || exit 2
  MC_HOST_pbdst="$(_mc_host_url "$MINIO_BACKUP_TARGET_URL" "$MINIO_BACKUP_TARGET_ACCESS_KEY" "$MINIO_BACKUP_TARGET_SECRET_KEY" target)" || exit 2
}

# `MC_HOST_<alias>=<scheme>://<key>:<secret>@<host>` is mc's own env-var form of
# an alias, and it is why `mc alias set` is not used: that call put the MinIO
# ROOT credentials and the backup target's credentials in the process argv,
# readable by any local user via `ps` for the life of the call. The environment
# is not world-readable, so the same alias arrives without that exposure.
#
# The credentials are URL-ENCODED: ours are alphanumeric (gen-env-secrets.sh
# strips `=+/`), but MINIO_BACKUP_TARGET_* are operator-supplied and a `/` or `@`
# in a secret would otherwise silently truncate the authority and authenticate
# as the wrong principal.
_mc_host_url() {
  local _endpoint="$1" _key="$2" _secret="$3" _what="$4"
  case "$_endpoint" in
    http://*|https://*) ;;
    *) echo "ERROR: MinIO $_what endpoint must start with http:// or https:// (got '${_endpoint}')" >&2; return 1 ;;
  esac
  if [ -z "$_key" ] || [ -z "$_secret" ]; then
    echo "ERROR: MinIO $_what credentials are empty" >&2; return 1
  fi
  printf '%s://%s:%s@%s' \
    "${_endpoint%%://*}" "$(_urlencode "$_key")" "$(_urlencode "$_secret")" "${_endpoint#*://}"
}

# Percent-encode a string for use in a URL's userinfo. `jq -Rr @uri` rather than
# a shell loop: jq is already a hard preflight requirement for every script that
# reaches here, and a pure-bash encoder would have to special-case the locale.
_urlencode() { printf '%s' "$1" | jq -Rr '@uri'; }

# ---------------------------------------------------------------------------
# get_spec_field — extract a top-level field from a YAML file (e.g. plugin-spec.yaml)
#   $1 field name   $2 YAML file path
#   Echoes the value (trimmed), empty string if not found
# ---------------------------------------------------------------------------
get_spec_field() {
  # Trim the leading "field:" + spaces AND any trailing whitespace, including a
  # trailing CR, so CRLF-edited specs don't yield values with a stray \r.
  grep "^${1}:" "$2" 2>/dev/null | head -1 | sed -E "s/^${1}:[[:space:]]*//; s/[[:space:]]+$//"
  # An ABSENT field is a normal answer ("" per the contract above), not a
  # failure. Without this the pipeline hands back grep's 1, and a caller doing
  # `v=$(get_spec_field …)` under `set -e` dies AT THE ASSIGNMENT — before it can
  # report which plugin is at fault. `imageTag:` is absent for every plugin that
  # has never been built, so that abort was the normal path, not an edge case.
  return 0
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
# fetch_verified <url> <sha256> <dest> — download <url> to <dest> and fail closed
# unless its SHA-256 equals <sha256>. Every binary the deploy scripts install
# from a release page goes through this (pinned VERSION + SHA-256), so a swapped
# or truncated release asset stops the run instead of being executed. <dest> is
# only written on a match; a mismatch leaves nothing behind. Returns non-zero on
# download failure or mismatch (callers decide whether that is fatal).
# ---------------------------------------------------------------------------
fetch_verified() {
  local _url="$1" _want="$2" _dest="$3" _tmp _got
  _tmp="$(mktemp)" || return 1
  if ! curl -fsSL --retry 3 -o "$_tmp" "$_url"; then
    echo "ERROR: download failed: $_url" >&2
    rm -f "$_tmp"; return 1
  fi
  _got="$(sha256_hash < "$_tmp")"
  if [ "$_got" != "$_want" ]; then
    echo "ERROR: SHA-256 mismatch for $_url (got $_got, want $_want)" >&2
    rm -f "$_tmp"; return 1
  fi
  mv -f "$_tmp" "$_dest"
}

# Host OS/arch in release-asset spelling: _pb_os = linux|darwin, _pb_arch = amd64|arm64.
_pb_platform() {
  _pb_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  _pb_arch="$(uname -m)"; case "$_pb_arch" in x86_64|amd64) _pb_arch=amd64 ;; aarch64|arm64) _pb_arch=arm64 ;; esac
}

# ---------------------------------------------------------------------------
# ensure_eksctl — install the pinned eksctl if none is on PATH (a prereq, like
# kubectl). SHARED by eks setup.sh + shutdown.sh. To bump: change the version
# and the four hashes together, from the release's eksctl_checksums.txt.
# ---------------------------------------------------------------------------
EKSCTL_VERSION="v0.230.0"
ensure_eksctl() {
  command -v eksctl >/dev/null 2>&1 && return 0
  local _os _sum _bindir _tmp
  _pb_platform
  case "${_pb_os}-${_pb_arch}" in
    linux-amd64)  _os=Linux  _sum=a2060956f117c3065abafda5c1f681679b9c3716675d70ce4ffff46033b02c35 ;;
    linux-arm64)  _os=Linux  _sum=21afe8a1e38f0e8153a1f27ff7af6b90e309a0411a1438139463dac2f866674d ;;
    darwin-amd64) _os=Darwin _sum=9c169be56572dae079dc1e5e2a6efff83c4cc6fc8507e54d0a6e8f4ef14df312 ;;
    darwin-arm64) _os=Darwin _sum=1412b7ea32efab8141c4c7ccdf96690814d659accefdf72e4e6277ea5c87470c ;;
    *) echo "ERROR: no pinned eksctl for ${_pb_os}-${_pb_arch} — install eksctl manually." >&2; return 1 ;;
  esac
  echo "  eksctl not found — installing ${EKSCTL_VERSION}..."
  _bindir=/usr/local/bin; [ -w "$_bindir" ] || _bindir="$HOME/.local/bin"; mkdir -p "$_bindir"
  _tmp="$(mktemp -d)"
  if ! fetch_verified "https://github.com/eksctl-io/eksctl/releases/download/${EKSCTL_VERSION}/eksctl_${_os}_${_pb_arch}.tar.gz" \
         "$_sum" "$_tmp/eksctl.tgz" \
      || ! tar -xzf "$_tmp/eksctl.tgz" -C "$_tmp" eksctl; then
    rm -rf "$_tmp"; return 1
  fi
  install -m 0755 "$_tmp/eksctl" "$_bindir/eksctl"
  rm -rf "$_tmp"
  case ":$PATH:" in *":$_bindir:"*) ;; *) PATH="$_bindir:$PATH"; export PATH ;; esac
  echo "  installed eksctl ${EKSCTL_VERSION} to $_bindir"
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
# ensure_istioctl <version> — guarantee istioctl EXACTLY <version> is
# on PATH, auto-downloading <version> and installing it to /usr/local/bin when the
# host has none or a different version. SHARED by every target's mesh install so istioctl is
# handled identically everywhere (minikube / ec2 / eks). Uses sudo only when
# /usr/local/bin isn't already writable (root — e.g. ec2 first boot — needs none).
# OS/arch aware (linux|osx, amd64|arm64). Usage: `ensure_istioctl "$ISTIO_VERSION"`.
# ---------------------------------------------------------------------------
ensure_istioctl() {
  local _want="${1:?ensure_istioctl needs an ISTIO_VERSION}"
  # Already have EXACTLY the wanted istioctl on PATH? Use it as-is. Any other
  # version is replaced: `istioctl install` deploys ITS OWN version of istiod /
  # ztunnel / istio-cni, so a newer-or-older client silently installs a mesh
  # that differs from ISTIO_VERSION (and from the pinned SHA below).
  local _probe
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
    _have="$(KUBECONFIG=/dev/null $_probe 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  fi
  if [ "$_have" = "$_want" ]; then
    return 0
  elif [ -n "$_have" ]; then
    echo "  istioctl $_have != ISTIO_VERSION $_want — installing $_want..."
  else
    echo "  istioctl not found — installing $_want..."
  fi
  # Pinned SHA-256 per version × platform (from the release's
  # istioctl-<ver>-<os>-<arch>.tar.gz.sha256). An ISTIO_VERSION with no pinned
  # hash is refused rather than installed unverified — add its four hashes here
  # when bumping ISTIO_VERSION in the targets' setup/startup scripts.
  local _os _tmp _sum=""
  _pb_platform
  _os="$_pb_os"; case "$_os" in darwin) _os=osx ;; esac
  case "${_want}:${_os}-${_pb_arch}" in
    1.30.3:linux-amd64) _sum=7b8559fb0a91466a3ff726ad291bedbcf5e4a24f1d9108dbe51a99e11f2010c8 ;;
    1.30.3:linux-arm64) _sum=58102643b66d49232a51fdd130f5a207e9e1b40ef1230930b016bdeb41261560 ;;
    1.30.3:osx-amd64)   _sum=ba7bbba3a07cdc9acad26616d089c497d2d043eb72621ed2ab5c771f56daec2b ;;
    1.30.3:osx-arm64)   _sum=b52f492e6c2306c9d209d2a30534e546c63f2623d6c150f0153c566c819299f0 ;;
  esac
  if [ -z "$_sum" ]; then
    echo "ERROR: no pinned SHA-256 for istioctl ${_want} (${_os}-${_pb_arch}) — add it to ensure_istioctl in deploy/bin/common.sh." >&2
    exit 1
  fi
  _tmp="$(mktemp -d)"
  if ! fetch_verified "https://github.com/istio/istio/releases/download/${_want}/istioctl-${_want}-${_os}-${_pb_arch}.tar.gz" \
         "$_sum" "$_tmp/istioctl.tgz" \
      || ! tar -xzf "$_tmp/istioctl.tgz" -C "$_tmp" istioctl 2>/dev/null; then
    echo "ERROR: failed to install istioctl ${_want} (${_os}-${_pb_arch})." >&2
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
    # The version tracks the running cluster, so there is no static hash to pin;
    # verify against the .sha256 dl.k8s.io publishes beside each binary (the
    # upstream-documented check). A mismatch leaves nothing in the cache dir.
    local _base="https://dl.k8s.io/release/${_want}/bin/${_os}/${_arch}/kubectl" _sum
    if ! _sum="$(curl -fsSL "${_base}.sha256")" \
        || ! fetch_verified "$_base" "${_sum%% *}" "$_dir/kubectl"; then
      rm -f "$_dir/kubectl"
      echo "  WARNING: could not download a verified kubectl ${_want} (${_os}-${_arch})." >&2
      # With a skewed-but-present client there is something to fall back to, so
      # warn and let the caller proceed. With NO kubectl at all there is nothing
      # to degrade to — every later `kubectl` would fail one by one — so fail
      # here, where the cause is still on screen.
      if [ -z "$_have" ]; then
        echo "ERROR: no kubectl on PATH and none could be installed — install it and re-run:" >&2
        echo "       https://kubernetes.io/docs/tasks/tools/" >&2
        return 1
      fi
      echo "  WARNING: continuing with ${_have} client — bring-up may fail on version skew." >&2
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
# outputs `image.tar` and `plugin.zip`, and config.yaml — see below),
# plus the plugin-spec.yaml buildArgs.
# Files are listed in sorted order so the hash is stable across runs.
#
# Why hash the whole directory: hashing only the Dockerfile + buildArgs would
# ship stale `image.tar`s when COPY'd files (entrypoint scripts, configs,
# sibling sources) change. Anything visible to the build context bumps the tag.
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
# THE local-dev admin password, in ONE place. init-platform.sh both defaults to
# it and refuses it off-local, and prompt_credentials accepts it as the
# hit-enter fallback — three uses that must never drift apart, which is exactly
# what three copies of a string literal invite.
PB_DEV_PASSWORD='Pipeline-Builder-Dev-2026!'

prompt_credentials() {
  local _is_local=false _host
  # Two conditions, because DEPLOY_TARGET alone is not enough: the scripts that
  # actually call this (load-plugins.sh / load-templates.sh / load-compliance.sh
  # via require_auth) never set DEPLOY_TARGET, so it falls back to common.sh's
  # `docker` default and the "remote targets must type a password" rule below
  # could never fire — including when the operator points one of them straight
  # at a live ec2/eks URL. So the deploy target must say local (docker|minikube)
  # AND the platform URL must actually be a loopback address.
  _host="${PLATFORM_BASE_URL:-}"; _host="${_host#*://}"; _host="${_host%%/*}"; _host="${_host%%:*}"
  case "${DEPLOY_TARGET:-docker}" in
    docker|minikube)
      case "$_host" in localhost|127.0.0.1|'[::1]') _is_local=true ;; esac ;;
  esac

  if [ -z "${PLATFORM_IDENTIFIER:-}" ]; then
    if [ "$_is_local" = true ]; then
      printf "Identifier [admin@internal]: "
      read -r PLATFORM_IDENTIFIER
      PLATFORM_IDENTIFIER="${PLATFORM_IDENTIFIER:-admin@internal}"
    else
      printf "Identifier: "
      read -r PLATFORM_IDENTIFIER
      [ -z "$PLATFORM_IDENTIFIER" ] && { echo "ERROR: identifier required for ${PLATFORM_BASE_URL} (target=${DEPLOY_TARGET})" >&2; return 1; }
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
        PLATFORM_PASSWORD="$PB_DEV_PASSWORD"
      else
        echo "ERROR: password required for ${PLATFORM_BASE_URL} (target=${DEPLOY_TARGET}) — the local-dev default is" >&2
        echo "       only accepted for a docker/minikube target on a loopback URL." >&2
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
  local _resp _err _challenge _code
  _resp=$(curl -X POST "${PLATFORM_BASE_URL}/api/auth/login" \
    -k -s \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg id "$PLATFORM_IDENTIFIER" --arg pw "$PLATFORM_PASSWORD" \
      '{identifier: $id, password: $pw}')" 2>&1) || true

  # SECOND FACTOR. Once the admin has an authenticator app, the password alone
  # buys a CHALLENGE rather than a session — and the setup calls below need an
  # MFA-grade one, because the bootstrap exception that stood in for it closed at
  # that first enrolment. So finish the challenge here: the code comes from
  # PLATFORM_TOTP_CODE, or from a prompt when someone is watching.
  _challenge=$(printf '%s' "$_resp" | jq -r '.data.challengeId // empty' 2>/dev/null) || true
  if [ -n "$_challenge" ]; then
    _code="${PLATFORM_TOTP_CODE:-}"
    if [ -z "$_code" ] && [ -t 0 ]; then
      printf "  Two-factor code for %s (or a recovery code): " "$PLATFORM_IDENTIFIER"
      read -r _code
    fi
    if [ -z "$_code" ]; then
      echo "Login needs a second factor — this administrator has an authenticator app." >&2
      echo "  Set PLATFORM_TOTP_CODE to a current code (or a recovery code) and re-run." >&2
      return 1
    fi
    _resp=$(curl -X POST "${PLATFORM_BASE_URL}/api/auth/mfa/verify" \
      -k -s \
      -H 'Content-Type: application/json' \
      -d "$(jq -n --arg id "$_challenge" --arg code "$_code" '{challengeId: $id, code: $code}')" 2>&1) || true
  fi

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
# _api_error BODY — " (CODE: message)" from a platform error response, or "" when
# the body carries neither. Used in failure messages so the operator reads WHICH
# gate refused rather than just a status number.
_api_error() {
  printf '%s' "$1" | jq -r 'if (.code // .message) then " (" + ((.code // "error")|tostring) + ": " + ((.message // "no message")|tostring) + ")" else "" end' 2>/dev/null || true
}

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
# _issue_service_account_key — create (or reuse) a system-org service account
# holding ONE role, revoke its previous keys, and issue a single fresh key.
#
#   $1 org id  $2 account name  $3 description  $4 role id  $5 key TTL (s)
#   uses: PLATFORM_BASE_URL, JWT_TOKEN (admin), PLATFORM_PASSWORD (step-up)
#   sets: _SA_ID, _SA_KEY
#   IDEMPOTENT: an existing account of that name is reused, and its previous
#   keys are revoked first so re-running init never hits the 5-active-key cap.
# ---------------------------------------------------------------------------
_issue_service_account_key() {
  local _org_id="$1" _name="$2" _desc="$3" _role_id="$4" _ttl="$5"
  local _resp _status _body _step_up _key_name _old
  _SA_ID=""; _SA_KEY=""

  _step_up=$(step_up_token) || return 1
  _resp=$(curl -X POST "${PLATFORM_BASE_URL}/api/organization/${_org_id}/service-accounts" \
    -k -s -w '\n%{http_code}' \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -H "X-Step-Up-Token: ${_step_up}" \
    -d "$(jq -n --arg name "$_name" --arg desc "$_desc" --arg role "$_role_id" \
      '{name: $name, description: $desc, roleIds: [$role]}')") || true
  _status=$(printf '%s' "$_resp" | tail -n1)
  _body=$(printf '%s' "$_resp" | sed '$d')
  # `|| true` on EVERY jq-from-HTTP-body substitution in this file: a gateway
  # 502/504 answers with an HTML page, jq exits non-zero on it, and under the
  # caller's `set -e` a bare `X=$(… | jq …)` kills the whole init at the
  # ASSIGNMENT — before the explicit, actionable error below ever prints. The
  # empty value falls through to those checks instead.
  _SA_ID=$(printf '%s' "$_body" | jq -r '.data.serviceAccount.id // empty' 2>/dev/null) || true

  case "$_status" in
    20*) echo "  Created the '${_name}' service account." ;;
    409)
      # Already there from a previous run — reuse it (idempotent).
      _SA_ID=$(curl -k -s "${PLATFORM_BASE_URL}/api/organization/${_org_id}/service-accounts" \
        -H "Authorization: Bearer ${JWT_TOKEN}" \
        | jq -r --arg name "$_name" '[.data.serviceAccounts[]? | select(.name == $name)][0].id // empty' 2>/dev/null) || true
      echo "  Reusing the existing '${_name}' service account."
      ;;
    *)
      # Print the server's own code and message: a bare status number here cost a
      # debugging session once already (a 401 was the assurance gate, not the
      # token), and the platform always says which gate refused.
      echo "ERROR: could not create the ${_name} service account (HTTP $_status$(_api_error "$_body"))" >&2
      return 1 ;;
  esac
  if [ -z "$_SA_ID" ]; then
    echo "ERROR: could not resolve the ${_name} service account id" >&2
    return 1
  fi

  # Revoke any key left by an earlier run: init issues exactly ONE key per run,
  # and the per-account cap (5 active keys) must never be what fails a re-run.
  for _old in $(curl -k -s "${PLATFORM_BASE_URL}/api/organization/${_org_id}/service-accounts/${_SA_ID}" \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    | jq -r '[.data.serviceAccount.keys[]? | select(.status == "active") | .id][]'); do
    curl -X DELETE -k -s -o /dev/null \
      "${PLATFORM_BASE_URL}/api/organization/${_org_id}/service-accounts/${_SA_ID}/keys/${_old}" \
      -H "Authorization: Bearer ${JWT_TOKEN}" || true
  done

  _key_name="init-$(date +%Y%m%d%H%M%S)"
  _step_up=$(step_up_token) || return 1
  _resp=$(curl -X POST "${PLATFORM_BASE_URL}/api/organization/${_org_id}/service-accounts/${_SA_ID}/keys" \
    -k -s \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -H "X-Step-Up-Token: ${_step_up}" \
    -d "$(jq -n --arg name "$_key_name" --argjson ttl "$_ttl" '{name: $name, expiresIn: $ttl}')") || true
  _SA_KEY=$(printf '%s' "$_resp" | jq -r '.data.key // empty' 2>/dev/null) || true
  if [ -z "$_SA_KEY" ]; then
    echo "ERROR: could not issue a key for the ${_name} service account$(_api_error "$_resp")" >&2
    return 1
  fi
  echo "  Issued a ${_ttl}s ${_name} key (shown once; it expires on its own)."
}

# _admin_org_id — the admin's active org (the system org during init).
_admin_org_id() {
  curl -k -s "${PLATFORM_BASE_URL}/api/organization" \
    -H "Authorization: Bearer ${JWT_TOKEN}" | jq -r '.data.organization.id // empty'
}

# ---------------------------------------------------------------------------
# setup_service_account_key — create (or reuse) the system-org `setup` service
# account and issue ONE short-lived key for the remaining init steps.
#
# Why: re-running `login` with the admin's PASSWORD between the plugin,
# template and compliance loads would keep a human credential in the script's
# environment and burn a refresh-session slot per run. A service
# account is the org's own machine identity: it holds the system org's roles, it
# takes no seat, its key expires on its own (24h by default), and every action it
# performs is audited as the ACCOUNT rather than as the operator.
#
#   uses: PLATFORM_BASE_URL, JWT_TOKEN (admin), PLATFORM_PASSWORD
#   sets: SETUP_SA_KEY (the raw pb_sa_ key), SETUP_SA_ID
# ---------------------------------------------------------------------------
setup_service_account_key() {
  local _org_id _roles _role_id
  _org_id=$(_admin_org_id) || true
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
  _role_id=$(printf '%s' "$_roles" | jq -r '[.data.roles[]? | select(.grantsRole == "superadmin")][0].id // empty' 2>/dev/null) || true
  if [ -z "$_role_id" ]; then
    _role_id=$(printf '%s' "$_roles" | jq -r '[.data.roles[]? | select(.grantsRole == "admin")][0].id // empty' 2>/dev/null) || true
  fi
  if [ -z "$_role_id" ]; then
    echo "ERROR: the system organization has no admin role to give the setup service account" >&2
    return 1
  fi

  _issue_service_account_key "$_org_id" setup "Platform bootstrap automation (init-platform.sh)" "$_role_id" "${SETUP_KEY_TTL_SECONDS:-86400}" || return 1
  SETUP_SA_ID="$_SA_ID"
  SETUP_SA_KEY="$_SA_KEY"
}

# ---------------------------------------------------------------------------
# official_loader_service_account_key — the dedicated OFFICIAL CATALOG LOADER
# identity: the system-org service account
# `official-catalog-loader`, holding ONLY a custom "Official Catalog Loader"
# role (plugins:read, plugins:write, plugins:publish). load-plugins.sh uploads
# the Official catalog as this account with `publishRequest=true`, so every
# plugin becomes a publish REQUEST: the one-time bootstrap exception approves
# the initial catalog, and the seeded Official auto-approval rule approves later
# gate-green patch/minor updates — only because they come from this account,
# never from a person. Anything riskier waits for two Ecosystem Managers.
#
#   uses: PLATFORM_BASE_URL, PLATFORM_PASSWORD,
#         JWT_TOKEN   (admin) — the org/role READS and, inside
#                     _issue_service_account_key, the step-up-gated
#                     service-account writes;
#         SETUP_SA_KEY — the one WRITE that the admin session cannot make:
#                     creating the custom role (see below). Call
#                     setup_service_account_key first.
#   sets: LOADER_SA_KEY, LOADER_SA_ID
# ---------------------------------------------------------------------------
OFFICIAL_LOADER_ACCOUNT="official-catalog-loader"
OFFICIAL_LOADER_ROLE="Official Catalog Loader"

official_loader_service_account_key() {
  local _org_id _roles _role_id _resp _status _body
  _org_id=$(_admin_org_id) || true
  if [ -z "$_org_id" ]; then
    echo "ERROR: could not resolve the system organization for the ${OFFICIAL_LOADER_ACCOUNT} account" >&2
    return 1
  fi

  _roles=$(curl -k -s "${PLATFORM_BASE_URL}/api/organization/${_org_id}/roles" \
    -H "Authorization: Bearer ${JWT_TOKEN}") || true
  _role_id=$(printf '%s' "$_roles" | jq -r --arg name "$OFFICIAL_LOADER_ROLE" '[.data.roles[]? | select(.name == $name)][0].id // empty' 2>/dev/null) || true
  if [ -z "$_role_id" ]; then
    # CREATE THE ROLE AS THE `setup` SERVICE ACCOUNT, not as the admin.
    #
    # On a fresh install the admin's session is the bootstrap-MFA one
    # (`mfaEnrollmentPending`), and platform's BOOTSTRAP_SESSION_ALLOWLIST
    # (platform/src/helpers/bootstrap-admin.ts) admits only `GET .../roles` —
    # so the read above passes and this POST comes back
    # `403 MFA_ENROLLMENT_REQUIRED`, failing every fresh init.
    #
    # The setup account is the right principal for it, not a workaround:
    # `POST /organization/:id/roles` is requireAuth + requirePermission(
    # 'roles:manage') + requireOrgAdminAssurance({ machines: 'allow' }) with NO
    # step-up, the setup account holds the system org's superadmin-granting role
    # (which carries every permission), and a machine principal never carries
    # the enrolment flag. Hence no X-Step-Up-Token here either — a service
    # account cannot earn one, and this route does not ask for one.
    #
    # NEVER fall back to JWT_TOKEN: that just reproduces the 403 further on.
    if [ -z "${SETUP_SA_KEY:-}" ]; then
      echo "ERROR: SETUP_SA_KEY is empty — call setup_service_account_key before ${OFFICIAL_LOADER_ACCOUNT}." >&2
      echo "  The '${OFFICIAL_LOADER_ROLE}' role must be created by the setup service account: a fresh" >&2
      echo "  install's admin session is MFA-enrolment-limited and cannot POST /organization/:id/roles." >&2
      return 1
    fi
    _resp=$(curl -X POST "${PLATFORM_BASE_URL}/api/organization/${_org_id}/roles" \
      -k -s -w '\n%{http_code}' \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer ${SETUP_SA_KEY}" \
      -d "$(jq -n --arg name "$OFFICIAL_LOADER_ROLE" \
        '{name: $name, description: "Uploads the Official plugin catalog as publish requests (load-plugins.sh)", permissions: ["plugins:read", "plugins:write", "plugins:publish"]}')") || true
    _status=$(printf '%s' "$_resp" | tail -n1)
    _body=$(printf '%s' "$_resp" | sed '$d')
    _role_id=$(printf '%s' "$_body" | jq -r '.data.role.id // .data.id // empty' 2>/dev/null) || true
    if [ -z "$_role_id" ]; then
      echo "ERROR: could not create the '${OFFICIAL_LOADER_ROLE}' role (HTTP $_status$(_api_error "$_body"))" >&2
      return 1
    fi
    echo "  Created the '${OFFICIAL_LOADER_ROLE}' role."
  fi

  _issue_service_account_key "$_org_id" "$OFFICIAL_LOADER_ACCOUNT" \
    "Official plugin catalog loader (load-plugins.sh): submits publish requests" \
    "$_role_id" "${LOADER_KEY_TTL_SECONDS:-86400}" || return 1
  LOADER_SA_ID="$_SA_ID"
  LOADER_SA_KEY="$_SA_KEY"
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
# _curl_authed — curl, with the bearer token supplied OUT OF BAND.
#
# `-H "Authorization: Bearer $JWT_TOKEN"` puts the token in the process argv,
# where any local user's `ps` can read it for the life of the request — the same
# reasoning push-base-images.sh documents for routing its JWT through the
# environment. curl's `--config` takes the header from a file instead, and a
# process substitution keeps that file off disk entirely: `printf` is a shell
# BUILTIN, so the subshell never execs and never gets an argv of its own.
#
# The substitution is re-created per call because a config fd can only be read
# once — hoisting it out of curl_with_retry's retry loop would send the header
# on the first attempt and an empty config on every retry.
#
# Callers must NOT pass their own Authorization header; set JWT_TOKEN instead.
# ---------------------------------------------------------------------------
_curl_authed() {
  if [ -n "${JWT_TOKEN:-}" ]; then
    curl --config <(printf 'header = "Authorization: Bearer %s"\n' "$JWT_TOKEN") "$@"
  else
    curl "$@"
  fi
}

# ---------------------------------------------------------------------------
# curl_with_retry — POST with retry loop on retryable HTTP status codes
#   Sends `Authorization: Bearer $JWT_TOKEN` automatically (see _curl_authed).
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
    _status=$(_curl_authed -s -o "$_out" -w "%{http_code}" --insecure "$@" 2>/dev/null || echo "000")
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
