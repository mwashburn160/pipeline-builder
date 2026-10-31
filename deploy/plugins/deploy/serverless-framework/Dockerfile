# Serverless Framework Plugin — Serverless Application Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Deploys serverless applications to AWS, Azure, or GCP

FROM plugin-aws-cli-base:1.0

# apt needs root; the image drops back to the unprivileged `plugin` user
# (uid 1000) at the end.
USER root

# libatomic1: the Node copied from plugin-node-base links libatomic.so.1, which
# plugin-aws-cli-base (26.10) does not carry; node-base only has it via build-essential.
RUN apt-retry-install python3 python3-pip python3-venv libatomic1

# ─── Node.js 24 ───
# Copied from plugin-node-base (one pinned, checksum-verified Node shared by
# every Node plugin) instead of `curl …/nvm/install.sh | bash` + `nvm install`.
# Laid out at the nvm path the plugin spec activates
# (`${NVM_DIR}/versions/node/v${NODE_VERSION}/bin`), so the spec is unchanged;
# nvm itself is not installed (the spec never calls it). Owned by uid 1000 so
# global npm installs work as the runtime user.
ENV NVM_DIR=/opt/nvm
COPY --from=plugin-node-base:1.0 --chown=1000:1000 /opt/node ${NVM_DIR}/versions/node/v26
ENV PATH="${NVM_DIR}/versions/node/v26/bin:${PATH}"

# ─── Serverless Framework ───
# v4. The previous pin was the last v3 release (3.40.0) because v4 requires a
# licence key; that key is now supplied at RUNTIME (SERVERLESS_ACCESS_KEY, see
# plugin-spec.yaml), so the image can move forward.
#
# THE OVERRIDE MACHINERY IS GONE, and that is the point of the upgrade rather
# than a side effect. v3 pulled tar, adm-zip and simple-git as direct deps and
# each carried a finding — tar 6.2.1 / GHSA-23hp-3jrh-7fpw was the single
# Critical that failed this image's PLUGIN_VULN_GATE — so the build pinned
# three `overrides`, installed LOCALLY (npm install -g ignores overrides), and
# then re-read each package to prove the override had actually applied.
#
# v4.45.0 has exactly ONE direct dependency (undici) and none of those three.
# Keeping the overrides would not just be redundant: the verification step
# `require`s each package, so it would throw and fail the build on packages
# that are no longer there. A plain global install is now correct.
ARG SERVERLESS_VERSION=4.46.0
USER 1000:1000
RUN set -eux; \
    npm install -g "serverless@${SERVERLESS_VERSION}"; \
    # `serverless --version` does not need the licence key; a deploy does.
    # Running it here still proves the binary resolves and the install landed.
    serverless --version

# Default Node.js version
ENV NODE_VERSION=26

# ─── Runtime configuration defaults ───
ENV SLS_STAGE=dev
ENV SLS_REGION=""
ENV SLS_SERVICE_PATH=.

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
