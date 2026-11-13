# Docker Lint Plugin — Dockerfile best practices & container image scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Combines Hadolint (Dockerfile linting) + Dockle (built image security audit)
# Validates Dockerfile quality and CIS benchmark compliance

# ─── Tool versions (override with --build-arg) ───
ARG HADOLINT_VERSION=2.15.1
ARG DOCKLE_VERSION=0.4.15
# The commit the v${DOCKLE_VERSION} tag must resolve to (checked after clone).
ARG DOCKLE_COMMIT=54368575d2a0c34a82fb05c904b8207284a64891
# Same pinned toolchain as api/plugin's tools stage.
ARG GO_IMAGE=golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf

FROM hadolint/hadolint:v${HADOLINT_VERSION} AS hadolint-src

# ─── Dockle, built from source ───
# The published dockle image (latest release v0.4.15, January 2025) is built
# with go1.22.10, whose stdlib carries Critical, fixable advisories
# (GO-2025-3563, GO-2026-4337). Upstream has not released since, so build the
# same tagged source with a current toolchain. Source integrity: the tag must
# resolve to the pinned commit, or the build fails.
FROM ${GO_IMAGE} AS dockle-build
ARG DOCKLE_VERSION
ARG DOCKLE_COMMIT
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
RUN apk add --no-cache git
RUN set -eux; \
    git clone --depth 1 --branch "v${DOCKLE_VERSION}" https://github.com/goodwithtech/dockle.git /src/dockle; \
    got="$(git -C /src/dockle rev-parse HEAD)"; \
    [ "$got" = "${DOCKLE_COMMIT}" ] || { echo "dockle v${DOCKLE_VERSION} resolved to $got, expected ${DOCKLE_COMMIT}" >&2; exit 1; }
WORKDIR /src/dockle
RUN set -eux; \
    for attempt in 1 2 3 4 5; do go mod download && break; echo "go mod download failed (attempt $attempt/5)" >&2; sleep $((attempt * 5)); done; \
    go build -mod=readonly -trimpath \
      -ldflags "-s -w -X github.com/goodwithtech/dockle/pkg.version=${DOCKLE_VERSION}" \
      -o /out/dockle ./cmd/dockle; \
    /out/dockle --version

FROM plugin-base:26.10

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

# Re-declare ARGs after FROM so they're available in this stage
ARG HADOLINT_VERSION
ARG DOCKLE_VERSION

# ─── Hadolint — Dockerfile linter (copied from official image) ───
COPY --from=hadolint-src /bin/hadolint /usr/local/bin/hadolint
RUN chmod 0755 /usr/local/bin/hadolint

# ─── Dockle — Container image security linter (built from source above) ───
COPY --from=dockle-build /out/dockle /usr/local/bin/dockle
RUN chmod 0755 /usr/local/bin/dockle

# ─── Runtime configuration defaults ───
ENV HADOLINT_VERSION=${HADOLINT_VERSION}
ENV DOCKLE_VERSION=${DOCKLE_VERSION}
ENV DOCKER_IMAGE=""
ENV HADOLINT_FORMAT=json
ENV DOCKLE_FORMAT=json
ENV HADOLINT_SEVERITY=warning

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
