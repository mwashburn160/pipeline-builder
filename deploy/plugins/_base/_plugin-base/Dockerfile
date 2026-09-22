# Pipeline Builder — Shared Plugin Base Image
#
# Used as the FROM by every plugin Dockerfile. Centralizes the system deps
# that ~95% of plugins were redundantly installing in their own RUN blocks
# (git, curl, jq, ca-certificates, gnupg, etc.).
#
# Build target tag: pipeline-plugin-base:24.04
#
# Why this base exists:
#   - 80MB layer × 123 plugins = ~10GB redundancy on disk + transfer + S3
#   - One place to patch a CVE in a base dep (vs. 123 PRs)
#   - Eliminates ~10 lines of boilerplate per plugin Dockerfile
#   - Faster cold builds — apt-get update + install runs once, not 123 times
#
# Build orchestration:
#   build-plugin-images.sh detects this directory (prefixed with `_`),
#   builds it FIRST, tags it locally, then iterates over the real plugins.
#   The `_` prefix excludes it from the upload/load flow — operators don't
#   see it as a plugin in the dashboard.
#
# Stability rules:
#   - Pin the Ubuntu tag (24.04 — Noble Numbat LTS, supported until 2029)
#   - Keep the dep list MINIMAL — anything plugin-specific belongs in that
#     plugin's Dockerfile, not here. Adding to this list bloats every image.

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts during apt-get install in any consumer.
ENV DEBIAN_FRONTEND=noninteractive

# APT mirror selection — PRIMARY = default canonical, FAILOVER = regional mirror.
# The canonical archive.ubuntu.com / security.ubuntu.com stay the primary sources
# (reliable, always-consistent source of truth). When the orchestrator passes
# `--build-arg APT_MIRROR=<region>.ec2.archive.ubuntu.com` (running inside EC2),
# the regional mirror is APPENDED as a second URI — a failover apt uses only when
# the primary errors. apt tries URIs left-to-right, so we keep the reliable
# default in front and never repeat the earlier failure where an inconsistent
# regional mirror (caught mid-sync) was the SOLE source and hard-failed every
# install with "Depends: X but it is not going to be installed".
#
# This mutation persists in the image layer, so EVERY plugin Dockerfile that
# uses `FROM pipeline-plugin-base:24.04` inherits the failover automatically —
# no per-plugin Dockerfile change needed.
#
# Both the archive (main/universe/multiverse/restricted) and security suites get
# the regional failover appended; Canonical's EC2 mirrors host both.
#
# Set at build time:
#   docker build --build-arg APT_MIRROR=us-east-1.ec2.archive.ubuntu.com ...
# Default (no arg) leaves only the canonical mirror for local dev / non-AWS builds.
ARG APT_MIRROR=""
RUN if [ -n "$APT_MIRROR" ]; then \
      # Deb822 (Ubuntu 24.04 default): append the regional mirror as a SECOND URI
      # on each `URIs:` line, so canonical is tried first and the mirror is the
      # failover. `.*http://…/ubuntu[^[:space:]]*` captures the canonical URI (incl.
      # any trailing slash); \1 keeps it, then we append the mirror URI after it.
      _f=/etc/apt/sources.list.d/ubuntu.sources; \
      if [ -f "$_f" ]; then \
        sed -i -E \
          -e "s|^(URIs:[[:space:]].*http://archive\.ubuntu\.com/ubuntu[^[:space:]]*)|\1 http://${APT_MIRROR}/ubuntu|" \
          -e "s|^(URIs:[[:space:]].*http://security\.ubuntu\.com/ubuntu[^[:space:]]*)|\1 http://${APT_MIRROR}/ubuntu|" \
          "$_f"; \
      fi; \
      # Legacy one-line format (rare on noble): a `deb` line can't hold two URIs,
      # so DUPLICATE each canonical line with a mirror variant right AFTER it —
      # canonical stays primary, apt falls back to the mirror copy on error.
      _f=/etc/apt/sources.list; \
      if [ -f "$_f" ]; then \
        sed -i -E \
          -e "\|^deb .*http://archive\.ubuntu\.com/ubuntu|{p;s|http://archive\.ubuntu\.com/ubuntu|http://${APT_MIRROR}/ubuntu|}" \
          -e "\|^deb .*http://security\.ubuntu\.com/ubuntu|{p;s|http://security\.ubuntu\.com/ubuntu|http://${APT_MIRROR}/ubuntu|}" \
          "$_f"; \
      fi; \
      echo "APT sources: canonical (primary) + ${APT_MIRROR} (failover)"; \
    fi

