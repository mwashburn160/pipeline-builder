# Fortify Plugin — Micro Focus Enterprise SAST
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Static code analysis using Fortify on Demand (FoD) or Fortify ScanCentral
# Requires FORTIFY_SSC_TOKEN or FOD_TENANT/CLIENT_ID/SECRET at runtime

FROM pipeline-plugin-base:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    git zip unzip curl wget jq ca-certificates \
    openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

# ─── Fortify CLI (fcli) ───
# Multi-arch: fortify ships fcli-linux.tgz (x64) and fcli-linux_arm64.tgz.
RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
         amd64) FCLI_FILE=fcli-linux.tgz ;; \
         arm64) FCLI_FILE=fcli-linux_arm64.tgz ;; \
         *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/fortify/fcli/releases/download/v2.12.0/${FCLI_FILE}" \
       | tar -xz -C /usr/local/bin

# Non-sensitive config only
ENV FORTIFY_SCAN_TYPE=fod
ENV FORTIFY_APP_NAME=""
ENV FORTIFY_RELEASE=""
ENV FOD_URL=https://ams.fortify.com
ENV SSC_URL=""

WORKDIR /app
CMD ["bash"]
