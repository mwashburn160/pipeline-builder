# Node.js Build Plugin — Build Verification
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder

FROM pipeline-plugin-base:24.04

RUN apt-retry-install build-essential

ENV NVM_DIR=/opt/nvm
RUN mkdir -p ${NVM_DIR} \
    && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
RUN bash -c "source ${NVM_DIR}/nvm.sh && \
    nvm install 24 && \
    nvm alias default 24 && \
    ln -sfT \"\$(dirname \"\$(dirname \"\$(nvm which 24)\")\")\" ${NVM_DIR}/versions/node/v24"
ENV PATH="${NVM_DIR}/versions/node/v24/bin:${PATH}"

ENV NODE_VERSION=24

WORKDIR /app
CMD ["bash"]
