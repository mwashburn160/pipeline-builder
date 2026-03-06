# Serverless Framework Plugin — Serverless Application Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Deploys serverless applications to AWS, Azure, or GCP

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
    gnupg \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# ─── Node.js via nvm ───
ENV NVM_DIR=/opt/nvm
RUN mkdir -p ${NVM_DIR} \
    && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
RUN bash -c "source ${NVM_DIR}/nvm.sh && \
    nvm install 22 && \
    nvm install 24 && \
    nvm alias default 24"
ENV PATH="${NVM_DIR}/versions/node/v24/bin:${PATH}"

# ─── Serverless Framework ───
RUN npm install -g serverless

# ─── AWS CLI v2 ───
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscli.zip

# Default Node.js version
ENV NODE_VERSION=24

# ─── Runtime configuration defaults ───
ENV SLS_STAGE=dev
ENV SLS_REGION=""
ENV SLS_SERVICE_PATH=.

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
