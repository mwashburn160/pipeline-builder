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
# Verify every requested package was actually installed. Three checks in
# order, success on any:
#   1. dpkg -s        — works for real packages
#   2. apt-cache policy "<pkg> Installed:" — catches virtual packages
#      (e.g. libz-dev provided by zlib1g-dev) where apt installed the
#      "real" provider but dpkg -s for the alias fails
#   3. report failure
#
# Without the apt-cache fallback the strict dpkg check rejects valid
# installs of virtual/transitional package names.
for p in "$@"; do
  case "$p" in -*) continue ;; esac  # skip flags
  if dpkg -s "$p" >/dev/null 2>&1; then continue; fi
  if apt-cache policy "$p" 2>/dev/null | grep -qE '^\s+Installed:\s+[^(]'; then continue; fi
  echo "ERROR: $p not installed after retries"
  exit 1
done
rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
SCRIPT

# Working directory for pipeline source — every plugin overrides commands
# relative to this path.
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands.
CMD ["bash"]
