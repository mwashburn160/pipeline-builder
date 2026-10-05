# ACR Push Plugin — Push Container Images to Azure Container Registry
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Builds Docker images and pushes to ACR using Azure CLI service principal authentication
# Requires AZURE_CLIENT_ID + AZURE_CLIENT_SECRET + AZURE_TENANT_ID at runtime

FROM plugin-base:24.04

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
RUN fetch-apt-key https://packages.microsoft.com/keys/microsoft.asc /usr/share/keyrings/microsoft-archive-keyring.gpg \
       BC528686B50D79E339D3721CEB3E94ADBE1229CF \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/microsoft-archive-keyring.gpg] https://packages.microsoft.com/repos/azure-cli/ $(lsb_release -cs) main" \
    > /etc/apt/sources.list.d/azure-cli.list \
    && apt-retry-install azure-cli

# ─── CVE remediation inside azure-cli's bundled Python ───
# azure-cli ships its own interpreter and site-packages under /opt/az, so its
# Python dependencies are NOT apt packages and do not move when the distro
# patches. 2.90.0 bundles pyjwt 2.13.0, which carries GHSA-ffc3-869f-jxw9
# (Critical, fixed in 2.14.0) — the single fixable Critical that failed this
# image's PLUGIN_VULN_GATE. Nothing in our Dockerfile selects that version;
# upgrading it in place is the only lever short of dropping azure-cli.
#
# Pinned exactly, like every other version here, so the image is reproducible.
# The gate is what tells you to move it: when a build fails on pyjwt again, bump
# this pin to the version the message names.
#
# DELETE this block once azure-cli itself ships a patched pyjwt — pip keeps the
# newer of the two, so a stale override would silently pin the CLI's dependency
# BELOW what Microsoft ships. Check with:
#   docker run --rm <image> /opt/az/bin/python3 -c 'import jwt; print(jwt.__version__)'
ARG AZ_PYJWT_VERSION=2.15.1
RUN set -eux; \
    /opt/az/bin/python3 -m pip install --no-cache-dir --upgrade "pyjwt==${AZ_PYJWT_VERSION}"; \
    /opt/az/bin/python3 -c "import jwt, sys; sys.exit(0 if jwt.__version__ == '${AZ_PYJWT_VERSION}' else 1)"; \
    az version --output tsv >/dev/null

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