# Common deps used by ~all plugins. Order chosen to maximize layer caching
# in consumer images (this layer is the same hash everywhere).
#
# Retries archive.ubuntu.com transient failures: the mirror network
# intermittently drops mid-fetch under load. The retry loop + `--fix-missing`
# re-attempts only the debs that didn't land, giving us self-healing build
# behavior without blowing up the whole pipeline on a single mirror flap.
RUN set -eux; \
    PKGS="git curl jq ca-certificates gnupg wget unzip zip xz-utils"; \
    for i in 1 2 3 4 5; do \
      apt-get update && break || { echo "apt-get update attempt $i failed; sleeping $((i * 10))s"; sleep $((i * 10)); }; \
    done; \
    for i in 1 2 3 4 5; do \
      apt-get install -y --no-install-recommends --fix-missing $PKGS && break \
        || { echo "apt-get install attempt $i failed; sleeping $((i * 10))s"; sleep $((i * 10)); }; \
    done; \
    # Sanity check — fail fast if any required pkg is still missing after retries.
    for p in $PKGS; do dpkg -s "$p" >/dev/null 2>&1 || { echo "ERROR: $p not installed after retries"; exit 1; }; done; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb

# apt-retry-install — shared helper for plugin Dockerfiles. Wraps
# `apt-get update` + `apt-get install` in a 5-attempt retry loop with
# linear backoff. Exits 0 on success, non-zero if EVERY attempt failed.
#
# Usage in a plugin Dockerfile:
#   RUN apt-retry-install nodejs python3 build-essential
#
# Without this helper, every per-plugin apt install is a roll of the dice
# against archive.ubuntu.com / vendor-repo flaps. With it, every install
# is self-healing and the pattern is one line per plugin.
RUN cat > /usr/local/bin/apt-retry-install <<'SCRIPT' && chmod +x /usr/local/bin/apt-retry-install
#!/bin/sh
set -eu
if [ "$#" -eq 0 ]; then
  echo "usage: apt-retry-install <pkg> [<pkg>...]" >&2
  exit 2
fi
# One combined update+install per attempt. Re-running `apt-get update` each time
# (not just once up front) is deliberate: a regional apt mirror caught mid-sync
# serves an internally-inconsistent Packages index — installs fail with
# "Depends: X but it is not going to be installed" and retrying the SAME stale
# index just fails identically. Re-updating lets a later attempt pick up the
# finished snapshot. `_ok` tracks whether install actually succeeded so we can
# fail hard below — a plain `cmd && break || { sleep; }` list swallows the final
# attempt's failure under `set -e` (the `||` block exits 0), which would let a
# never-installed package sail through as a false-green build step.
_ok=0
for i in 1 2 3 4 5; do
  if ! apt-get update; then
    echo "apt-get update attempt $i failed; sleeping $((i * 10))s"; sleep $((i * 10)); continue
  fi
  if apt-get install -y --no-install-recommends "$@"; then _ok=1; break; fi
  echo "apt-get install attempt $i failed; sleeping $((i * 10))s"; sleep $((i * 10))
done
if [ "$_ok" != 1 ]; then
  echo "apt-retry-install: FAILED to install after 5 attempts: $*" >&2
  exit 1
fi
# Per-package verification was historically here but caused too many
# false negatives:
#   - Virtual packages (libz-dev provided by zlib1g-dev) — dpkg -s sees nothing
#   - Transitional packages renamed in noble's time64 ABI transition
#     (libgtk2.0-0 → libgtk2.0-0t64, libasound2 → libasound2t64, etc.)
#     would fail the strict check even when apt installed the new name
# Since we no longer use --fix-missing (silent partial install is gone)
# and the install loop above only sets _ok on a clean apt exit, we trust
# apt's own exit code as the source of truth.
rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
SCRIPT

