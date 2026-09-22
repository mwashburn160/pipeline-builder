# NPM Publish Plugin — Publish packages to npm registry
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Publishes Node.js packages to npm, supports scoped packages and custom tags
# Requires NPM_TOKEN injected at runtime via CodeBuild secrets
#
# Thin layer over pipeline-node-base (one pinned, checksum-verified Node 24 +
# npm, shared by all Node plugins) — replaces the NodeSource `setup_24.x | bash`
# installer, which was unpinned and piped a remote script to a root shell.

FROM pipeline-node-base:1.0

# corepack ships with Node 24; enabling it writes shims into ${NODE_HOME}/bin,
# which the base owns as uid 1000 — no root needed.
RUN corepack enable

# ─── Runtime configuration defaults ───
# Non-sensitive config only — NPM_TOKEN injected at runtime via CodeBuild secrets
ENV NPM_DRY_RUN=false
ENV NPM_TAG=latest
ENV NPM_ACCESS=public

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
