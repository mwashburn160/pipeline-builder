# govulncheck Plugin — Go Vulnerability Checker
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder

FROM pipeline-plugin-base:24.04

RUN apt-retry-install build-essential

ENV GOENV_ROOT=/opt/goenv
RUN git clone https://github.com/go-nv/goenv.git ${GOENV_ROOT}

RUN ${GOENV_ROOT}/bin/goenv install 1.23.12 && \
    ${GOENV_ROOT}/bin/goenv install 1.24.13 && \
    ${GOENV_ROOT}/bin/goenv global 1.24.13

ENV PATH="${GOENV_ROOT}/shims:${GOENV_ROOT}/bin:${PATH}"
ENV GOPATH=/opt/go
ENV PATH="${GOPATH}/bin:${PATH}"
ENV GO_VERSION=1.24.13

WORKDIR /app
CMD ["bash"]
