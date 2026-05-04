# Microsoft Teams Notify Plugin — Pipeline Status Notifications
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Sends pipeline status messages to Microsoft Teams channels via webhook
# Supports adaptive card format with color-coded status indicators

FROM pipeline-plugin-base:24.04

# ─── Runtime configuration defaults ───
# Non-sensitive config only — TEAMS_WEBHOOK_URL injected at runtime via CodeBuild secrets
ENV NOTIFICATION_TYPE=pipeline-status
ENV PIPELINE_NAME=""
ENV PIPELINE_STATUS=""
ENV CUSTOM_MESSAGE=""
ENV MENTION_ON_FAILURE=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
