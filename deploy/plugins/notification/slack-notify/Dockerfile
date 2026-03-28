# Slack Notify Plugin — Pipeline Status Notifications
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Sends pipeline status messages to Slack channels via webhook
# Supports success, failure, and custom message templates

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
# Non-sensitive config only — SLACK_WEBHOOK_URL injected at runtime via CodeBuild secrets
ENV NOTIFICATION_TYPE=pipeline-status
ENV PIPELINE_NAME=""
ENV PIPELINE_STATUS=""
ENV CUSTOM_MESSAGE=""
ENV MENTION_ON_FAILURE=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
