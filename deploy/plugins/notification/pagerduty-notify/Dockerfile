# PagerDuty Notify Plugin — Incident Trigger Notifications
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Triggers PagerDuty incidents via Events API v2 for pipeline failures
# Supports severity levels and custom source identification

FROM pipeline-plugin-base:24.04

# ─── Runtime configuration defaults ───
# Non-sensitive config only — PAGERDUTY_ROUTING_KEY injected at runtime via CodeBuild secrets
ENV NOTIFICATION_TYPE=trigger
ENV PIPELINE_NAME=""
ENV PIPELINE_STATUS=""
ENV PD_SEVERITY=critical
ENV PD_SOURCE=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
