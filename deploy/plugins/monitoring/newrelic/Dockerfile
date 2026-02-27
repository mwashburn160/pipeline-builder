# New Relic Plugin — Deployment Marker Tracking
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Records deployment markers in New Relic for release tracking
# Correlates deployments with application performance metrics

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ─── Runtime configuration defaults ───
# Non-sensitive config only — NEW_RELIC_API_KEY injected at runtime via CodeBuild secrets
ENV NR_APP_ID=""
ENV NR_REVISION=""
ENV NR_DESCRIPTION=""
ENV NR_USER=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
