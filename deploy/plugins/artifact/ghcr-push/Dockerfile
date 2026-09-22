# GHCR Push Plugin — Push Container Images to GitHub Container Registry
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Builds Docker images and pushes to ghcr.io using GitHub CLI authentication
# Requires GITHUB_TOKEN at runtime (never baked into images)

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

# ─── GitHub CLI (gh) ───
# GitHub CLI keyring pinned by fingerprint — it carries BOTH the original
# signing key (2C61…6059) and its 2026 successor (7F38…3325); fetch-apt-key
# requires the exact set.
RUN fetch-apt-key https://cli.github.com/packages/githubcli-archive-keyring.gpg /usr/share/keyrings/githubcli-archive-keyring.gpg \
       2C6106201985B60E6C7AC87323F3D4EA75716059 7F38BBB59D064DBCB3D84D725612B36462313325 \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-retry-install gh

# ─── Runtime configuration defaults ───
# Non-sensitive config only — GITHUB_TOKEN injected at runtime
ENV GITHUB_USERNAME=""
ENV GITHUB_OWNER=""
ENV IMAGE_NAME=""
ENV IMAGE_TAG=latest
ENV DOCKERFILE_PATH=Dockerfile
ENV DOCKER_CONTEXT=.

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
