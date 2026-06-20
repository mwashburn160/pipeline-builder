# Node.js Plugin — Multi-version build environment using nvm
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Node.js version is selected at runtime via NODE_VERSION env var
# Package manager auto-detected (npm/yarn/pnpm) or set via PACKAGE_MANAGER env var

FROM pipeline-plugin-base:24.04

# System dependencies for builds
RUN apt-retry-install build-essential

# Install nvm
ENV NVM_DIR=/opt/nvm
RUN mkdir -p ${NVM_DIR} \
    && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# Pre-install current + previous LTS Node.js versions (latest + previous, per
# the language-plugin policy). A stable major-version symlink (v22/v24) lets the
# plugin select a runtime by prepending ${NVM_DIR}/versions/node/v${NODE_VERSION}/bin
# to PATH — no `nvm`/`source` needed at build time (CodeBuild runs commands under
# /bin/sh, where both are unavailable).
RUN bash -c "source ${NVM_DIR}/nvm.sh && \
    nvm install 22 && \
    nvm install 24 && \
    nvm alias default 24 && \
    ln -sfT \"\$(dirname \"\$(dirname \"\$(nvm which 22)\")\")\" ${NVM_DIR}/versions/node/v22 && \
    ln -sfT \"\$(dirname \"\$(dirname \"\$(nvm which 24)\")\")\" ${NVM_DIR}/versions/node/v24"

# Add the default (current) Node to PATH
ENV PATH="${NVM_DIR}/versions/node/v24/bin:${PATH}"

# Default Node.js version (overridden by NODE_VERSION env var at runtime; the
# image pre-installs the latest + previous LTS only — 24 and 22)
ENV NODE_VERSION=24

# Package manager selection (auto = detect from project files)
ENV PACKAGE_MANAGER=auto

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
