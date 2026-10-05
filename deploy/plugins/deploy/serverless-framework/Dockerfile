# Serverless Framework Plugin — Serverless Application Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Deploys serverless applications to AWS, Azure, or GCP

FROM plugin-aws-cli-base:1.0

# apt needs root; the image drops back to the unprivileged `plugin` user
# (uid 1000) at the end.
USER root

RUN apt-retry-install python3 python3-pip python3-venv

# ─── Node.js 24 ───
# Copied from plugin-node-base (one pinned, checksum-verified Node shared by
# every Node plugin) instead of `curl …/nvm/install.sh | bash` + `nvm install`.
# Laid out at the nvm path the plugin spec activates
# (`${NVM_DIR}/versions/node/v${NODE_VERSION}/bin`), so the spec is unchanged;
# nvm itself is not installed (the spec never calls it). Owned by uid 1000 so
# global npm installs work as the runtime user.
ENV NVM_DIR=/opt/nvm
COPY --from=plugin-node-base:1.0 --chown=1000:1000 /opt/node ${NVM_DIR}/versions/node/v24
ENV PATH="${NVM_DIR}/versions/node/v24/bin:${PATH}"

# ─── Serverless Framework ───
# Pinned to the last v3 release deliberately: v4 requires a license/access key
# and breaks v3-style (open-source) deployments used here. Installed as uid
# 1000 into the uid-1000-owned Node prefix.
#
# VULN SCAN: nothing here is fixable by bumping serverless. 3.40.0 is the last
# v3 release (the registry has only it and a 3.40.0-<hash> canary), and `latest`
# is 4.x, which needs a licence key. So the vulnerable dependency is overridden
# rather than the parent upgraded.
#
# node-tar is a DIRECT dependency of serverless (`^6.1.15`, not transitive —
# confirmed by resolving the lockfile), and 6.2.1 carries GHSA-23hp-3jrh-7fpw:
# unlimited-input decompression DoS, Critical, and the single Critical that
# failed this image's PLUGIN_VULN_GATE. The adm-zip and ip-address findings
# reported alongside it are High and do not gate.
#
# Overriding a direct dependency across a MAJOR version is only safe because it
# was checked rather than assumed, in a container, before being pinned here:
#   * serverless requires tar in exactly ONE file — lib/utils/eventually-update.js,
#     the self-updater, which a pinned image has no business running;
#   * tar 7 still exports every entry point it uses (x, c, t, extract, create, list);
#   * `serverless package` on a real service still produces its artifact.
# Re-run those three if either version moves.
#
# A LOCAL install, because `npm install -g` ignores `overrides` outright. The
# bin symlinks are made as root up front and dangle until the install lands.
ARG SERVERLESS_VERSION=3.40.0
ARG SERVERLESS_TAR_VERSION=7.5.19
RUN install -d -o 1000 -g 1000 /opt/serverless \
    && ln -s /opt/serverless/node_modules/.bin/serverless /usr/local/bin/serverless \
    && ln -s /opt/serverless/node_modules/.bin/sls /usr/local/bin/sls
USER 1000:1000
RUN set -eux; \
    cd /opt/serverless; \
    npm init -y >/dev/null; \
    npm pkg set overrides.tar="${SERVERLESS_TAR_VERSION}"; \
    npm install --omit=dev "serverless@${SERVERLESS_VERSION}"; \
    # npm applies an override silently or not at all, so the image could ship
    # the vulnerable tar while looking fixed. Fail the BUILD on that instead.
    node -e "const v = require('/opt/serverless/node_modules/tar/package.json').version; if (v !== '${SERVERLESS_TAR_VERSION}') { console.error('tar resolved to ' + v); process.exit(1); } console.log('tar ok: ' + v);"; \
    serverless --version

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
