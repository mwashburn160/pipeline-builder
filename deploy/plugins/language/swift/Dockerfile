# Swift Plugin — Multi-version build environment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Swift version is selected at runtime via SWIFT_VERSION env var

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies for Swift builds
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    jq \
    ca-certificates \
    build-essential \
    libcurl4-openssl-dev \
    libxml2-dev \
    libsqlite3-dev \
    libblocksruntime-dev \
    libncurses5-dev \
    binutils \
    gnupg \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# ─── Swift — multi-version support ───
RUN mkdir -p /opt/swift/versions

# Pre-install Swift 5.10 (previous LTS)
RUN curl -fsSL https://download.swift.org/swift-5.10.1-release/ubuntu2404/swift-5.10.1-RELEASE/swift-5.10.1-RELEASE-ubuntu24.04.tar.gz \
    | tar -xz -C /opt/swift/versions \
    && mv /opt/swift/versions/swift-5.10.1-RELEASE-ubuntu24.04 /opt/swift/versions/5.10

# Pre-install Swift 6.1 (current)
RUN curl -fsSL https://download.swift.org/swift-6.1-release/ubuntu2404/swift-6.1-RELEASE/swift-6.1-RELEASE-ubuntu24.04.tar.gz \
    | tar -xz -C /opt/swift/versions \
    && mv /opt/swift/versions/swift-6.1-RELEASE-ubuntu24.04 /opt/swift/versions/6.1

# Default to current version
RUN ln -sf /opt/swift/versions/6.1 /opt/swift/current
ENV PATH="/opt/swift/current/usr/bin:${PATH}"

# Default Swift version (overridden by SWIFT_VERSION env var at runtime)
ENV SWIFT_VERSION=6.1

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
