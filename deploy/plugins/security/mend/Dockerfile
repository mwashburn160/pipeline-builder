# Mend Plugin — SCA License + Vulnerability Scanning (formerly WhiteSource)
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans dependencies for known CVEs and license compliance issues
# Requires MEND_API_KEY and MEND_ORG_TOKEN at runtime

FROM pipeline-plugin-base:24.04

# Build steps below need root (apt, writes under /usr/local); the image drops
# back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

# git/zip/unzip/curl/jq/ca-certificates already come from the base.
RUN apt-retry-install openjdk-17-jre-headless

# ─── Mend CLI (direct binary download) ───
# Pinned: Mend serves per-version builds under production/unified/<version>/
# (the rolling `cli/linux_<arch>/mend` URL tracked latest), each with a
# published `mend.sha256` — those are the digests below.
ARG MEND_VERSION=26.8.2.6
ARG MEND_SHA256_AMD64=0384d0f79c2df3a7179b281350574d1240efe2ce81d44ba0b2ea7bee285adfa2
ARG MEND_SHA256_ARM64=69d560a604d5d5ae089f9b07f4b43a85c9bdaf45e5b251dd404b0eb388d24660
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=amd64; sum="${MEND_SHA256_AMD64}" ;; \
      arm64) arch=arm64; sum="${MEND_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://downloads.mend.io/production/unified/${MEND_VERSION}/linux_${arch}/mend" "$sum" /usr/local/bin/mend; \
    chmod 0755 /usr/local/bin/mend

# Non-sensitive config only
ENV MEND_URL=https://saas.mend.io
ENV MEND_PRODUCT_NAME=""
ENV MEND_PROJECT_NAME=""
ENV MEND_SCAN_TYPE=sca

WORKDIR /app
USER 1000:1000
CMD ["bash"]
