# Codecov Plugin — Coverage Reporting Service
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Uploads coverage reports to Codecov for PR comments and badge tracking
# Auto-detects coverage file formats: lcov.info, coverage.xml, .coverage, jacoco.xml, coverage.out

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
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

# ─── Codecov CLI (installed via npm) ───
RUN npm install -g codecov

# ─── Runtime configuration defaults ───
# Non-sensitive config only — CODECOV_TOKEN must be injected at runtime
# via CodeBuild environment variables or secrets manager
ENV CODECOV_FLAGS=""
ENV CODECOV_FILE=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
