# Datadog Plugin — Deploy Tracking and Monitoring
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Sends deployment events and markers to Datadog for APM tracking
# Supports event creation and metric submission via Datadog API

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
# Non-sensitive config only — DD_API_KEY injected at runtime via CodeBuild secrets
ENV DD_SITE=datadoghq.com
ENV DD_SERVICE=""
ENV DD_ENV=production
ENV DD_VERSION=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