# run-logged — shared helper that makes a plugin's gate command HONEST.
#
# CodeBuild runs every command under /bin/sh (dash), which has no
# `set -o pipefail`. So the ubiquitous `tool ... 2>&1 | tee log` idiom exits
# with tee's status (0) and MASKS the tool's real failure — the single most
# common false-positive-green bug across the plugin catalog. This helper
# streams combined output to BOTH the console and <logfile> AND exits with the
# tool's real status, so the platform's `failureBehavior` (warn/ignore/fail)
# gates on the truth.
#
# Usage in a plugin Dockerfile's commands (replaces `tool … 2>&1 | tee LOG`):
#   run-logged LOG -- tool arg1 arg2
# The `--` separates the logfile from the command; args after it (including a
# tool's own `--`, e.g. `cargo clippy -- -D warnings`) pass through untouched.
RUN cat > /usr/local/bin/run-logged <<'SCRIPT' && chmod +x /usr/local/bin/run-logged
#!/bin/sh
# run-logged <logfile> [--] <cmd> [args...]
set -u
if [ "$#" -lt 2 ]; then
  echo "usage: run-logged <logfile> [--] <cmd> [args...]" >&2
  exit 2
fi
_log=$1; shift
[ "${1:-}" = "--" ] && shift
_rcfile=$(mktemp)
# Run cmd, stream stdout+stderr to console AND logfile, capture cmd's real exit
# (POSIX has no PIPESTATUS/pipefail, so stash the status through a temp file).
{ "$@" 2>&1; echo "$?" > "$_rcfile"; } | tee "$_log"
_rc=$(cat "$_rcfile"); rm -f "$_rcfile"
exit "$_rc"
SCRIPT

# fetch-verified — the ONE way a plugin/base Dockerfile downloads a file.
#
# Every download in the catalog is pinned: a fixed VERSION in the URL and the
# upstream-published digest in the Dockerfile (never "latest", never
# `curl | sh`). This helper retries transient network failures, then refuses
# to write <dest> unless the payload matches the pinned digest. The digest
# algorithm is picked by length: 64 hex = SHA-256, 128 hex = SHA-512 (used only
# where the vendor publishes SHA-512 alone, e.g. the .NET SDK and Maven).
#
# Usage:  fetch-verified <url> <hex-digest> <dest>
RUN cat > /usr/local/bin/fetch-verified <<'SCRIPT' && chmod 0755 /usr/local/bin/fetch-verified
#!/bin/sh
set -eu
if [ "$#" -ne 3 ]; then
  echo "usage: fetch-verified <url> <sha256|sha512 hex> <dest>" >&2
  exit 2
fi
_url=$1; _sum=$2; _dest=$3
case "${#_sum}" in
  64)  _tool=sha256sum ;;
  128) _tool=sha512sum ;;
  *)   echo "fetch-verified: digest for ${_url} is not a SHA-256/512 hex string" >&2; exit 2 ;;
esac
_tmp=$(mktemp)
_ok=0
for i in 1 2 3 4 5; do
  if curl -fsSL --retry 3 --retry-delay 2 "$_url" -o "$_tmp"; then _ok=1; break; fi
  echo "fetch-verified: download attempt $i failed: ${_url}; sleeping $((i * 5))s" >&2
  sleep $((i * 5))
done
[ "$_ok" = 1 ] || { rm -f "$_tmp"; echo "fetch-verified: FAILED to download ${_url}" >&2; exit 1; }
if ! echo "${_sum}  ${_tmp}" | "$_tool" -c - >/dev/null 2>&1; then
  echo "fetch-verified: CHECKSUM MISMATCH for ${_url}" >&2
  echo "  expected: ${_sum}" >&2
  echo "  actual:   $("$_tool" "$_tmp" | cut -d' ' -f1)" >&2
  rm -f "$_tmp"; exit 1
fi
mkdir -p "$(dirname "$_dest")"
mv "$_tmp" "$_dest"
chmod 0644 "$_dest"
SCRIPT

