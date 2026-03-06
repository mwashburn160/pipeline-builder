# Email Notify Plugin — Pipeline Email Notifications
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Sends email via AWS SES or SMTP

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    ca-certificates \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# ─── AWS CLI v2 ───
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscli.zip

# ─── Runtime configuration defaults ───
ENV EMAIL_PROVIDER=ses
ENV EMAIL_TO=""
ENV EMAIL_FROM=""
ENV EMAIL_SUBJECT="Pipeline Notification"
ENV PIPELINE_NAME=""
ENV PIPELINE_STATUS=""
ENV AWS_REGION=us-east-1

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
