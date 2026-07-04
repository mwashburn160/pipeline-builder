# Pipeline Builder — Trivy Family Base Image
#
# Built tag: pipeline-trivy-base:1.0
#
# Used as the FROM by the single language-agnostic `trivy` plugin.
# `trivy fs`/`trivy config` scan lockfiles and IaC/config statically, so no
# language runtime is layered on top — the plugin's Dockerfile is just
# `FROM pipeline-trivy-base:1.0` + WORKDIR/CMD.
# Bundles two pinned trivy versions for runtime selection.

ARG TRIVY_VERSION=0.69.3
ARG TRIVY_PREV_VERSION=0.68.2

FROM aquasec/trivy:${TRIVY_VERSION} AS trivy-default
FROM aquasec/trivy:${TRIVY_PREV_VERSION} AS trivy-prev

FROM pipeline-plugin-base:24.04
ARG TRIVY_VERSION
ARG TRIVY_PREV_VERSION

# Two trivy versions; default symlinked to /usr/local/bin/trivy.
RUN mkdir -p /opt/trivy/versions
COPY --from=trivy-prev /usr/local/bin/trivy /opt/trivy/versions/trivy-${TRIVY_PREV_VERSION}
COPY --from=trivy-default /usr/local/bin/trivy /opt/trivy/versions/trivy-${TRIVY_VERSION}
RUN ln -sf /opt/trivy/versions/trivy-${TRIVY_VERSION} /usr/local/bin/trivy

ENV TRIVY_VERSION=${TRIVY_VERSION}
ENV TRIVY_SEVERITY=HIGH,CRITICAL
ENV TRIVY_FORMAT=json
