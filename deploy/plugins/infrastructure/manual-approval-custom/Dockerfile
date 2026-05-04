# Manual Approval Plugin — Pipeline Approval Gate
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Publishes SNS notification and polls for manual approval response
# Supports configurable timeout and approval dashboard URL

FROM pipeline-aws-cli-base:1.0

# ─── Runtime configuration defaults ───
ENV APPROVAL_TOPIC_ARN=""
ENV APPROVAL_MESSAGE="Pipeline requires manual approval"
ENV APPROVAL_TIMEOUT=3600
ENV APPROVAL_URL=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
