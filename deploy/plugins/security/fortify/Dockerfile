# Fortify Plugin — Micro Focus Enterprise SAST
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Static code analysis using Fortify on Demand (FoD) or Fortify ScanCentral
# Requires FORTIFY_SSC_TOKEN or FOD_TENANT/CLIENT_ID/SECRET at runtime

FROM plugin-base:24.04

# Build steps below need root (apt, writes under /usr/local); the image drops
# back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

# git/zip/unzip/curl/wget/jq/ca-certificates already come from the base.
RUN apt-retry-install openjdk-17-jre-headless

# ─── Fortify CLI (fcli) ───
# Pinned release + pinned digest (the release's fcli-linux.tgz.sha256).
# fcli ${FCLI_VERSION} publishes a linux x64 build only (the
# `fcli-linux_arm64.tgz` asset this used to reference does not exist) — fail
# loudly on any other architecture.
ARG FCLI_VERSION=3.28.2
ARG FCLI_SHA256_AMD64=5bc644421635ac18968475e6b2205d89b966157906bb529d4d477c1b760f0b68
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) FCLI_FILE=fcli-linux.tgz; sum="${FCLI_SHA256_AMD64}" ;; \
      *) echo "fcli ${FCLI_VERSION}: no linux build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://github.com/fortify/fcli/releases/download/v${FCLI_VERSION}/${FCLI_FILE}" "$sum" /tmp/fcli.tgz; \
    tar -xzf /tmp/fcli.tgz -C /usr/local/bin; \
    rm -f /tmp/fcli.tgz; \
    fcli --version

# Non-sensitive config only
ENV FORTIFY_SCAN_TYPE=fod
ENV FORTIFY_APP_NAME=""
ENV FORTIFY_RELEASE=""
ENV FOD_URL=https://ams.fortify.com
ENV SSC_URL=""

WORKDIR /app
USER 1000:1000
CMD ["bash"]
