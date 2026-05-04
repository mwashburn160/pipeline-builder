# CDK Synth Plugin — Build environment for AWS CDK pipeline synthesis
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# See README.md for what this plugin does. Inherits from
# pipeline-plugin-base:24.04 + adds Node, Python, Docker CLI, AWS CLI,
# AWS CDK, pipeline-manager.

ARG NODE_VERSION=24.15.0
FROM pipeline-aws-cli-base:1.0
ARG NODE_VERSION

# Python + Docker CLI deps.
RUN apt-retry-install python3 python3-pip

# Node.js — see _base/_snyk-base/Dockerfile for rationale on tarball install.
RUN set -eux; \
    ARCH=$(uname -m); \
    case "$ARCH" in \
      x86_64)  NODE_ARCH=x64 ;; \
      aarch64) NODE_ARCH=arm64 ;; \
      *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
    esac; \
    for i in 1 2 3 4 5; do \
      curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" -o /tmp/node.tar.gz \
        && break \
        || { echo "node tarball attempt $i failed; sleeping $((i * 10))s"; sleep $((i * 10)); }; \
    done; \
    tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1; \
    rm /tmp/node.tar.gz; \
    node --version; \
    npm --version; \
    corepack enable

# Docker CLI — required for CDK Docker image assets and self-mutation.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
       -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
       https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# AWS CLI v2.

# AWS CDK + TS toolchain + pipeline-manager. pipeline-manager is left
# unpinned (Pipeline Builder internal package, ships frequent versions);
# pinning here would constantly drift behind the published catalog.
RUN npm config set @pipeline-builder:registry=https://registry.npmjs.org/
RUN npm install -g aws-cdk@2.177.0 typescript@5.7.3 ts-node@10.9.2 @pipeline-builder/pipeline-manager

WORKDIR /app
CMD ["bash"]
