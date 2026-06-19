# CDK Synth Plugin — build environment for AWS CDK pipeline synthesis.
# Used as the synth step (CodeBuildStep) of a pipeline-core Builder pipeline;
# runs `pipeline-manager synth` → `cdk synth`.
#
# Built FROM the CodeBuild bootstrap image so it INHERITS the exact, version-
# locked synth toolchain — Node, AWS CLI v2, the AWS CDK CLI, esbuild, pnpm and
# pipeline-manager — and can never drift behind it. That drift is what broke
# this stage: the old image (FROM pipeline-aws-cli-base) re-installed cdk +
# pipeline-manager but omitted esbuild/pnpm, so `cdk synth` fell back to DOCKER
# bundling of the PluginLookup Lambda — which has no daemon inside CodeBuild and
# fails (`/var/run/docker.sock: no such file`). With esbuild inherited here, the
# Lambda bundles locally; no Docker needed.
#
# Build order: pipeline-bootstrap:1.0 must be built before this image —
# init-platform builds the bootstrap image before loading plugins, so this holds.
FROM pipeline-bootstrap:1.0

# Extra runtimes for synthesizing CDK apps authored in Python or TypeScript
# (the pipeline-builder boilerplate itself is compiled JS and needs neither, but
# this plugin is a general CDK-synth environment). node:24-slim has no apt-retry
# helper, so install directly. Docker CLI is intentionally NOT installed: docker
# bundling can't work in CodeBuild (no daemon) and esbuild handles it locally.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g typescript@6.0.3 ts-node@10.9.2

WORKDIR /app
CMD ["bash"]
