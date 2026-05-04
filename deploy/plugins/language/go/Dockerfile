# Go Plugin — Multi-version build environment using goenv
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Go version is selected at runtime via GO_VERSION env var

FROM pipeline-plugin-base:24.04

# System dependencies for builds
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install goenv
ENV GOENV_ROOT=/opt/goenv
RUN git clone https://github.com/go-nv/goenv.git ${GOENV_ROOT}

# Pre-install current + previous Go versions
RUN ${GOENV_ROOT}/bin/goenv install 1.23.12 && \
    ${GOENV_ROOT}/bin/goenv install 1.24.13 && \
    ${GOENV_ROOT}/bin/goenv global 1.24.13

# Add goenv to PATH
ENV PATH="${GOENV_ROOT}/shims:${GOENV_ROOT}/bin:${PATH}"
ENV GOPATH=/opt/go
ENV PATH="${GOPATH}/bin:${PATH}"

# Default Go version (overridden by GO_VERSION env var at runtime)
ENV GO_VERSION=1.24.13

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
