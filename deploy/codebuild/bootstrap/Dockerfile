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
# Why Amazon Linux instead of Ubuntu:
#
# AWS does NOT publish the Ubuntu-based `aws/codebuild/standard:7.0`
# externally — it only exists inside the CodeBuild service. The only
# CodeBuild curated images available outside the service are the Amazon
# Linux variants on ECR Public (free unlimited pulls, no auth, no
# Docker Hub rate limits). We use the AL2 x86_64 standard image, which
# ships the same managed runtime set CodePipeline users expect: Node +
# npm, Python, AWS CLI v2, Docker CLI, Git, etc.
#
# Distro is AL2 (not Ubuntu). The package manager is yum/dnf, not apt.
# That doesn't affect the cold-start synth path — `pipeline-manager synth`
# only needs Node + AWS CLI on PATH, both of which are baked in.
#
# This image lives under deploy/codebuild/ (not deploy/plugins/_base/)
# because it's a CodeBuild runtime, not a plugin base — it doesn't
# consume `pipeline-plugin-base:24.04`.

FROM public.ecr.aws/codebuild/amazonlinux2-x86_64-standard:5.0

# pipeline-manager is the only addition. The AL2 standard image already
# ships Node (20.x at the time of writing) so npm is on PATH.
#
# Left unpinned for the same reason cdk-synth leaves it unpinned: Pipeline
# Builder ships frequent versions and the catalog drifts faster than we'd
# refresh a pinned tag. Pin via --build-arg if you need reproducibility.
ARG PIPELINE_MANAGER_VERSION="latest"

RUN npm config set @pipeline-builder:registry=https://registry.npmjs.org/ \
 && npm install -g "@pipeline-builder/pipeline-manager@${PIPELINE_MANAGER_VERSION}" \
 && pipeline-manager --version 2>&1 | tail -1

WORKDIR /app
CMD ["bash"]
