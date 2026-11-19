# ACR Push Plugin — Push Container Images to Azure Container Registry
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Builds Docker images and pushes to ACR using Azure CLI service principal authentication
# Requires AZURE_CLIENT_ID + AZURE_CLIENT_SECRET + AZURE_TENANT_ID at runtime

FROM plugin-base:26.10

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

RUN apt-retry-install lsb-release

# ─── Docker CLI + Buildx ───
# Signing key pinned by fingerprint (Docker's published CE release key) —
# fetch-apt-key refuses a rotated or substituted key.
RUN fetch-apt-key https://download.docker.com/linux/ubuntu/gpg /usr/share/keyrings/docker-archive-keyring.gpg \
       9DC858229FC7DD38854AE2D88D81803C0EBFCD88 \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list \
    && apt-retry-install docker-ce-cli docker-buildx-plugin

# ─── Azure CLI (az) ───
# Microsoft release-signing key pinned by fingerprint.
# Microsoft publishes the azure-cli apt repo per Ubuntu release and has none
# for 26.10 ("stonking": no Release file), so `lsb_release -cs` broke the
# build. Pinned to the newest one it serves; azure-cli bundles its own Python
# under /opt/az, so the noble package does not depend on the OS Python.
ARG AZURE_CLI_DIST=noble
RUN fetch-apt-key https://packages.microsoft.com/keys/microsoft.asc /usr/share/keyrings/microsoft-archive-keyring.gpg \
       BC528686B50D79E339D3721CEB3E94ADBE1229CF \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/microsoft-archive-keyring.gpg] https://packages.microsoft.com/repos/azure-cli/ ${AZURE_CLI_DIST} main" \
    > /etc/apt/sources.list.d/azure-cli.list \
    && apt-retry-install azure-cli

# ─── No pyjwt override ───
# This image used to `pip install --upgrade pyjwt==2.15.1` into azure-cli's
# bundled Python (/opt/az): azure-cli 2.90.0 shipped pyjwt 2.13.0, carrying
# GHSA-ffc3-869f-jxw9 (Critical, fixed in 2.14.0). Removed 2026-11-18, as the
# block itself instructed, because azure-cli now ships the fix: 2.92.0 and the
# current 2.93.0 bundle PyJWT 2.15.0 (src/azure-cli/requirements.py3.Linux.txt;
# no OSV advisory). If the gate ever flags /opt/az's pyjwt again, re-add an
# exact-pinned override. Check with:
#   docker run --rm <image> /opt/az/bin/python3 -c 'import jwt; print(jwt.__version__)'

# ─── Runtime configuration defaults ───
# Non-sensitive config only — AZURE_CLIENT_ID/SECRET/TENANT_ID injected at runtime
ENV ACR_REGISTRY=""
ENV IMAGE_NAME=""
ENV IMAGE_TAG=latest
ENV DOCKERFILE_PATH=Dockerfile
ENV DOCKER_CONTEXT=.

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
