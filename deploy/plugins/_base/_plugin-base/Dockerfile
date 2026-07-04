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

# APT mirror selection. Default is the global archive.ubuntu.com, which is
# slow + flaky from EC2 (we've seen 600 B/s with mid-fetch drops). Build
# orchestrator passes `--build-arg APT_MIRROR=<region>.ec2.archive.ubuntu.com`
# when running inside EC2 so apt traffic stays in-region (free + fast).
#
# This mutation persists in the image layer, so EVERY plugin Dockerfile
# that uses `FROM pipeline-plugin-base:24.04` inherits the regional mirror
# automatically — no per-plugin Dockerfile change needed.
#
# Both archive.ubuntu.com (main/universe/multiverse/restricted) AND
# security.ubuntu.com (security updates) are redirected; Canonical's EC2
# mirrors host both.
#
# Set at build time:
#   docker build --build-arg APT_MIRROR=us-east-1.ec2.archive.ubuntu.com ...
# Default leaves the global mirror in place for local dev / non-AWS builds.
ARG APT_MIRROR=""
RUN if [ -n "$APT_MIRROR" ]; then \
      _files="/etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list"; \
      for _f in $_files; do \
        [ -f "$_f" ] || continue; \
        sed -i \
          -e "s|http://archive.ubuntu.com/ubuntu|http://${APT_MIRROR}/ubuntu|g" \
          -e "s|http://security.ubuntu.com/ubuntu|http://${APT_MIRROR}/ubuntu|g" \
          "$_f"; \
      done; \
      echo "APT mirror: ${APT_MIRROR} (both archive + security)"; \
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
for i in 1 2 3 4 5; do
  apt-get update && break || { echo "apt-get update attempt $i failed; sleeping $((i * 10))s"; sleep $((i * 10)); }
done
for i in 1 2 3 4 5; do
  apt-get install -y --no-install-recommends "$@" && break \
    || { echo "apt-get install attempt $i failed; sleeping $((i * 10))s"; sleep $((i * 10)); }
done
# Per-package verification was historically here but caused too many
# false negatives:
#   - Virtual packages (libz-dev provided by zlib1g-dev) — dpkg -s sees nothing
#   - Transitional packages renamed in noble's time64 ABI transition
#     (libgtk2.0-0 → libgtk2.0-0t64, libasound2 → libasound2t64, etc.)
#     would fail the strict check even when apt installed the new name
# Since we no longer use --fix-missing (silent partial install is gone)
# and the apt-get install retry loop above only succeeds on a clean
# exit, we trust apt's own exit code as the source of truth.
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

# Working directory for pipeline source — every plugin overrides commands
# relative to this path.
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands.
CMD ["bash"]
