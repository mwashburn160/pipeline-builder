# Docker Lint Plugin — Dockerfile best practices & container image scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Combines Hadolint (Dockerfile linting) + Dockle (built image security audit)
# Validates Dockerfile quality and CIS benchmark compliance

# ─── Tool versions (override with --build-arg) ───
ARG HADOLINT_VERSION=2.15.1
ARG HADOLINT_PREV_VERSION=2.14.0
ARG DOCKLE_VERSION=0.4.15
ARG DOCKLE_PREV_VERSION=0.4.14

FROM hadolint/hadolint:v${HADOLINT_VERSION} AS hadolint-default
FROM hadolint/hadolint:v${HADOLINT_PREV_VERSION} AS hadolint-prev
FROM goodwithtech/dockle:v${DOCKLE_VERSION} AS dockle-default
FROM goodwithtech/dockle:v${DOCKLE_PREV_VERSION} AS dockle-prev

FROM pipeline-plugin-base:24.04

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

# Re-declare ARGs after FROM so they're available in this stage
ARG HADOLINT_VERSION
ARG HADOLINT_PREV_VERSION
ARG DOCKLE_VERSION
ARG DOCKLE_PREV_VERSION

# ─── Hadolint — Dockerfile linter (copied from official image) ───
RUN mkdir -p /opt/hadolint/versions
COPY --from=hadolint-default /bin/hadolint /opt/hadolint/versions/hadolint-${HADOLINT_VERSION}
COPY --from=hadolint-prev /bin/hadolint /opt/hadolint/versions/hadolint-${HADOLINT_PREV_VERSION}
# The active version is a symlink in /opt/hadolint/bin (first on PATH, owned by the
# plugin user) so the spec's runtime HADOLINT_VERSION switch can re-point it without root.
RUN install -d -o 1000 -g 1000 /opt/hadolint/bin \
    && ln -sf /opt/hadolint/versions/hadolint-${HADOLINT_VERSION} /opt/hadolint/bin/hadolint \
    && chown -h 1000:1000 /opt/hadolint/bin/hadolint
ENV PATH="/opt/hadolint/bin:${PATH}"

# ─── Dockle — Container image security linter (copied from official image) ───
RUN mkdir -p /opt/dockle/versions
COPY --from=dockle-default /usr/bin/dockle /opt/dockle/versions/dockle-${DOCKLE_VERSION}
COPY --from=dockle-prev /usr/bin/dockle /opt/dockle/versions/dockle-${DOCKLE_PREV_VERSION}
# The active version is a symlink in /opt/dockle/bin (first on PATH, owned by the
# plugin user) so the spec's runtime DOCKLE_VERSION switch can re-point it without root.
RUN install -d -o 1000 -g 1000 /opt/dockle/bin \
    && ln -sf /opt/dockle/versions/dockle-${DOCKLE_VERSION} /opt/dockle/bin/dockle \
    && chown -h 1000:1000 /opt/dockle/bin/dockle
ENV PATH="/opt/dockle/bin:${PATH}"

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
