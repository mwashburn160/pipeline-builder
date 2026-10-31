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

FROM plugin-base:26.10 AS builder

# Builder stage extracts under /opt — needs root (the base ends as uid 1000).
USER root

ARG FLYWAY_VERSION=13.11.1
# Pinned digest — SHA-256 of the Redgate Maven artifact (Flyway CLI tarballs
# moved off Maven Central; Redgate publishes only SHA-1/MD5 for them, and the
# SHA-1 was cross-checked against the published .sha1).
ARG FLYWAY_SHA256_AMD64=c5397ad1c58dbbac94682f29322ec54896f15e9827c5dc3e02ca40240077d3f7

# Flyway ${FLYWAY_VERSION} publishes a linux-x64 tarball only (no linux-arm64 on
# Redgate's Maven host for this release) — fail loudly on any other architecture
# rather than 404 mid-build.
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) FLYWAY_ARCH=x64; sum="${FLYWAY_SHA256_AMD64}" ;; \
      *) echo "flyway ${FLYWAY_VERSION}: no linux build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://download.red-gate.com/maven/release/com/redgate/flyway/flyway-commandline/${FLYWAY_VERSION}/flyway-commandline-${FLYWAY_VERSION}-linux-${FLYWAY_ARCH}.tar.gz" "$sum" /tmp/flyway.tar.gz; \
    tar --no-same-owner -xzf /tmp/flyway.tar.gz -C /opt \
    && rm /tmp/flyway.tar.gz \
    # The tarball ships the `flyway` launcher as 0744 (owner-only execute) —
    # open read/execute to everyone so the uid-1000 runtime user can run it.
    && chmod -R a+rX /opt/flyway-${FLYWAY_VERSION} \
    # Drop directories we never use at runtime. /jars/ stays (Flyway core),
    # /lib/ stays (built-in drivers), /jre/ stays (the JRE this image will
    # actually use), /sql/ stays (sample SQL), /conf/ stays (defaults).
    && rm -rf /opt/flyway-${FLYWAY_VERSION}/docs \
              /opt/flyway-${FLYWAY_VERSION}/source \
              /opt/flyway-${FLYWAY_VERSION}/README.txt

# ───────────────────────────────────────────────────────────
FROM plugin-base:26.10

# Root for the /usr/local/bin symlink; dropped to uid 1000 at the end.
USER root

ARG FLYWAY_VERSION=13.11.1
COPY --from=builder /opt/flyway-${FLYWAY_VERSION} /opt/flyway-${FLYWAY_VERSION}
RUN ln -s /opt/flyway-${FLYWAY_VERSION}/flyway /usr/local/bin/flyway

# Flyway 13 shells out to RGCompare, a bundled .NET binary, on every command
# (even `--version`). .NET needs ICU, which the 26.10 base does not carry
# ("Couldn't find a valid ICU package" -> abort, exit 134), and OpenSSL 3,
# where 26.10 ships only OpenSSL 4 — the same pair plugin-dotnet-base installs.
RUN apt-retry-install libicu78 libssl3t64

# ─── Runtime configuration defaults ───
ENV FLYWAY_URL=""
ENV FLYWAY_SCHEMAS=""
ENV FLYWAY_LOCATIONS=filesystem:./sql
ENV FLYWAY_ACTION=migrate
ENV FLYWAY_BASELINE_ON_MIGRATE=false
ENV FLYWAY_OUT_OF_ORDER=false

WORKDIR /app
USER 1000:1000
CMD ["bash"]
