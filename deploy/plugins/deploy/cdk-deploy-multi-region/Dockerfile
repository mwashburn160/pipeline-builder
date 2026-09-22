# CDK Deploy Multi-Region Plugin — AWS CDK Application Deployment (Multiple Regions)
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Synthesizes once, then deploys CDK stacks across multiple AWS regions
# Supports sequential and parallel deployment strategies
# Includes rollback-on-failure for safe multi-region rollouts
#
# See deploy/cdk-deploy/Dockerfile for the canonical layout. This variant
# adds GNU `parallel` for the parallel deploy strategy.

ARG NODE_VERSION=24.21.0
FROM pipeline-aws-cli-base:1.0

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root
ARG NODE_VERSION

# Python (CDK apps) + parallel (for cross-region fan-out).
RUN apt-retry-install python3 python3-pip parallel

# Node.js — official tarball, pinned version + pinned digest (nodejs.org
# SHASUMS256.txt for this release), installed under /usr/local.
ARG NODE_SHA256_AMD64=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff
ARG NODE_SHA256_ARM64=724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) NODE_ARCH=x64;   sum="${NODE_SHA256_AMD64}" ;; \
      arm64) NODE_ARCH=arm64; sum="${NODE_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" "$sum" /tmp/node.tar.gz; \
    tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1; \
    rm /tmp/node.tar.gz; \
    node --version; \
    npm --version; \
    corepack enable

# Docker CLI — required for CDK Docker image assets.
# Signing key pinned by fingerprint (Docker's published CE release key).
RUN fetch-apt-key https://download.docker.com/linux/ubuntu/gpg /etc/apt/keyrings/docker.gpg \
       9DC858229FC7DD38854AE2D88D81803C0EBFCD88 \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
       https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-retry-install docker-ce-cli

# AWS CLI v2 — inherited from pipeline-aws-cli-base.

# AWS CDK + TS toolchain.
RUN npm install -g aws-cdk@2.1142.0 typescript@6.0.3 ts-node@10.9.2

# Runtime `npm install -g` (the spec installs yarn/pnpm for projects that use
# them) goes to a prefix the plugin user owns: the Node install under
# /usr/local stays root-owned, so it works with and without CodeBuild `run-as`.
RUN install -d -o 1000 -g 1000 /opt/npm-global
ENV NPM_CONFIG_PREFIX=/opt/npm-global
ENV PATH="/opt/npm-global/bin:${PATH}"

# ─── Runtime configuration defaults ───
ENV CDK_DEPLOY_ACTION=deploy
ENV CDK_STACK=""
ENV CDK_REGIONS=""
ENV CDK_PRIMARY_REGION=""
ENV CDK_DEPLOY_STRATEGY=sequential
ENV CDK_CONTEXT=""
ENV CDK_REQUIRE_APPROVAL=never
ENV CDK_ROLLBACK_ON_FAILURE=true
ENV CDK_OUTPUTS_FILE=cdk-outputs.json

WORKDIR /app
USER 1000:1000
CMD ["bash"]
