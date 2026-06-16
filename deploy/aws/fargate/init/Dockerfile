# =============================================================================
# Pipeline Builder — init image (pipeline-init)
# =============================================================================
# Runs deploy/bin/init-platform.sh on a Docker-LESS host (the Fargate one-shot init
# task in deploy/aws/fargate/stacks/07-init.yaml). Bakes the deploy/ scripts + the tools
# they need; NO Docker daemon required:
#   - per-plugin images are built by the plugin service's buildkitd (upload-driven),
#   - plugin base images are built + pushed into the in-cluster registry by the init
#     task's own rootless buildkitd sidecar via buildctl (BASE_BUILDER=buildkit),
#   - the CodeBuild bootstrap image is prebuilt in CI (BUILD_BOOTSTRAP=n).
#
# Build from the REPO ROOT so `COPY deploy` resolves:
#   docker buildx build -f deploy/aws/fargate/init/Dockerfile -t pipeline-init:<ver> .
# Fargate/CodeBuild are amd64, so this is a single-arch amd64 image.
# =============================================================================
FROM debian:bookworm-slim

ARG YQ_VERSION=4.44.6
ARG BUILDKIT_VERSION=0.30.0

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash ca-certificates curl jq openssl python3 unzip tar; \
    # buildctl — drive the task's buildkitd sidecar to build + push base images (no Docker)
    curl -fsSL "https://github.com/moby/buildkit/releases/download/v${BUILDKIT_VERSION}/buildkit-v${BUILDKIT_VERSION}.linux-amd64.tar.gz" \
      | tar -xz -C /usr/local --strip-components=1 bin/buildctl; \
    # yq (mikefarah) — required by common.sh yq_* helpers
    curl -fsSL "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_amd64" -o /usr/local/bin/yq; \
    chmod +x /usr/local/bin/yq; \
    # aws-cli v2 — stack/secret lookups on AWS targets
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip; \
    unzip -q /tmp/awscliv2.zip -d /tmp; \
    /tmp/aws/install; \
    rm -rf /tmp/aws /tmp/awscliv2.zip /var/lib/apt/lists/*; \
    buildctl --version && yq --version && aws --version

WORKDIR /app
# Bake the deploy scripts + the sample content init-platform loads (plugins, compliance,
# samples, codebuild, bin). The 07-init task command runs ./deploy/bin/init-platform.sh.
COPY deploy ./deploy

# Default invocation; 07-init.yaml overrides Command with the same line (explicit).
ENTRYPOINT ["/bin/bash"]
CMD ["deploy/bin/init-platform.sh", "--continue-on-build-failure", "fargate"]
