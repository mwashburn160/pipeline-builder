# Sentry Release Plugin — Release Tracking and Source Maps
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Creates Sentry releases, associates commits, and uploads source maps
# Requires @sentry/cli for release management

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# ─── Node.js 22 for sentry-cli ───
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

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
