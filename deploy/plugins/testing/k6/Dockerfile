# k6 Plugin — Performance and Load Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs k6 load tests with configurable VUs, duration, and thresholds
# Multi-version support

# ─── Tool versions (override with --build-arg) ───
ARG K6_VERSION=2.3.0

FROM grafana/k6:${K6_VERSION} AS k6-src

FROM plugin-base:24.04

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

ARG K6_VERSION

# ─── k6 — multi-version support (copied from official images) ───
COPY --from=k6-src /usr/bin/k6 /usr/local/bin/k6
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
