# Playwright Plugin — Cross-Browser E2E Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports Chromium, Firefox, and WebKit browsers

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    jq \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# ─── Node.js via nvm ───
ENV NVM_DIR=/opt/nvm
RUN mkdir -p ${NVM_DIR} \
    && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
RUN bash -c "source ${NVM_DIR}/nvm.sh && \
    nvm install 24 && \
    nvm alias default 24" \
    && ln -s ${NVM_DIR}/versions/node/$(ls ${NVM_DIR}/versions/node/ | grep '^v24') ${NVM_DIR}/versions/node/v24
ENV PATH="${NVM_DIR}/versions/node/v24/bin:${PATH}"

# ─── Playwright browsers + system dependencies ───
RUN npx playwright install --with-deps chromium firefox webkit

# Default Node.js version
ENV NODE_VERSION=24

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
