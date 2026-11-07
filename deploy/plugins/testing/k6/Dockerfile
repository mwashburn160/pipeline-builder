# k6 Plugin — Performance and Load Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs k6 load tests with configurable VUs, duration, and thresholds
# Multi-version support

# ─── Tool versions (override with --build-arg) ───
ARG K6_VERSION=2.3.0
# The commit the v${K6_VERSION} tag must resolve to (checked after clone).
ARG K6_COMMIT=e0887846143ab176d4b5483c9d52cf3b3e009f1a
# Same pinned toolchain as api/plugin's tools stage.
ARG GO_IMAGE=golang:1.27.3-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb

# ─── k6, built from source ───
# The v${K6_VERSION} release (latest 2.x) carries Critical, fixable findings the
# release gate refuses: github.com/andybalholm/brotli v1.2.3 (GO-2026-6888, on
# CISA KEV; fixed in 1.2.7), golang.org/x/net v0.58.0 (GO-2026-6612; fixed in
# 0.60.0) and a go1.27.1 stdlib. Build the same tagged source with a current
# toolchain and the two modules raised through a side modfile, as api/plugin
# does for syft and grype (brotli v1.2.8 and x/net v0.62.0, the same pins).
# Build flags follow upstream's own Dockerfile. Source integrity: the tag must
# resolve to the pinned commit, or the build fails.
FROM ${GO_IMAGE} AS k6-build
ARG K6_VERSION
ARG K6_COMMIT
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
RUN apk add --no-cache git
RUN set -eux; \
    git clone --depth 1 --branch "v${K6_VERSION}" https://github.com/grafana/k6.git /src/k6; \
    got="$(git -C /src/k6 rev-parse HEAD)"; \
    [ "$got" = "${K6_COMMIT}" ] || { echo "k6 v${K6_VERSION} resolved to $got, expected ${K6_COMMIT}" >&2; exit 1; }
WORKDIR /src/k6
RUN set -eux; \
    cp go.mod /tmp/k6.mod; cp go.sum /tmp/k6.sum; \
    for attempt in 1 2 3 4 5; do \
      go get -modfile=/tmp/k6.mod golang.org/x/net@v0.62.0 github.com/andybalholm/brotli@v1.2.8 \
        && go mod download -modfile=/tmp/k6.mod all && break; \
      echo "go get/mod download failed (attempt $attempt/5)" >&2; sleep $((attempt * 5)); \
    done; \
    go build -mod=readonly -modfile=/tmp/k6.mod -trimpath \
      -ldflags "-s -w -X go.k6.io/k6/v2/internal/build.BuildOrigin=release" \
      -o /out/k6 .; \
    /out/k6 version; \
    go version -m /out/k6

FROM plugin-base:26.10

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

ARG K6_VERSION

# ─── k6 (built from source above) ───
COPY --from=k6-build /out/k6 /usr/local/bin/k6
RUN chmod 0755 /usr/local/bin/k6

# ─── Runtime configuration defaults ───
ENV K6_VERSION=${K6_VERSION}
ENV K6_SCRIPT=""
ENV K6_VUS=10
ENV K6_DURATION=30s
ENV K6_THRESHOLDS=""

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
