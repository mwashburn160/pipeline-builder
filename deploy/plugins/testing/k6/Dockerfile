# k6 Plugin — Performance and Load Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs k6 load tests with configurable VUs, duration, and thresholds
# Multi-version support

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
    && rm -rf /var/lib/apt/lists/*

# ─── k6 — multi-version support ───
RUN mkdir -p /opt/k6/versions

RUN curl -fsSL https://github.com/grafana/k6/releases/download/v0.55.0/k6-v0.55.0-linux-amd64.tar.gz \
    | tar -xz -C /opt/k6/versions && mv /opt/k6/versions/k6-v0.55.0-linux-amd64/k6 /opt/k6/versions/k6-0.55.0

RUN curl -fsSL https://github.com/grafana/k6/releases/download/v0.56.0/k6-v0.56.0-linux-amd64.tar.gz \
    | tar -xz -C /opt/k6/versions && mv /opt/k6/versions/k6-v0.56.0-linux-amd64/k6 /opt/k6/versions/k6-0.56.0

RUN ln -sf /opt/k6/versions/k6-0.56.0 /usr/local/bin/k6

# ─── Runtime configuration defaults ───
ENV K6_VERSION=0.56.0
ENV K6_SCRIPT=""
ENV K6_VUS=10
ENV K6_DURATION=30s
ENV K6_THRESHOLDS=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
