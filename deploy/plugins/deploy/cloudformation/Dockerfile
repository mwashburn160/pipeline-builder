# CloudFormation Plugin — AWS Infrastructure Provisioning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Validates, deploys, and manages CloudFormation stacks
# Includes cfn-lint for template validation

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    wget \
    jq \
    ca-certificates \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# ─── AWS CLI ───
RUN curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscli.zip

# ─── cfn-lint for CloudFormation template validation ───
RUN pip3 install --no-cache-dir cfn-lint==1.31.1

# ─── rain for CloudFormation deployment (modern CLI) ───
RUN curl -fsSL https://github.com/aws-cloudformation/rain/releases/download/v1.18.0/rain-v1.18.0_linux-amd64.zip \
    -o /tmp/rain.zip && unzip -q /tmp/rain.zip -d /tmp && mv /tmp/rain-v1.18.0_linux-amd64/rain /usr/local/bin/rain && rm -rf /tmp/rain*

# ─── Runtime configuration defaults ───
ENV CFN_TEMPLATE=""
ENV CFN_STACK_NAME=""
ENV CFN_ACTION=validate
ENV CFN_PARAMETERS=""
ENV CFN_CAPABILITIES=CAPABILITY_IAM,CAPABILITY_NAMED_IAM
ENV CFN_REGION=us-east-1

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
