# golangci-lint Plugin — Go Code Quality
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over plugin-go-base (one pinned Go, shared by all Go plugins).
# golangci-lint is pinned + baked at build time — no runtime download
# (deterministic, no network dependency at pipeline time).

# ─── Build stage: golangci-lint from source with the base's Go ───
# Built from the tagged module instead of taking the vendor release tarball:
# the upstream binary embeds the Go stdlib it was released with (go1.27.0 for
# v2.15.0), which carries fixed High stdlib CVEs (GO-2026-6608, GO-2026-6613).
# Building with plugin-go-base's current Go picks up the patched stdlib. Module
# downloads are verified against sum.golang.org. The module cache stays in this
# stage; only the binary is copied into the final image.
FROM plugin-go-base:1.0 AS golangci-build
USER root
ARG GOLANGCI_LINT_VERSION=2.15.0
# RETRIED: proxy.golang.org intermittently aborts a download mid-stream, and
# GOPROXY's `,direct` fallback only covers 404/410 (see the gosec plugin).
RUN set -eux; \
    for attempt in 1 2 3 4 5; do \
      CGO_ENABLED=0 GOBIN=/out go install -trimpath \
        "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v${GOLANGCI_LINT_VERSION}" && exit 0; \
      echo "go install golangci-lint failed (attempt $attempt/5); retrying" >&2; \
      sleep $((attempt * 5)); \
    done; \
    echo "go install golangci-lint failed after 5 attempts" >&2; exit 1

FROM plugin-go-base:1.0

# Writes under /usr/local need root; dropped to uid 1000 at the end.
USER root
COPY --from=golangci-build /out/golangci-lint /usr/local/bin/golangci-lint
RUN chmod 0755 /usr/local/bin/golangci-lint && golangci-lint --version

WORKDIR /app
USER 1000:1000
CMD ["bash"]
