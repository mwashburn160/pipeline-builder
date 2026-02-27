# Discord Notify Plugin — Pipeline Status Notifications
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Sends pipeline status messages to Discord channels via webhook
# Supports rich embeds with color-coded status indicators

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
# Non-sensitive config only — DISCORD_WEBHOOK_URL injected at runtime via CodeBuild secrets
ENV NOTIFICATION_TYPE=pipeline-status
ENV PIPELINE_NAME=""
ENV PIPELINE_STATUS=""
ENV CUSTOM_MESSAGE=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
