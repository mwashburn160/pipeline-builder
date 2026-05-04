# NPM Publish Plugin — Publish packages to npm registry
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Publishes Node.js packages to npm, supports scoped packages and custom tags
# Requires NPM_TOKEN injected at runtime via CodeBuild secrets

FROM pipeline-plugin-base:24.04

# ─── Node.js 24 via NodeSource ───
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# ─── Runtime configuration defaults ───
# Non-sensitive config only — NPM_TOKEN injected at runtime via CodeBuild secrets
ENV NPM_DRY_RUN=false
ENV NPM_TAG=latest
ENV NPM_ACCESS=public

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
