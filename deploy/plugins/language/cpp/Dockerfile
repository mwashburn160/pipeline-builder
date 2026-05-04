# C++ Plugin — Build environment with cmake, make, and clang
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Build system auto-detected (cmake/make/meson) or set via BUILD_SYSTEM env var

FROM pipeline-plugin-base:24.04

# System dependencies for C++ builds + Python for Conan/Meson
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
    python3 \
    python3-pip \
    && pip3 install --break-system-packages conan meson \
    && rm -rf /var/lib/apt/lists/*

# Build system selection (auto = detect from project files)
ENV BUILD_SYSTEM=auto

# Build type (Debug, Release, RelWithDebInfo)
ENV BUILD_TYPE=Release

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
