# Docker Lint Plugin — Dockerfile best practices & container image scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Combines Hadolint (Dockerfile linting) + Dockle (built image security audit)
# Validates Dockerfile quality and CIS benchmark compliance

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
    && rm -rf /var/lib/apt/lists/*

# ─── Hadolint — Dockerfile linter ───
RUN mkdir -p /opt/hadolint/versions

RUN curl -fsSL https://github.com/hadolint/hadolint/releases/download/v2.12.0/hadolint-Linux-x86_64 \
    -o /opt/hadolint/versions/hadolint-2.12.0 && chmod +x /opt/hadolint/versions/hadolint-2.12.0

RUN curl -fsSL https://github.com/hadolint/hadolint/releases/download/v2.10.0/hadolint-Linux-x86_64 \
    -o /opt/hadolint/versions/hadolint-2.10.0 && chmod +x /opt/hadolint/versions/hadolint-2.10.0

# Default to latest installed version
RUN ln -sf /opt/hadolint/versions/hadolint-2.12.0 /usr/local/bin/hadolint

# ─── Dockle — Container image security linter (CIS benchmark) ───
RUN mkdir -p /opt/dockle/versions

RUN curl -fsSL https://github.com/goodwithtech/dockle/releases/download/v0.4.14/dockle_0.4.14_Linux-64bit.tar.gz \
    | tar -xz -C /opt/dockle/versions && mv /opt/dockle/versions/dockle /opt/dockle/versions/dockle-0.4.14

RUN curl -fsSL https://github.com/goodwithtech/dockle/releases/download/v0.4.15/dockle_0.4.15_Linux-64bit.tar.gz \
    | tar -xz -C /opt/dockle/versions && mv /opt/dockle/versions/dockle /opt/dockle/versions/dockle-0.4.15

# Default to latest installed version
RUN ln -sf /opt/dockle/versions/dockle-0.4.15 /usr/local/bin/dockle

# ─── Runtime configuration defaults ───
ENV HADOLINT_VERSION=2.12.0
ENV DOCKLE_VERSION=0.4.15
ENV DOCKERFILE_PATH=Dockerfile
ENV DOCKER_IMAGE=""
ENV HADOLINT_FORMAT=json
ENV DOCKLE_FORMAT=json
ENV HADOLINT_SEVERITY=warning

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
