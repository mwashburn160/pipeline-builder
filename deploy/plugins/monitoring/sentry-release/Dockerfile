# Sentry Release Plugin — Release Tracking and Source Maps
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Creates Sentry releases, associates commits, and uploads source maps
# Requires @sentry/cli for release management

FROM pipeline-plugin-base:24.04

# ─── Node.js 24 for sentry-cli ───
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# ─── Sentry CLI ───
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
