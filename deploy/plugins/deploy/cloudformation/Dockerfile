# CloudFormation Plugin — AWS Infrastructure Provisioning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Validates, deploys, and manages CloudFormation stacks
# Includes cfn-lint for template validation

# ─── Tool versions (override with --build-arg) ───
ARG RAIN_VERSION=1.24.4

FROM pipeline-aws-cli-base:1.0

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

ARG RAIN_VERSION

RUN apt-retry-install python3 python3-pip

# ─── cfn-lint for CloudFormation template validation ───
RUN pip3 install --no-cache-dir --break-system-packages cfn-lint==1.57.0

# ─── rain for CloudFormation deployment (modern CLI) ───
# Pinned release zip + pinned digest (upstream publishes no checksum file for
# rain; digests computed from the v${RAIN_VERSION} release assets).
ARG RAIN_SHA256_AMD64=5358d6daf35322101566376a38e37d1f89c6588479af2e20240579fc2d4c660a
ARG RAIN_SHA256_ARM64=938fa4e18659c3e349edaa9843db4e4938e84d48602432d4b2a62b9785a66459
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=amd64; sum="${RAIN_SHA256_AMD64}" ;; \
      arm64) arch=arm64; sum="${RAIN_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://github.com/aws-cloudformation/rain/releases/download/v${RAIN_VERSION}/rain-v${RAIN_VERSION}_linux-${arch}.zip" "$sum" /tmp/rain.zip; \
    unzip -q /tmp/rain.zip -d /tmp; \
    mv "/tmp/rain-v${RAIN_VERSION}_linux-${arch}/rain" /usr/local/bin/rain; \
    chmod 0755 /usr/local/bin/rain; \
    rm -rf /tmp/rain*

# ─── Runtime configuration defaults ───
ENV CFN_TEMPLATE=""
ENV CFN_STACK_NAME=""
ENV CFN_ACTION=validate
ENV CFN_PARAMETERS=""
ENV CFN_CAPABILITIES=CAPABILITY_IAM,CAPABILITY_NAMED_IAM
ENV CFN_REGION=us-east-1

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
