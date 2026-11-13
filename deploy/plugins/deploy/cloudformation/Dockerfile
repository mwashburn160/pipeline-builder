# CloudFormation Plugin — AWS Infrastructure Provisioning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Validates, deploys, and manages CloudFormation stacks
# Includes cfn-lint for template validation

# ─── Tool versions (override with --build-arg) ───
ARG RAIN_VERSION=1.24.4
# The commit the v${RAIN_VERSION} tag must resolve to (checked after clone).
ARG RAIN_COMMIT=9b5ed0947472ec1d18e1cb79aa63fb78afe1c2df
# Same pinned toolchain as api/plugin's tools stage.
ARG GO_IMAGE=golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf

# ─── rain, built from source ───
# The v${RAIN_VERSION} release binary (latest) is built with go1.26.2, whose
# stdlib carries a Critical, fixable advisory (fixed in go1.26.9). Build the
# same tagged source with a current toolchain, the way upstream's own
# build.sh does (`go build ./cmd/rain`). Source integrity: the tag must
# resolve to the pinned commit, or the build fails.
FROM ${GO_IMAGE} AS rain-build
ARG RAIN_VERSION
ARG RAIN_COMMIT
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
RUN apk add --no-cache git
RUN set -eux; \
    git clone --depth 1 --branch "v${RAIN_VERSION}" https://github.com/aws-cloudformation/rain.git /src/rain; \
    got="$(git -C /src/rain rev-parse HEAD)"; \
    [ "$got" = "${RAIN_COMMIT}" ] || { echo "rain v${RAIN_VERSION} resolved to $got, expected ${RAIN_COMMIT}" >&2; exit 1; }
WORKDIR /src/rain
RUN set -eux; \
    for attempt in 1 2 3 4 5; do go mod download && break; echo "go mod download failed (attempt $attempt/5)" >&2; sleep $((attempt * 5)); done; \
    go build -mod=readonly -trimpath -buildvcs=false -ldflags "-s -w" -o /out/rain ./cmd/rain; \
    /out/rain --version

FROM plugin-aws-cli-base:1.0

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

RUN apt-retry-install python3 python3-pip

# ─── cfn-lint for CloudFormation template validation ───
RUN pip3 install --no-cache-dir --break-system-packages cfn-lint==1.60.1

# ─── rain for CloudFormation deployment (modern CLI, built from source above) ───
COPY --from=rain-build /out/rain /usr/local/bin/rain
RUN chmod 0755 /usr/local/bin/rain

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
