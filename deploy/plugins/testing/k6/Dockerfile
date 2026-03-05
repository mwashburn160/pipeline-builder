# k6 Plugin — Performance and Load Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs k6 load tests with configurable VUs, duration, and thresholds
# Multi-version support

# ─── Tool versions (override with --build-arg) ───
ARG K6_VERSION=0.56.0
ARG K6_PREV_VERSION=0.55.0

FROM grafana/k6:${K6_VERSION} AS k6-default
FROM grafana/k6:${K6_PREV_VERSION} AS k6-prev

FROM public.ecr.aws/docker/library/ubuntu:24.04

ARG K6_VERSION
ARG K6_PREV_VERSION

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
    && rm -rf /var/lib/apt/lists/*

# ─── k6 — multi-version support (copied from official images) ───
RUN mkdir -p /opt/k6/versions
COPY --from=k6-default /usr/bin/k6 /opt/k6/versions/k6-${K6_VERSION}
COPY --from=k6-prev /usr/bin/k6 /opt/k6/versions/k6-${K6_PREV_VERSION}
RUN ln -sf /opt/k6/versions/k6-${K6_VERSION} /usr/local/bin/k6

# ─── Runtime configuration defaults ───
ENV K6_VERSION=${K6_VERSION}
ENV K6_SCRIPT=""
ENV K6_VUS=10
ENV K6_DURATION=30s
ENV K6_THRESHOLDS=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
