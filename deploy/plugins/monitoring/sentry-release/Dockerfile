# Sentry Release Plugin — Release Tracking and Source Maps
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Creates Sentry releases, associates commits, and uploads source maps
# Requires @sentry/cli for release management
#
# Thin layer over pipeline-node-base (one pinned, checksum-verified Node 24 +
# npm) — replaces the NodeSource `setup_24.x | bash` installer (unpinned, and
# a remote script piped into a root shell).

FROM pipeline-node-base:1.0

# corepack ships with Node 24; enabling it writes shims into the uid-1000-owned
# ${NODE_HOME}/bin — no root needed.
RUN corepack enable

# ─── Sentry CLI ───
# Pinned (was an unpinned `npm install -g @sentry/cli`). The platform binary
# arrives as an npm optional dependency, integrity-checked by npm.
ARG SENTRY_CLI_VERSION=3.8.0
RUN npm install -g "@sentry/cli@${SENTRY_CLI_VERSION}" && sentry-cli --version

# ─── Runtime configuration defaults ───
# Non-sensitive config only — SENTRY_AUTH_TOKEN injected at runtime via CodeBuild secrets
ENV SENTRY_ORG=""
ENV SENTRY_PROJECT=""
ENV SENTRY_RELEASE=""
ENV SENTRY_SOURCEMAPS_PATH=""

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
