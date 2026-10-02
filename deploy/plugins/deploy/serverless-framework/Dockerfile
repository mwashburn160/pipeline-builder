# Serverless Framework Plugin — Serverless Application Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Deploys serverless applications to AWS, Azure, or GCP

FROM pipeline-aws-cli-base:1.0

# apt needs root; the image drops back to the unprivileged `plugin` user
# (uid 1000) at the end.
USER root

RUN apt-retry-install python3 python3-pip python3-venv

# ─── Node.js 24 ───
# Copied from pipeline-node-base (one pinned, checksum-verified Node shared by
# every Node plugin) instead of `curl …/nvm/install.sh | bash` + `nvm install`.
# Laid out at the nvm path the plugin spec activates
# (`${NVM_DIR}/versions/node/v${NODE_VERSION}/bin`), so the spec is unchanged;
# nvm itself is not installed (the spec never calls it). Owned by uid 1000 so
# global npm installs work as the runtime user.
ENV NVM_DIR=/opt/nvm
COPY --from=pipeline-node-base:1.0 --chown=1000:1000 /opt/node ${NVM_DIR}/versions/node/v24
ENV PATH="${NVM_DIR}/versions/node/v24/bin:${PATH}"

# ─── Serverless Framework ───
# Pinned to the last v3 release deliberately: v4 requires a license/access key
# and breaks v3-style (open-source) deployments used here. Installed as uid
# 1000 into the uid-1000-owned Node prefix.
#
# VULN SCAN (2026-10-02): flagged for CVE-2024-37890/28863/4067, all via the
# transitive `ws`/dependency chain, not a Serverless-specific bug. No fix is
# reachable by bumping: the npm registry's `serverless` package has no release
# newer than 3.40.0 in the v3 line (confirmed via `npm view serverless
# versions` — only 3.40.0 and a 3.40.0-<hash> canary build exist; v3 gets only
# critical security backports per the Serverless team and none has landed
# here). The only fix is v4, deliberately avoided above. Revisit if v3 ever
# gets a point release, or if these CVEs are confirmed unreachable at runtime.
ARG SERVERLESS_VERSION=3.40.0
USER 1000:1000
RUN npm install -g "serverless@${SERVERLESS_VERSION}" && serverless --version

# Default Node.js version
ENV NODE_VERSION=24

# ─── Runtime configuration defaults ───
ENV SLS_STAGE=dev
ENV SLS_REGION=""
ENV SLS_SERVICE_PATH=.

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
