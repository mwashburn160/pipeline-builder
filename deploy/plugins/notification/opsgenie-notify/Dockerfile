# Opsgenie Notify Plugin — Alert Notifications
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Creates Opsgenie alerts for pipeline events via REST API v2
# Supports priority levels and team routing

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
# Non-sensitive config only — OPSGENIE_API_KEY injected at runtime via CodeBuild secrets
ENV NOTIFICATION_TYPE=alert
ENV PIPELINE_NAME=""
ENV PIPELINE_STATUS=""
ENV OG_PRIORITY=P2
ENV OG_TEAM=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
