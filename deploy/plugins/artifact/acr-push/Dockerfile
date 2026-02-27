# ACR Push Plugin — Push Container Images to Azure Container Registry
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Builds Docker images and pushes to ACR using Azure CLI service principal authentication
# Requires AZURE_CLIENT_ID + AZURE_CLIENT_SECRET + AZURE_TENANT_ID at runtime

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
    gnupg \
    lsb-release \
    apt-transport-https \
    && rm -rf /var/lib/apt/lists/*

# ─── Docker CLI + Buildx ───
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    docker-ce-cli \
    docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*

# ─── Azure CLI (az) ───
RUN curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/microsoft-archive-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-archive-keyring.gpg] https://packages.microsoft.com/repos/azure-cli/ $(lsb_release -cs) main" \
    > /etc/apt/sources.list.d/azure-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    azure-cli \
    && rm -rf /var/lib/apt/lists/*

# ─── Runtime configuration defaults ───
# Non-sensitive config only — AZURE_CLIENT_ID/SECRET/TENANT_ID injected at runtime
ENV ACR_REGISTRY=""
ENV IMAGE_NAME=""
ENV IMAGE_TAG=latest
ENV DOCKERFILE_PATH=Dockerfile
ENV DOCKER_CONTEXT=.

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
