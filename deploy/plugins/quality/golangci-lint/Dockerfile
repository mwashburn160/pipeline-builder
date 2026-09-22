# golangci-lint Plugin — Go Code Quality
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-go-base (one pinned Go, shared by all Go plugins).
# golangci-lint is pinned + baked at build time (vendor release tarball) — no
# runtime download (deterministic, no network dependency at pipeline time).

FROM pipeline-go-base:1.0

# Writes under /usr/local need root; dropped to uid 1000 at the end.
USER root

# golangci-lint (pinned release; never HEAD). Ships linux-amd64 / linux-arm64.
# Digests from the release's golangci-lint-${GOLANGCI_LINT_VERSION}-checksums.txt.
ARG GOLANGCI_LINT_VERSION=2.13.2
ARG GOLANGCI_LINT_SHA256_AMD64=2277d43b98ec0054280f2ac26b53268bae97682444678a59a657dd565da021d6
ARG GOLANGCI_LINT_SHA256_ARM64=a2a4e0065aa41be71f7c5ac90f271b61751331e5d04314e62afe4027855f0893
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
