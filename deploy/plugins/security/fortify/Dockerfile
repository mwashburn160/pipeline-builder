# Fortify Plugin — Micro Focus Enterprise SAST
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Static code analysis using Fortify on Demand (FoD) or Fortify ScanCentral
# Requires FORTIFY_SSC_TOKEN or FOD_TENANT/CLIENT_ID/SECRET at runtime

FROM public.ecr.aws/docker/library/ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    git zip unzip curl wget jq ca-certificates \
    openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

# ─── Fortify CLI (fcli) ───
RUN curl -fsSL https://github.com/fortify/fcli/releases/download/v2.12.0/fcli-linux.tgz \
    | tar -xz -C /usr/local/bin

# Non-sensitive config only
ENV FORTIFY_SCAN_TYPE=fod
ENV FORTIFY_APP_NAME=""
ENV FORTIFY_RELEASE=""
ENV FOD_URL=https://ams.fortify.com
ENV SSC_URL=""

WORKDIR /app
CMD ["bash"]
