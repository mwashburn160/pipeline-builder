# Trivy Security Plugin — Go scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Inherits from the trivy family base image (pipeline-trivy-base:1.0)
# which provides trivy CLI + (where applicable) Node.js. This file
# only adds the Go toolchain.

FROM pipeline-trivy-base:1.0

# Build deps required by the language toolchain. Without these, the
# scanner fails when it needs to build user code with native deps
# (cgo, JNI, native crates, native NuGet packages, etc.).
RUN apt-retry-install build-essential

# ─── Go via goenv ───
ENV GOENV_ROOT=/opt/goenv
RUN git clone --depth 1 https://github.com/go-nv/goenv.git ${GOENV_ROOT}
RUN ${GOENV_ROOT}/bin/goenv install 1.23.12 && \
    ${GOENV_ROOT}/bin/goenv install 1.24.13 && \
    ${GOENV_ROOT}/bin/goenv global 1.24.13
ENV PATH="${GOENV_ROOT}/shims:${GOENV_ROOT}/bin:${PATH}"

ENV GO_VERSION=1.24.13

WORKDIR /app
CMD ["bash"]
