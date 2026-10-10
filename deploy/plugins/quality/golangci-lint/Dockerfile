# golangci-lint Plugin — Go Code Quality
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over plugin-go-base (one pinned Go, shared by all Go plugins).
# golangci-lint is pinned + baked at build time (vendor release tarball) — no
# runtime download (deterministic, no network dependency at pipeline time).

FROM plugin-go-base:1.0

# Writes under /usr/local need root; dropped to uid 1000 at the end.
USER root

# golangci-lint (pinned release; never HEAD). Ships linux-amd64 / linux-arm64.
# Digests from the release's golangci-lint-${GOLANGCI_LINT_VERSION}-checksums.txt.
ARG GOLANGCI_LINT_VERSION=2.14.0
ARG GOLANGCI_LINT_SHA256_AMD64=ab90aeb7b066f92a33415b638a50fe5344bbb75a0d32ad30cc248d88f81032ab
ARG GOLANGCI_LINT_SHA256_ARM64=ee7ec5f3453d15ddf106fae5a4d6c71737712348a979d1fe9cd52ec7ea299bae
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) GOLANGCI_ARCH=linux-amd64; sum="${GOLANGCI_LINT_SHA256_AMD64}" ;; \
      arm64) GOLANGCI_ARCH=linux-arm64; sum="${GOLANGCI_LINT_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://github.com/golangci/golangci-lint/releases/download/v${GOLANGCI_LINT_VERSION}/golangci-lint-${GOLANGCI_LINT_VERSION}-${GOLANGCI_ARCH}.tar.gz" \
       "$sum" /tmp/golangci-lint.tar.gz; \
    tar -xzf /tmp/golangci-lint.tar.gz --strip-components=1 -C /usr/local/bin "golangci-lint-${GOLANGCI_LINT_VERSION}-${GOLANGCI_ARCH}/golangci-lint"; \
    rm -f /tmp/golangci-lint.tar.gz

WORKDIR /app
USER 1000:1000
CMD ["bash"]
