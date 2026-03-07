# Manual Approval Plugin — Pipeline Approval Gate
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Publishes SNS notification and polls for manual approval response
# Supports configurable timeout and approval dashboard URL

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# ─── AWS CLI v2 ───
RUN ARCH=$(uname -m) && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscli.zip

# ─── Runtime configuration defaults ───
ENV APPROVAL_TOPIC_ARN=""
ENV APPROVAL_MESSAGE="Pipeline requires manual approval"
ENV APPROVAL_TIMEOUT=3600
ENV APPROVAL_URL=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
