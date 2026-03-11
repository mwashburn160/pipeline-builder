# Snyk Security Plugin — Node.js / C++ scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# For other languages, use snyk-python, snyk-java, snyk-go, snyk-dotnet, snyk-ruby, or snyk-rust

FROM public.ecr.aws/docker/library/ubuntu:24.04

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

# ─── Node.js (required by Snyk CLI) ───
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ─── Snyk CLI ───
RUN npm install -g snyk

# ─── Runtime configuration defaults ───
ENV SNYK_SEVERITY_THRESHOLD=high

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
