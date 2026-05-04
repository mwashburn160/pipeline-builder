# Datadog Plugin — Deploy Tracking and Monitoring
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Sends deployment events and markers to Datadog for APM tracking
# Supports event creation and metric submission via Datadog API

FROM pipeline-plugin-base:24.04

# ─── Runtime configuration defaults ───
# Non-sensitive config only — DD_API_KEY injected at runtime via CodeBuild secrets
ENV DD_SITE=datadoghq.com
ENV DD_SERVICE=""
ENV DD_ENV=production
ENV DD_VERSION=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
