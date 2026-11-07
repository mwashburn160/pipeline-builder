# CloudFormation Plugin — AWS Infrastructure Provisioning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Validates, deploys, and manages CloudFormation stacks
# Includes cfn-lint for template validation

# ─── Tool versions (override with --build-arg) ───
ARG RAIN_VERSION=1.24.4
# The commit the v${RAIN_VERSION} tag must resolve to (checked after clone).
ARG RAIN_COMMIT=9b5ed0947472ec1d18e1cb79aa63fb78afe1c2df
# ─── rain, built from source ───
# The v${RAIN_VERSION} release binary (latest) is built with go1.26.2, whose
# stdlib carries a Critical, fixable advisory (fixed in go1.26.9). rain is
# COMPILED HERE from its own tag on plugin-go-base (go1.27.3), the way
# testing/k6 and security/git-secrets build theirs, with upstream's own build
# command (`go build ./cmd/rain`, see its build.sh). No module needs raising.
FROM plugin-go-base:1.0 AS rain-src
ARG RAIN_VERSION
ARG RAIN_COMMIT
USER root
# RETRIED like the other source-built plugins (security/git-secrets,
# testing/k6): github.com and proxy.golang.org both fail intermittently, and a
# cold catalogue load does this a hundred times over. The tag must resolve to
# the pinned commit — the integrity check a release checksum used to give.
RUN set -eux; \
    for attempt in 1 2 3 4 5; do \
      rm -rf /src; \
      if git clone --depth 1 --branch "v${RAIN_VERSION}" https://github.com/aws-cloudformation/rain.git /src; then break; fi; \
      echo "rain clone failed (attempt $attempt/5); retrying" >&2; \
      sleep $((attempt * 5)); \
    done; \
    test -d /src/.git; \
    got="$(git -C /src rev-parse HEAD)"; \
    [ "$got" = "${RAIN_COMMIT}" ] || { echo "rain v${RAIN_VERSION} resolved to $got, expected ${RAIN_COMMIT}" >&2; exit 1; }
RUN set -eux; \
    cd /src; \
    mkdir -p /out; \
    for attempt in 1 2 3 4 5; do \
      if CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags "-s -w" -o /out/rain ./cmd/rain; then \
        break; \
      fi; \
      echo "rain build failed (attempt $attempt/5); retrying" >&2; \
      sleep $((attempt * 5)); \
    done; \
    test -x /out/rain; \
    /out/rain --version

FROM plugin-aws-cli-base:1.0

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

RUN apt-retry-install python3 python3-pip

# ─── cfn-lint for CloudFormation template validation ───
RUN pip3 install --no-cache-dir --break-system-packages cfn-lint==1.59.0

# ─── rain for CloudFormation deployment (modern CLI, built from source above) ───
COPY --from=rain-src /out/rain /usr/local/bin/rain
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
