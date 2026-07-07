# Veracode Plugin — Enterprise SAST/DAST Security Scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Uploads application artifacts for Veracode static/dynamic analysis
# Requires VERACODE_API_ID and VERACODE_API_KEY at runtime

FROM pipeline-plugin-base:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    git zip unzip curl wget jq ca-certificates \
    openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

# ─── Veracode CLI ───
# NOTE: Veracode distributes the CLI only via a rolling installer script (no
# per-version URL), so this tracks upstream latest by design. Pin the pipeline
# scanner (below) for the reproducible piece of the scan.
RUN curl -fsSL https://tools.veracode.com/veracode-cli/install | sh

# ─── Veracode Pipeline Scanner (lightweight static analysis) ───
# Pinnable: `--build-arg VERACODE_PIPELINE_SCAN_VERSION=24.10.0`. Defaults to
# LATEST to preserve current behavior; CI should pass an explicit version.
ARG VERACODE_PIPELINE_SCAN_VERSION=LATEST
RUN mkdir -p /opt/veracode \
    && curl -fsSL https://downloads.veracode.com/securityscan/pipeline-scan-${VERACODE_PIPELINE_SCAN_VERSION}.zip \
    -o /tmp/pipeline-scan.zip \
    && unzip -q /tmp/pipeline-scan.zip -d /opt/veracode \
    && rm /tmp/pipeline-scan.zip

# Non-sensitive config only — API credentials injected at runtime
ENV VERACODE_SCAN_TYPE=pipeline
ENV VERACODE_APP_NAME=""
ENV VERACODE_SEVERITY_THRESHOLD=Medium
ENV VERACODE_ARTIFACT=""

WORKDIR /app
CMD ["bash"]
