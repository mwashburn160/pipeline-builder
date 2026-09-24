# Pipeline Builder — Trivy Family Base Image
#
# Built tag: pipeline-trivy-base:1.0
#
# Used as the FROM by the single language-agnostic `trivy` plugin.
# `trivy fs`/`trivy config` scan lockfiles and IaC/config statically, so no
# language runtime is layered on top — the plugin's Dockerfile is just
# `FROM pipeline-trivy-base:1.0` + WORKDIR/CMD.
# Bundles two pinned trivy versions for runtime selection.

ARG TRIVY_VERSION=0.74.0
ARG TRIVY_PREV_VERSION=0.73.0

FROM aquasec/trivy:${TRIVY_VERSION} AS trivy-default
FROM aquasec/trivy:${TRIVY_PREV_VERSION} AS trivy-prev

FROM pipeline-plugin-base:24.04
ARG TRIVY_VERSION
ARG TRIVY_PREV_VERSION

# Two trivy versions. The active one is a symlink in /opt/trivy/bin (first on
# PATH, owned by the plugin user) so the plugin's runtime TRIVY_VERSION switch
# can re-point it without root. Only these baked versions are selectable — no
# runtime download (every binary in the catalog is pinned at build time).
USER root
COPY --from=trivy-prev /usr/local/bin/trivy /opt/trivy/versions/trivy-${TRIVY_PREV_VERSION}
COPY --from=trivy-default /usr/local/bin/trivy /opt/trivy/versions/trivy-${TRIVY_VERSION}
RUN install -d -o 1000 -g 1000 /opt/trivy/bin \
    && ln -sf /opt/trivy/versions/trivy-${TRIVY_VERSION} /opt/trivy/bin/trivy \
    && chown -h 1000:1000 /opt/trivy/bin/trivy
ENV PATH="/opt/trivy/bin:${PATH}"

ENV TRIVY_VERSION=${TRIVY_VERSION}
ENV TRIVY_SEVERITY=HIGH,CRITICAL
ENV TRIVY_FORMAT=json

WORKDIR /app
USER 1000:1000
CMD ["bash"]
