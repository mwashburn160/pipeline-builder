# k6 Plugin — Performance and Load Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs k6 load tests with configurable VUs, duration, and thresholds
# Multi-version support

# ─── Tool versions (override with --build-arg) ───
ARG K6_VERSION=2.3.0
ARG K6_PREV_VERSION=1.8.1

FROM grafana/k6:${K6_VERSION} AS k6-default
FROM grafana/k6:${K6_PREV_VERSION} AS k6-prev

FROM pipeline-plugin-base:24.04

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

ARG K6_VERSION
ARG K6_PREV_VERSION

# ─── k6 — multi-version support (copied from official images) ───
RUN mkdir -p /opt/k6/versions
COPY --from=k6-default /usr/bin/k6 /opt/k6/versions/k6-${K6_VERSION}
COPY --from=k6-prev /usr/bin/k6 /opt/k6/versions/k6-${K6_PREV_VERSION}
# The active version is a symlink in /opt/k6/bin (first on PATH, owned by the
# plugin user) so the spec's runtime K6_VERSION switch can re-point it without root.
RUN install -d -o 1000 -g 1000 /opt/k6/bin \
    && ln -sf /opt/k6/versions/k6-${K6_VERSION} /opt/k6/bin/k6 \
    && chown -h 1000:1000 /opt/k6/bin/k6
ENV PATH="/opt/k6/bin:${PATH}"

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
