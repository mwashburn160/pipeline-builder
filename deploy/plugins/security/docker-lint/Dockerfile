# Docker Lint Plugin — Dockerfile best practices & container image scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Combines Hadolint (Dockerfile linting) + Dockle (built image security audit)
# Validates Dockerfile quality and CIS benchmark compliance

# ─── Tool versions (override with --build-arg) ───
ARG HADOLINT_VERSION=2.15.1
ARG DOCKLE_VERSION=0.4.15
# The commit the v${DOCKLE_VERSION} tag must resolve to (checked after clone).
ARG DOCKLE_COMMIT=54368575d2a0c34a82fb05c904b8207284a64891

FROM hadolint/hadolint:v${HADOLINT_VERSION} AS hadolint-src

# ─── Dockle, built from source ───
# The published dockle image (latest release v0.4.15, January 2025) is built
# with go1.22.10, whose stdlib carries Critical, fixable advisories
# (GO-2025-3563, GO-2026-4337). Upstream has not released since, so dockle is
# COMPILED HERE from its own tag on plugin-go-base (go1.27.3), the way
# testing/k6 and security/git-secrets build theirs. No module needs raising:
# the Criticals are all the toolchain's. Build flags follow upstream's
# goreleaser (version stamped into pkg.version).
FROM plugin-go-base:1.0 AS dockle-src
ARG DOCKLE_VERSION
ARG DOCKLE_COMMIT
USER root
# RETRIED like the other source-built plugins (security/git-secrets,
# testing/k6): github.com and proxy.golang.org both fail intermittently, and a
# cold catalogue load does this a hundred times over. The tag must resolve to
# the pinned commit — the integrity check a release checksum used to give.
RUN set -eux; \
    for attempt in 1 2 3 4 5; do \
      rm -rf /src; \
      if git clone --depth 1 --branch "v${DOCKLE_VERSION}" https://github.com/goodwithtech/dockle.git /src; then break; fi; \
      echo "dockle clone failed (attempt $attempt/5); retrying" >&2; \
      sleep $((attempt * 5)); \
    done; \
    test -d /src/.git; \
    got="$(git -C /src rev-parse HEAD)"; \
    [ "$got" = "${DOCKLE_COMMIT}" ] || { echo "dockle v${DOCKLE_VERSION} resolved to $got, expected ${DOCKLE_COMMIT}" >&2; exit 1; }
RUN set -eux; \
    cd /src; \
    mkdir -p /out; \
    for attempt in 1 2 3 4 5; do \
      if CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X github.com/goodwithtech/dockle/pkg.version=${DOCKLE_VERSION}" -o /out/dockle ./cmd/dockle; then \
        break; \
      fi; \
      echo "dockle build failed (attempt $attempt/5); retrying" >&2; \
      sleep $((attempt * 5)); \
    done; \
    test -x /out/dockle; \
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
COPY --from=dockle-src /out/dockle /usr/local/bin/dockle
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
