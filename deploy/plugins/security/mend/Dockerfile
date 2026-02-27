# Mend Plugin — SCA License + Vulnerability Scanning (formerly WhiteSource)
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans dependencies for known CVEs and license compliance issues
# Requires MEND_API_KEY and MEND_ORG_TOKEN at runtime

FROM public.ecr.aws/docker/library/ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    git zip unzip curl wget jq ca-certificates \
    openjdk-17-jre-headless nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# ─── Mend CLI ───
RUN npm install -g @mend-io/cli

# Non-sensitive config only
ENV MEND_URL=https://saas.mend.io
ENV MEND_PRODUCT_NAME=""
ENV MEND_PROJECT_NAME=""
ENV MEND_SCAN_TYPE=sca
ENV MEND_SEVERITY_THRESHOLD=medium

WORKDIR /app
CMD ["bash"]
