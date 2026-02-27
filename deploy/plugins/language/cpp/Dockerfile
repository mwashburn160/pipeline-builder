# C++ Plugin — Build environment with cmake, make, and clang
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Build system auto-detected (cmake/make/meson) or set via BUILD_SYSTEM env var

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies for C++ builds
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    jq \
    ca-certificates \
    build-essential \
    cmake \
    clang \
    ninja-build \
    pkg-config \
    libssl-dev \
    valgrind \
    cppcheck \
    && rm -rf /var/lib/apt/lists/*

# Install Conan package manager
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
    && pip3 install conan meson \
    && rm -rf /var/lib/apt/lists/*

# Build system selection (auto = detect from project files)
ENV BUILD_SYSTEM=auto

# Build type (Debug, Release, RelWithDebInfo)
ENV BUILD_TYPE=Release

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
