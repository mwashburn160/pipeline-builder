# Sentry Release Plugin — Release Tracking and Source Maps
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Creates Sentry releases, associates commits, and uploads source maps
# Requires @sentry/cli for release management

FROM pipeline-plugin-base:24.04

# ─── Node.js 24 for sentry-cli ───
# NOTE: NodeSource setup script piped to bash is major-pinned (24.x) but not exact;
# no concrete patch version to pin here. Left as-is.
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# ─── Sentry CLI ───
# NOTE: @sentry/cli is unpinned (installs latest). Pin to `@sentry/cli@<x.y.z>` for
# reproducible builds once a target version is chosen.
RUN npm install -g @sentry/cli

# ─── Runtime configuration defaults ───
# Non-sensitive config only — SENTRY_AUTH_TOKEN injected at runtime via CodeBuild secrets
ENV SENTRY_ORG=""
ENV SENTRY_PROJECT=""
ENV SENTRY_RELEASE=""
ENV SENTRY_SOURCEMAPS_PATH=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
