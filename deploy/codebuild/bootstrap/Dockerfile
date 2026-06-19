# Pipeline Builder — CodeBuild Bootstrap Image
#
# Built tag: pipeline-bootstrap:1.0
#
# This is NOT a plugin image — it's the CodeBuild runtime image meant to
# back `CODEBUILD_DEFAULT_IMAGE`, the fallback used when a step has no
# plugin-baked image:
#   - cold-start synth (pipeline-core's `bootstrap()` path)
#   - ShellSteps that don't have a registry image
#   - `metadata_only` plugins
#
# Without this, the fallback runs on AWS-managed `aws/codebuild/standard:7.0`
# which DOES NOT have `pipeline-manager` on PATH — the first CodeBuild
# action in a cold-start pipeline then exits 127 ("not found") on the
# synth command. `bootstrap()` in pipeline-core deliberately does NOT
# include a self-heal `npm install -g` step (that masked configuration
# problems and added ~30s to every cold start); instead the contract is
# that `CODEBUILD_DEFAULT_IMAGE` MUST point at an image with
# `pipeline-manager` on PATH, which is exactly what this image provides.
#
# Why a slim base instead of the AWS CodeBuild standard image:
#
# Cold-start synth only needs Node + AWS CLI + git + the AWS CDK CLI on PATH
# (`pipeline-manager synth` shells out to `cdk synth`). The full
# `aws/codebuild/standard:7.0` (and its public-ECR Amazon Linux variants)
# bundles every language runtime AWS CodeBuild supports — Node, Python,
# Ruby, Go, multiple JDKs, .NET, PHP, etc. — and weighs ~18 GB. Pushing
# that through the in-cluster registry on every refresh, and pulling it
# in CodeBuild on every cold-start, was wildly wasteful for what the
# bootstrap path actually executes (`pipeline-manager synth`).
#
# This image is ~400 MB instead. If a plugin needs a runtime we don't
# bake here, that plugin already brings its own image (cdk-synth has
# its own Dockerfile FROM pipeline-aws-cli-base with CDK + Node baked
# in; per-language plugins have their own runtime). The bootstrap path
# only fires when pre-resolution fails and falls back to running
# `pipeline-manager synth` itself — which needs Node + AWS CLI + the
# AWS CDK CLI (`cdk synth`), all baked in below.
#
# This image lives under deploy/codebuild/ (not deploy/plugins/_base/)
# because it's a CodeBuild runtime, not a plugin base — it doesn't
# consume `pipeline-plugin-base:24.04`.

FROM node:24-slim

# Add: git (source ops), curl + unzip (AWS CLI install), AWS CLI v2,
# pipeline-manager. node:24-slim already has Node + npm + ca-certs.
# Matches the runtime baseline in projen (minNodeVersion: 24.14.0).
ARG PIPELINE_MANAGER_VERSION="latest"
# AWS CDK CLI — `pipeline-manager synth` shells out to `cdk synth`, so the
# `cdk` binary must be on PATH. Pinned to match the cdk-synth plugin image
# (deploy/plugins/infrastructure/cdk-synth/Dockerfile) and the version note
# in deploy/plugins/README.md; compatible with aws-cdk-lib 2.258.x.
ARG AWS_CDK_VERSION="2.1126.0"
# esbuild — synth bundles the PluginLookup Lambda via `aws-lambda-nodejs`
# (NodejsFunction). When esbuild isn't detected it falls back to DOCKER
# bundling, which a slim no-docker CodeBuild image can't do (`spawnSync docker
# ENOENT`). With esbuild on PATH, aws-cdk-lib bundles the Lambda locally — no
# docker. Any 0.x satisfies aws-cdk-lib's major-version guard.
ARG ESBUILD_VERSION="0.28.1"

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      git curl unzip ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    # AWS CLI v2 — official installer, multi-arch aware.
    ARCH=$(uname -m); \
    case "$ARCH" in \
      x86_64)  AWSCLI_ARCH=x86_64 ;; \
      aarch64) AWSCLI_ARCH=aarch64 ;; \
      *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${AWSCLI_ARCH}.zip" -o /tmp/awscli.zip; \
    unzip -q /tmp/awscli.zip -d /tmp; \
    /tmp/aws/install; \
    rm -rf /tmp/aws /tmp/awscli.zip; \
    aws --version; \
    # pipeline-manager — left unpinned because Pipeline Builder ships
    # frequent versions and the catalog drifts faster than we'd refresh
    # a pinned tag. Pin via --build-arg if you need reproducibility.
    npm config set @pipeline-builder:registry=https://registry.npmjs.org/; \
    npm install -g "aws-cdk@${AWS_CDK_VERSION}" "esbuild@${ESBUILD_VERSION}" "@pipeline-builder/pipeline-manager@${PIPELINE_MANAGER_VERSION}"; \
    cdk --version; \
    esbuild --version; \
    pipeline-manager --version 2>&1 | tail -1

WORKDIR /app
CMD ["bash"]
