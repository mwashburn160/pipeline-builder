# Node.js Plugin — Multi-version build environment using nvm
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Node.js version is selected at runtime via NODE_VERSION env var
# Package manager auto-detected (npm/yarn/pnpm) or set via PACKAGE_MANAGER env var

FROM pipeline-plugin-base:24.04

# System dependencies for builds
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    jq \
    ca-certificates \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install nvm
ENV NVM_DIR=/opt/nvm
RUN mkdir -p ${NVM_DIR} \
    && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# Pre-install current LTS Node.js version
RUN bash -c "source ${NVM_DIR}/nvm.sh && \
    nvm install 24 && \
    nvm alias default 24 && \
    ln -sfT \"\$(dirname \"\$(dirname \"\$(nvm which 24)\")\")\" ${NVM_DIR}/versions/node/v24"

# Add nvm to PATH
ENV PATH="${NVM_DIR}/versions/node/v24/bin:${PATH}"

# Default Node.js version (overridden by NODE_VERSION env var at runtime)
ENV NODE_VERSION=24

# Package manager selection (auto = detect from project files)
ENV PACKAGE_MANAGER=auto

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
