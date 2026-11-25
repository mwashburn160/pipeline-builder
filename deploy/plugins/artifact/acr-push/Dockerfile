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
# build. Pinned to the newest one it serves, resolute (26.04 LTS, the closest
# to the 26.10 base: its libc6 >= 2.42 / libssl3t64 >= 3.4 floors match this
# OS); azure-cli bundles its own Python under /opt/az, so it does not depend
# on the OS Python.
ARG AZURE_CLI_DIST=resolute
RUN fetch-apt-key https://packages.microsoft.com/keys/microsoft.asc /usr/share/keyrings/microsoft-archive-keyring.gpg \
       BC528686B50D79E339D3721CEB3E94ADBE1229CF \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/microsoft-archive-keyring.gpg] https://packages.microsoft.com/repos/azure-cli/ ${AZURE_CLI_DIST} main" \
    > /etc/apt/sources.list.d/azure-cli.list \
    && apt-retry-install azure-cli

# ─── Patched deps in azure-cli's bundled Python (/opt/az) ───
# azure-cli 2.93.0 (the newest) bundles urllib3 2.7.0 (GHSA-vxq7-64xx-v4gw,
# GHSA-8988-9cw3-xx77; High, fixed 2.8.0), oauthlib 3.2.2 (GHSA-7984-qgvg-3j9c;
# High, fixed 4.0.0) and cryptography 48.0.1 (CVE-2026-69247/-69249; High,
# fixed 50.0.0). Exact-pinned overrides of each; pyopenssl moves with
# cryptography because pyopenssl 26.2.0 caps it at <49 (26.4.0 allows <51).
# `pip check` fails the build on any conflict this introduces. DELETE a pin
# once azure-cli bundles that version or newer. Check with:
#   docker run --rm <image> /opt/az/bin/python3 -m pip show urllib3 oauthlib cryptography pyopenssl
RUN /opt/az/bin/python3 -m pip install --no-cache-dir --disable-pip-version-check --root-user-action=ignore \
       urllib3==2.8.0 oauthlib==4.0.1 cryptography==50.0.2 pyopenssl==26.4.0 \
    && /opt/az/bin/python3 -m pip check \
    && az --version > /dev/null

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
