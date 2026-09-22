# Docker Build Plugin — Container Image Build & Push
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Builds Docker images and pushes to ECR, DockerHub, or other registries
# Supports multi-stage builds, build args, and caching

FROM pipeline-aws-cli-base:1.0

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

RUN apt-retry-install lsb-release

# ─── Docker CLI + Buildx ───
# Signing key pinned by fingerprint (Docker's published CE release key) —
# fetch-apt-key refuses a rotated or substituted key.
RUN fetch-apt-key https://download.docker.com/linux/ubuntu/gpg /usr/share/keyrings/docker-archive-keyring.gpg \
       9DC858229FC7DD38854AE2D88D81803C0EBFCD88 \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list \
    && apt-retry-install docker-ce-cli docker-buildx-plugin

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
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
