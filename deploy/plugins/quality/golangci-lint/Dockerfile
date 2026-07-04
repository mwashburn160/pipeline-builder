# golangci-lint Plugin — Go Code Quality
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-go-base (one pinned Go, shared by all Go plugins).
# golangci-lint is pinned + baked at build time (vendor release tarball) — no
# runtime download (deterministic, no network dependency at pipeline time).

FROM pipeline-go-base:1.0

# golangci-lint (pinned release; never HEAD). Ships linux-amd64 / linux-arm64.
ARG GOLANGCI_LINT_VERSION=1.62.2
RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
         amd64) GOLANGCI_ARCH=linux-amd64 ;; \
         arm64) GOLANGCI_ARCH=linux-arm64 ;; \
         *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/golangci/golangci-lint/releases/download/v${GOLANGCI_LINT_VERSION}/golangci-lint-${GOLANGCI_LINT_VERSION}-${GOLANGCI_ARCH}.tar.gz" \
       | tar -xz --strip-components=1 -C /usr/local/bin "golangci-lint-${GOLANGCI_LINT_VERSION}-${GOLANGCI_ARCH}/golangci-lint"

WORKDIR /app
CMD ["bash"]
