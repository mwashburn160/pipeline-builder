# New Relic Plugin — Deployment Marker Tracking
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Records deployment markers in New Relic for release tracking
# Correlates deployments with application performance metrics

FROM pipeline-plugin-base:24.04

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
