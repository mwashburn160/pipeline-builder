# Docker Lint Plugin — Dockerfile best practices & container image scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Combines Hadolint (Dockerfile linting) + Dockle (built image security audit)
# Validates Dockerfile quality and CIS benchmark compliance

# ─── Tool versions (override with --build-arg) ───
ARG HADOLINT_VERSION=2.15.1
ARG DOCKLE_VERSION=0.4.15

FROM hadolint/hadolint:v${HADOLINT_VERSION} AS hadolint-src
FROM goodwithtech/dockle:v${DOCKLE_VERSION} AS dockle-src

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

# ─── Dockle — Container image security linter (copied from official image) ───
COPY --from=dockle-src /usr/bin/dockle /usr/local/bin/dockle
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
