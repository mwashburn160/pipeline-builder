# JFrog Push Plugin — Push Container Images to JFrog Artifactory
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Builds Docker images and pushes to JFrog Artifactory using JFrog CLI authentication
# Requires JFROG_TOKEN at runtime (never baked into images)

FROM pipeline-plugin-base:24.04

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

# ─── JFrog CLI (jf) ───
# JFrog public signing keys pinned by fingerprint (the key file carries two).
RUN fetch-apt-key https://releases.jfrog.io/artifactory/jfrog-gpg-public/jfrog_public_gpg.key /usr/share/keyrings/jfrog-archive-keyring.gpg \
       6D62857F69759A5128D83593DE70421F135DCA68 A3D085F542F740BBD7E3A2846B219DCCD7639232 \
    && echo "deb [signed-by=/usr/share/keyrings/jfrog-archive-keyring.gpg] https://releases.jfrog.io/artifactory/jfrog-debs xenial contrib" \
    > /etc/apt/sources.list.d/jfrog.list \
    && apt-retry-install jfrog-cli-v2-jf

# ─── Runtime configuration defaults ───
# Non-sensitive config only — JFROG_TOKEN injected at runtime
ENV JFROG_URL=""
ENV JFROG_REPO=""
ENV IMAGE_NAME=""
ENV IMAGE_TAG=latest
ENV DOCKERFILE_PATH=Dockerfile
ENV DOCKER_CONTEXT=.

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
