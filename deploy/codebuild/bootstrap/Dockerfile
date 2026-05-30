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
# This image inherits the FULL AWS-managed CodeBuild runtime (Node, Python,
# Docker, AWS CLI, Git, etc.) rather than rebuilding it on bare Ubuntu —
# CodePipeline users expect `standard:7.0` parity from "the default", and
# rebuilding that surface would lose AWS's tested-against-CodePipeline
# guarantees. That's why this lives under deploy/codebuild/ instead of
# deploy/plugins/_base/ — it does not consume `pipeline-plugin-base:24.04`.

FROM public.ecr.aws/codebuild/standard:7.0

# pipeline-manager is the only addition. standard:7.0 already ships Node
# (22.x at the time of writing) so npm is on PATH.
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
