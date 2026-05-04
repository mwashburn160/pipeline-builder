# Flyway Plugin — Database Migration
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs Flyway database migrations (migrate, repair, info, validate, clean)
#
# Multistage rationale:
#   - The `flyway-commandline-X-linux-x64.tar.gz` includes a bundled JRE
#     (~150 MB). The previous single-stage Dockerfile ALSO apt-installed
#     openjdk-17-jre-headless — paying for two JREs simultaneously. The
#     bundled JRE works fine, so apt openjdk is gone.
#   - The flyway tarball ships /docs/ (~8 MB), /lib/community/ (alternate
#     drivers), and source/license files we don't need at runtime. Builder
#     stage extracts everything; runtime stage gets only what we use.
#   - Net savings: ~200 MB per image vs the previous Dockerfile.

FROM pipeline-plugin-base:24.04 AS builder

ARG FLYWAY_VERSION=10.22.0

# Multi-arch: Flyway publishes -linux-x64 and -linux-arm64 tarballs since v10.
# `dpkg --print-architecture` gives us amd64/arm64 directly.
RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
         amd64) FLYWAY_ARCH=x64 ;; \
         arm64) FLYWAY_ARCH=arm64 ;; \
         *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://repo1.maven.org/maven2/org/flywaydb/flyway-commandline/${FLYWAY_VERSION}/flyway-commandline-${FLYWAY_VERSION}-linux-${FLYWAY_ARCH}.tar.gz" \
         -o /tmp/flyway.tar.gz \
    && tar -xzf /tmp/flyway.tar.gz -C /opt \
    && rm /tmp/flyway.tar.gz \
    # Drop directories we never use at runtime. /jars/ stays (Flyway core),
    # /lib/ stays (built-in drivers), /jre/ stays (the JRE this image will
    # actually use), /sql/ stays (sample SQL), /conf/ stays (defaults).
    && rm -rf /opt/flyway-${FLYWAY_VERSION}/docs \
              /opt/flyway-${FLYWAY_VERSION}/source \
              /opt/flyway-${FLYWAY_VERSION}/README.txt

# ───────────────────────────────────────────────────────────
FROM pipeline-plugin-base:24.04

ARG FLYWAY_VERSION=10.22.0
COPY --from=builder /opt/flyway-${FLYWAY_VERSION} /opt/flyway-${FLYWAY_VERSION}
RUN ln -s /opt/flyway-${FLYWAY_VERSION}/flyway /usr/local/bin/flyway

# ─── Runtime configuration defaults ───
ENV FLYWAY_URL=""
ENV FLYWAY_SCHEMAS=""
ENV FLYWAY_LOCATIONS=filesystem:./sql
ENV FLYWAY_ACTION=migrate
ENV FLYWAY_BASELINE_ON_MIGRATE=false
ENV FLYWAY_OUT_OF_ORDER=false

WORKDIR /app
CMD ["bash"]
