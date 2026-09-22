# Prisma Cloud Plugin — Container + IaC Security (Twistlock/Palo Alto)
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans container images and IaC templates for vulnerabilities and compliance
# Requires PRISMA_ACCESS_KEY and PRISMA_SECRET_KEY at runtime

FROM pipeline-plugin-base:24.04

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

# ─── Prisma Cloud (twistcli) ───
# twistcli is downloaded at runtime from the Prisma Cloud console URL
# This ensures version compatibility with your console

# ─── Checkov (Prisma Cloud IaC scanner - open source) ───
RUN apt-retry-install python3 python3-pip \
    && pip3 install --no-cache-dir --break-system-packages checkov==3.3.19

# Non-sensitive config only
ENV PRISMA_CONSOLE_URL=""
ENV PRISMA_SCAN_TYPE=iac
ENV PRISMA_SEVERITY=high
ENV DOCKER_IMAGE=""

WORKDIR /app
USER 1000:1000
CMD ["bash"]
