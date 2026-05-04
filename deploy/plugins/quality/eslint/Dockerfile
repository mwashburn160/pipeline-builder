# ESLint Plugin — JavaScript/TypeScript Linting
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports ESLint v8 and v9 (flat config)
# Auto-detects project ESLint config or uses default rules

FROM pipeline-plugin-base:24.04

# ─── Node.js via nvm ───
ENV NVM_DIR=/opt/nvm
RUN mkdir -p ${NVM_DIR} \
    && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
RUN bash -c "source ${NVM_DIR}/nvm.sh && \
    nvm install 24 && \
    nvm alias default 24 && \
    ln -sfT \"\$(dirname \"\$(dirname \"\$(nvm which 24)\")\")\" ${NVM_DIR}/versions/node/v24"
ENV PATH="${NVM_DIR}/versions/node/v24/bin:${PATH}"

# Default Node.js version
ENV NODE_VERSION=24

# ESLint output format
ENV ESLINT_FORMAT=json
ENV ESLINT_MAX_WARNINGS=-1

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
