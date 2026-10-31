# Prisma Cloud Plugin — Container + IaC Security (Twistlock/Palo Alto)
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans container images and IaC templates for vulnerabilities and compliance
# Requires PRISMA_ACCESS_KEY and PRISMA_SECRET_KEY at runtime

FROM plugin-base:26.10

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

# ─── Prisma Cloud (twistcli) ───
# twistcli is downloaded at runtime from the Prisma Cloud console URL
# This ensures version compatibility with your console

# ─── Checkov (Prisma Cloud IaC scanner - open source) ───
# In its own virtualenv, not the system Python: on 26.10, python3-pip pulls the
# Debian `packaging` 26.2, which checkov needs replaced, and pip cannot uninstall
# a Debian-installed package ("uninstall-no-record-file"), so a
# --break-system-packages install failed. The venv also keeps checkov's
# dependencies from clobbering the OS's. `checkov` stays on PATH.
RUN apt-retry-install python3 python3-venv \
    && python3 -m venv /opt/checkov \
    && /opt/checkov/bin/pip install --no-cache-dir checkov==3.3.19 \
    && ln -s /opt/checkov/bin/checkov /usr/local/bin/checkov \
    && checkov --version

# Non-sensitive config only
ENV PRISMA_CONSOLE_URL=""
ENV PRISMA_SCAN_TYPE=iac
ENV PRISMA_SEVERITY=high
ENV DOCKER_IMAGE=""

WORKDIR /app
USER 1000:1000
CMD ["bash"]
