# Mend Plugin — SCA License + Vulnerability Scanning (formerly WhiteSource)
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans dependencies for known CVEs and license compliance issues
# Requires MEND_API_KEY and MEND_ORG_TOKEN at runtime

FROM pipeline-plugin-base:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    git zip unzip curl jq ca-certificates \
    openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

# ─── Mend CLI (direct binary download) ───
RUN ARCH=$(dpkg --print-architecture) && curl -fsSL "https://downloads.mend.io/cli/linux_${ARCH}/mend" -o /usr/local/bin/mend \
    && chmod +x /usr/local/bin/mend

# Non-sensitive config only
ENV MEND_URL=https://saas.mend.io
ENV MEND_PRODUCT_NAME=""
ENV MEND_PROJECT_NAME=""
ENV MEND_SCAN_TYPE=sca
ENV MEND_SEVERITY_THRESHOLD=medium

WORKDIR /app
CMD ["bash"]
