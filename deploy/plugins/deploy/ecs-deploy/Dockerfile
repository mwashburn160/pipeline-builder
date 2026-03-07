# ECS Deploy Plugin — Amazon ECS Service Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Updates task definitions and services with rolling deployments

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ─── AWS CLI v2 ───
RUN ARCH=$(uname -m) && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscli.zip

# ─── Runtime configuration defaults ───
ENV ECS_CLUSTER=""
ENV ECS_SERVICE=""
ENV IMAGE_URI=""
ENV ECS_TASK_FAMILY=""
ENV ECS_WAIT=true

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
