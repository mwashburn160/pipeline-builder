# Trivy Security Plugin — Node.js / C++ / IaC scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# For other languages, use trivy-python, trivy-java, trivy-go, trivy-dotnet, trivy-ruby, or trivy-rust

# ─── Tool versions (override with --build-arg) ───
ARG TRIVY_VERSION=0.69.3
ARG TRIVY_PREV_VERSION=0.68.2

FROM aquasec/trivy:${TRIVY_VERSION} AS trivy-default
FROM aquasec/trivy:${TRIVY_PREV_VERSION} AS trivy-prev

FROM public.ecr.aws/docker/library/ubuntu:24.04

ARG TRIVY_VERSION
ARG TRIVY_PREV_VERSION

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    build-essential \
    gnupg \
    cmake \
    clang \
    ninja-build \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# ─── Node.js (default runtime) ───
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ─── Trivy CLI — multi-version support (copied from official images) ───
RUN mkdir -p /opt/trivy/versions
COPY --from=trivy-prev /usr/local/bin/trivy /opt/trivy/versions/trivy-${TRIVY_PREV_VERSION}
COPY --from=trivy-default /usr/local/bin/trivy /opt/trivy/versions/trivy-${TRIVY_VERSION}
RUN ln -sf /opt/trivy/versions/trivy-${TRIVY_VERSION} /usr/local/bin/trivy

# ─── Runtime configuration defaults ───
ENV TRIVY_VERSION=${TRIVY_VERSION}
ENV TRIVY_SEVERITY=HIGH,CRITICAL
ENV TRIVY_FORMAT=json

# Working directory for pipeline source
WORKDIR /app

CMD ["bash"]
