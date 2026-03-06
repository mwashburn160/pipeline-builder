# Lambda Deploy Plugin — AWS Lambda Function Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Updates Lambda function code with zip or container image packaging

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
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscli.zip

# ─── Runtime configuration defaults ───
ENV LAMBDA_FUNCTION=""
ENV LAMBDA_PACKAGE_TYPE=zip
ENV LAMBDA_SOURCE_DIR=.
ENV LAMBDA_HANDLER=""
ENV LAMBDA_ALIAS=""
ENV LAMBDA_PUBLISH=false

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
