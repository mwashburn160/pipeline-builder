# Playwright Plugin — Cross-Browser E2E Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports Chromium, Firefox, and WebKit browsers

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

# ─── Playwright browsers + system dependencies ───
# `playwright install --with-deps` shells out to apt-get install for the
# browser system libraries. The base image's apt-cache is built once and
# can become stale within days as Ubuntu rolls security updates that
# supersede the specific `<pkg>=<version>` lines pinned by Playwright's
# bundled deps list. Running apt-get update immediately before keeps the
# index fresh; rm -rf /var/lib/apt/lists/* afterwards keeps image size down.
RUN apt-get update \
    && npx playwright install --with-deps chromium firefox webkit \
    && rm -rf /var/lib/apt/lists/*

# Default Node.js version
ENV NODE_VERSION=24

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
