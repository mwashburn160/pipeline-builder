# GAR Push Plugin — Push Container Images to Google Artifact Registry
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Builds Docker images and pushes to Artifact Registry using gcloud authentication
# Requires GOOGLE_APPLICATION_CREDENTIALS (service account JSON file path) at runtime

FROM pipeline-plugin-base:24.04

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

RUN apt-retry-install lsb-release python3

# ─── Docker CLI + Buildx ───
# Signing key pinned by fingerprint (Docker's published CE release key) —
# fetch-apt-key refuses a rotated or substituted key.
RUN fetch-apt-key https://download.docker.com/linux/ubuntu/gpg /usr/share/keyrings/docker-archive-keyring.gpg \
       9DC858229FC7DD38854AE2D88D81803C0EBFCD88 \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list \
    && apt-retry-install docker-ce-cli docker-buildx-plugin

# ─── Google Cloud SDK (gcloud) ───
# `google-cloud-cli` — the repo no longer carries the old `google-cloud-sdk`
# package name (same package as deploy/gcloud-deploy installs).
# Google Artifact Registry repository-signing key pinned by fingerprint.
RUN fetch-apt-key https://packages.cloud.google.com/apt/doc/apt-key.gpg /usr/share/keyrings/cloud.google.gpg \
       35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3 \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-retry-install google-cloud-cli

# ─── Runtime configuration defaults ───
# Non-sensitive config only — GOOGLE_APPLICATION_CREDENTIALS injected at runtime
ENV GAR_LOCATION=us-central1
ENV GAR_PROJECT=""
ENV GAR_REPOSITORY=""
ENV IMAGE_NAME=""
ENV IMAGE_TAG=latest
ENV DOCKERFILE_PATH=Dockerfile
ENV DOCKER_CONTEXT=.

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
