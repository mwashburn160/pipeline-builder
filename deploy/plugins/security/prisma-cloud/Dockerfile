# Prisma Cloud Plugin — Container + IaC Security (Twistlock/Palo Alto)
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans container images and IaC templates for vulnerabilities and compliance
# Requires PRISMA_ACCESS_KEY and PRISMA_SECRET_KEY at runtime

FROM public.ecr.aws/docker/library/ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    git zip unzip curl wget jq ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ─── Prisma Cloud (twistcli) ───
# twistcli is downloaded at runtime from the Prisma Cloud console URL
# This ensures version compatibility with your console

# ─── Checkov (Prisma Cloud IaC scanner - open source) ───
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
    && pip3 install --no-cache-dir checkov==3.2.345 \
    && rm -rf /var/lib/apt/lists/*

# Non-sensitive config only
ENV PRISMA_CONSOLE_URL=""
ENV PRISMA_SCAN_TYPE=iac
ENV PRISMA_SEVERITY=high
ENV DOCKER_IMAGE=""

WORKDIR /app
CMD ["bash"]
