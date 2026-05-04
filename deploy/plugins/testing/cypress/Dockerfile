# Cypress Plugin — End-to-End Browser Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs Cypress E2E tests with video recording and screenshot capture

FROM pipeline-plugin-base:24.04

# System dependencies + Cypress browser prerequisites
RUN apt-retry-install libgtk2.0-0 libgtk-3-0 libgbm-dev libnotify-dev libnss3 libxss1 libasound2t64 libxtst6 xauth xvfb fonts-liberation

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

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
