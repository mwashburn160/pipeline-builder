# Docker Build Plugin — Container Image Build & Push
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Builds Docker images and pushes to ECR, DockerHub, or other registries
# Supports multi-stage builds, build args, and caching

FROM pipeline-plugin-base:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    lsb-release \
    && rm -rf /var/lib/apt/lists/*

# ─── Docker CLI + Buildx ───
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    docker-ce-cli \
    docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*

# ─── AWS CLI (for ECR login) ───
RUN ARCH=$(uname -m) && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscli.zip

# ─── Runtime configuration defaults ───
# Non-sensitive config only — registry credentials injected at runtime
ENV DOCKERFILE_PATH=Dockerfile
ENV DOCKER_CONTEXT=.
ENV DOCKER_BUILD_ARGS=""
ENV DOCKER_TARGET=""
ENV DOCKER_CACHE_FROM=""
ENV REGISTRY_TYPE=ecr
ENV IMAGE_TAG=latest

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
