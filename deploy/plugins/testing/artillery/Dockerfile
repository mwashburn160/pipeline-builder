# Artillery Plugin — HTTP and WebSocket Load Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs Artillery load tests with configurable scenarios

FROM pipeline-plugin-base:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ─── Node.js via nvm ───
ENV NVM_DIR=/opt/nvm
RUN mkdir -p ${NVM_DIR} \
    && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
RUN bash -c "source ${NVM_DIR}/nvm.sh && \
    nvm install 24 && \
    nvm alias default 24 && \
    ln -sfT \"\$(dirname \"\$(dirname \"\$(nvm which 24)\")\")\" ${NVM_DIR}/versions/node/v24"
ENV PATH="${NVM_DIR}/versions/node/v24/bin:${PATH}"

# ─── Artillery CLI ───
RUN npm install -g artillery

# Default Node.js version
ENV NODE_VERSION=24

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
