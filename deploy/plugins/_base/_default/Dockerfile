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

# Common deps used by ~all plugins. Order chosen to maximize layer caching
# in consumer images (this layer is the same hash everywhere).
#
# Retries archive.ubuntu.com transient failures: the mirror network
# intermittently drops mid-fetch under load (we've hit this with PHP and
# the base build). The retry loop + `--fix-missing` re-attempts only the
# debs that didn't land, giving us self-healing build behavior without
# blowing up the whole pipeline on a single mirror flap.
RUN set -eux; \
    PKGS="git curl jq ca-certificates gnupg wget unzip"; \
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

# Working directory for pipeline source — every plugin overrides commands
# relative to this path.
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands.
CMD ["bash"]