# fetch-apt-key — add a third-party apt signing key, pinned by fingerprint.
#
# apt verifies every package against the repo's signed Release file, so the
# trust root for an apt-installed tool is the signing key. This pins it: the
# downloaded keyring must contain EXACTLY the expected primary-key fingerprints
# (a rotated or substituted key fails the build loudly), and is written
# dearmored to <keyring> for a `signed-by=` source line.
#
# Usage:  fetch-apt-key <url> <keyring-path> <FPR> [<FPR>...]
RUN cat > /usr/local/bin/fetch-apt-key <<'SCRIPT' && chmod 0755 /usr/local/bin/fetch-apt-key
#!/bin/sh
set -eu
if [ "$#" -lt 3 ]; then
  echo "usage: fetch-apt-key <url> <keyring-path> <FPR> [<FPR>...]" >&2
  exit 2
fi
_url=$1; _out=$2; shift 2
_raw=$(mktemp); _home=$(mktemp -d)
_ok=0
for i in 1 2 3 4 5; do
  if curl -fsSL --retry 3 "$_url" -o "$_raw"; then _ok=1; break; fi
  echo "fetch-apt-key: attempt $i failed: ${_url}" >&2; sleep $((i * 5))
done
[ "$_ok" = 1 ] || { echo "fetch-apt-key: FAILED to download ${_url}" >&2; exit 1; }
_got=$(GNUPGHOME="$_home" gpg --batch --show-keys --with-colons "$_raw" 2>/dev/null \
  | awk -F: '/^pub/{p=1;next} p&&/^fpr/{print $10;p=0}' | sort -u | tr '\n' ' ')
_want=$(printf '%s\n' "$@" | tr 'a-f' 'A-F' | sort -u | tr '\n' ' ')
if [ "$_got" != "$_want" ]; then
  echo "fetch-apt-key: FINGERPRINT MISMATCH for ${_url}" >&2
  echo "  expected: ${_want}" >&2
  echo "  actual:   ${_got}" >&2
  exit 1
fi
install -d -m 0755 "$(dirname "$_out")"
if grep -q -- "-----BEGIN PGP PUBLIC KEY BLOCK-----" "$_raw"; then
  GNUPGHOME="$_home" gpg --batch --yes --dearmor -o "$_out" "$_raw"
else
  cp "$_raw" "$_out"
fi
chmod 0644 "$_out"
rm -rf "$_raw" "$_home"
SCRIPT

# ─── Non-root runtime user ───
#
# Every plugin image runs as the unprivileged `plugin` user (uid/gid 1000,
# HOME=/home/plugin). Ubuntu 24.04 ships a stock `ubuntu` user on uid 1000;
# it is replaced so the uid has one well-known name across every base
# (the Debian-based ruby base creates the same user).
#
# Consumers: a plugin Dockerfile that needs root for a build step (apt,
# writes under /usr/local, /etc) switches with `USER root` and MUST end with
# `USER 1000:1000` — test-plugins.sh fails any image whose final USER is root.
# Numeric uid:gid so Kubernetes `runAsNonRoot` can verify it.
#
# Runtime: AWS CodeBuild runs buildspec commands as root unless the buildspec
# sets `run-as` (CodeBuild buildspec reference), so this USER does not change
# CodeBuild today. It is the image's declared runtime identity (what the
# catalog's `runAsRoot` attribute and compliance rules read), what `docker run`
# uses, and what `run-as: plugin` will use. Plugins are written to work either
# way: tools are baked at build time and runtime-writable prefixes (language
# package dirs, version-switch dirs) are owned by uid 1000.
RUN set -eux; \
    if id -u ubuntu >/dev/null 2>&1; then userdel -r ubuntu 2>/dev/null || userdel ubuntu; fi; \
    groupadd --gid 1000 plugin; \
    useradd --uid 1000 --gid 1000 --create-home --home-dir /home/plugin --shell /bin/bash plugin; \
    install -d -o 1000 -g 1000 -m 0755 /app

# Working directory for pipeline source — every plugin overrides commands
# relative to this path.
WORKDIR /app

USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands.
CMD ["bash"]
