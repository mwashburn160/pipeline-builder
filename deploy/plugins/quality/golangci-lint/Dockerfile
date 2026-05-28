# golangci-lint Plugin — Go Code Quality
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs multiple Go linters in parallel with configurable rules

FROM pipeline-plugin-base:24.04

RUN apt-retry-install build-essential

# ─── Go via goenv ───
ENV GOENV_ROOT=/opt/goenv
RUN git clone https://github.com/go-nv/goenv.git ${GOENV_ROOT}
RUN ${GOENV_ROOT}/bin/goenv install 1.23.12 && \
    ${GOENV_ROOT}/bin/goenv install 1.24.13 && \
    ${GOENV_ROOT}/bin/goenv global 1.24.13
ENV PATH="${GOENV_ROOT}/shims:${GOENV_ROOT}/bin:${PATH}"
ENV GOPATH=/opt/go
ENV PATH="${GOPATH}/bin:${PATH}"

# ─── golangci-lint (pinned release; never HEAD) ───
ARG GOLANGCI_LINT_VERSION=1.62.2
RUN curl -fsSL "https://github.com/golangci/golangci-lint/releases/download/v${GOLANGCI_LINT_VERSION}/golangci-lint-${GOLANGCI_LINT_VERSION}-linux-amd64.tar.gz" \
    | tar -xz --strip-components=1 -C /usr/local/bin "golangci-lint-${GOLANGCI_LINT_VERSION}-linux-amd64/golangci-lint"

# Default Go version
ENV GO_VERSION=1.24.13

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
