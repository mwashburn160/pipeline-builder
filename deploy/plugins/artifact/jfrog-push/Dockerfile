# JFrog Push Plugin — Push Container Images to JFrog Artifactory
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Builds Docker images and pushes to JFrog Artifactory using JFrog CLI authentication
# Requires JFROG_TOKEN at runtime (never baked into images)

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
    && rm -rf /var/lib/apt/lists/*

# ─── Docker CLI + Buildx ───
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    docker-ce-cli \
    docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*

# ─── JFrog CLI (jf) ───
RUN curl -fsSL https://releases.jfrog.io/artifactory/jfrog-gpg-public/jfrog_public_gpg.key | gpg --dearmor -o /usr/share/keyrings/jfrog-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/jfrog-archive-keyring.gpg] https://releases.jfrog.io/artifactory/jfrog-debs xenial contrib" \
    > /etc/apt/sources.list.d/jfrog.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    jfrog-cli-v2-jf \
    && rm -rf /var/lib/apt/lists/*

# ─── Runtime configuration defaults ───
# Non-sensitive config only — JFROG_TOKEN injected at runtime
ENV JFROG_URL=""
ENV JFROG_REPO=""
ENV IMAGE_NAME=""
ENV IMAGE_TAG=latest
ENV DOCKERFILE_PATH=Dockerfile
ENV DOCKER_CONTEXT=.

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
