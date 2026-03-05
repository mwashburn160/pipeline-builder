# Docker Lint Plugin — Dockerfile best practices & container image scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Combines Hadolint (Dockerfile linting) + Dockle (built image security audit)
# Validates Dockerfile quality and CIS benchmark compliance

# ─── Tool versions (override with --build-arg) ───
ARG HADOLINT_VERSION=2.12.0
ARG HADOLINT_PREV_VERSION=2.10.0
ARG DOCKLE_VERSION=0.4.15
ARG DOCKLE_PREV_VERSION=0.4.14

FROM hadolint/hadolint:v${HADOLINT_VERSION} AS hadolint-default
FROM hadolint/hadolint:v${HADOLINT_PREV_VERSION} AS hadolint-prev
FROM goodwithtech/dockle:v${DOCKLE_VERSION} AS dockle-default
FROM goodwithtech/dockle:v${DOCKLE_PREV_VERSION} AS dockle-prev

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Re-declare ARGs after FROM so they're available in this stage
ARG HADOLINT_VERSION
ARG HADOLINT_PREV_VERSION
ARG DOCKLE_VERSION
ARG DOCKLE_PREV_VERSION

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

# ─── Hadolint — Dockerfile linter (copied from official image) ───
RUN mkdir -p /opt/hadolint/versions
COPY --from=hadolint-default /bin/hadolint /opt/hadolint/versions/hadolint-${HADOLINT_VERSION}
COPY --from=hadolint-prev /bin/hadolint /opt/hadolint/versions/hadolint-${HADOLINT_PREV_VERSION}
RUN ln -sf /opt/hadolint/versions/hadolint-${HADOLINT_VERSION} /usr/local/bin/hadolint

# ─── Dockle — Container image security linter (copied from official image) ───
RUN mkdir -p /opt/dockle/versions
COPY --from=dockle-default /usr/local/bin/dockle /opt/dockle/versions/dockle-${DOCKLE_VERSION}
COPY --from=dockle-prev /usr/local/bin/dockle /opt/dockle/versions/dockle-${DOCKLE_PREV_VERSION}
RUN ln -sf /opt/dockle/versions/dockle-${DOCKLE_VERSION} /usr/local/bin/dockle

# ─── Runtime configuration defaults ───
ENV HADOLINT_VERSION=${HADOLINT_VERSION}
ENV DOCKLE_VERSION=${DOCKLE_VERSION}
ENV DOCKERFILE_PATH=Dockerfile
ENV DOCKER_IMAGE=""
ENV HADOLINT_FORMAT=json
ENV DOCKLE_FORMAT=json
ENV HADOLINT_SEVERITY=warning

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
