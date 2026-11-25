# Manual Approval Plugin — Pipeline Approval Gate
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Publishes SNS notification and polls for manual approval response
# Supports configurable timeout and approval dashboard URL

FROM plugin-aws-cli-base:1.0

# apt needs root; the image drops back to the unprivileged `plugin` user
# (uid 1000) at the end.
USER root

# xxd: the spec builds APPROVAL_TOKEN with `head -c 16 /dev/urandom | xxd -p`,
# and neither base carries it (the command failed with "xxd: not found").
RUN apt-retry-install xxd

# ─── Runtime configuration defaults ───
ENV APPROVAL_TOPIC_ARN=""
ENV APPROVAL_MESSAGE="Pipeline requires manual approval"
ENV APPROVAL_TIMEOUT=3600
ENV APPROVAL_URL=""

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
