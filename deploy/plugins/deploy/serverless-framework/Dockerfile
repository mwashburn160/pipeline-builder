# Serverless Framework Plugin — Serverless Application Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Deploys serverless applications to AWS, Azure, or GCP

FROM pipeline-aws-cli-base:1.0

RUN apt-retry-install python3 python3-pip python3-venv

# ─── Node.js via nvm ───
ENV NVM_DIR=/opt/nvm
RUN mkdir -p ${NVM_DIR} \
    && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
RUN bash -c "source ${NVM_DIR}/nvm.sh && \
    nvm install 24 && \
    nvm alias default 24 && \
    ln -sfT \"\$(dirname \"\$(dirname \"\$(nvm which 24)\")\")\" ${NVM_DIR}/versions/node/v24"
ENV PATH="${NVM_DIR}/versions/node/v24/bin:${PATH}"

# ─── Serverless Framework ───
RUN npm install -g serverless

# Default Node.js version
ENV NODE_VERSION=24

# ─── Runtime configuration defaults ───
ENV SLS_STAGE=dev
ENV SLS_REGION=""
ENV SLS_SERVICE_PATH=.

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
