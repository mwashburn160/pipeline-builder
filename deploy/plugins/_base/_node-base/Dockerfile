# Pipeline Builder — Shared Node.js Base Image
#
# Build target tag: plugin-node-base:1.0
#
# One pinned Node, baked once, shared by every Node plugin (nodejs-bundle,
# eslint, prettier, typescript-check, jest, cypress, playwright, npm-publish,
# npm-audit, and the snyk/trivy/sonarcloud Node scanners). Replaces the
# per-plugin nvm installs. SINGLE-VERSION MODEL: bump NODE_BUILD/NODE_VERSION
# and rebuild to change.

FROM plugin-base:26.10

USER root

RUN apt-retry-install build-essential

# Official Node.js binary tarball (no nvm), pinned: the exact patch build +
# per-arch SHA-256 from https://nodejs.org/dist/v<build>/SHASUMS256.txt.
# NODE_HOME is owned by the plugin user so `npm install -g` (e.g. a pipeline
# installing pnpm/yarn) works non-root.
ARG NODE_VERSION=26
ARG NODE_BUILD=26.13.1
ARG NODE_SHA256_AMD64=5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864
ARG NODE_SHA256_ARM64=89e1853138db51e8b82d3e98ba9c0d3f2956a28e5e55ea1b7e12d25aae92d5dd
ENV NODE_HOME=/opt/node
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x64;   sum="${NODE_SHA256_AMD64}" ;; \
      arm64) arch=arm64; sum="${NODE_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://nodejs.org/dist/v${NODE_BUILD}/node-v${NODE_BUILD}-linux-${arch}.tar.xz" "$sum" /tmp/node.tar.xz; \
    mkdir -p "${NODE_HOME}"; \
    tar -xJf /tmp/node.tar.xz -C "${NODE_HOME}" --strip-components=1; \
    rm -f /tmp/node.tar.xz; \
    test -x "${NODE_HOME}/bin/node"; \
    chown -R 1000:1000 "${NODE_HOME}"

ENV PATH="${NODE_HOME}/bin:${PATH}"
ENV NODE_VERSION=${NODE_VERSION}
ENV PACKAGE_MANAGER=auto

RUN node --version && npm --version

WORKDIR /app
USER 1000:1000

# corepack is NOT bundled with Node 25+, so the official tarball above has no
# `corepack` binary. Plugins that run `corepack enable` (npm-publish,
# sentry-release, cdk-deploy, cdk-deploy-multi-region, dependency-check,
# license-checker) failed with "corepack: not found" after the move to Node 26.
# Installed from npm as the plugin user, into the uid-1000-owned NODE_HOME, so
# a plugin's later `corepack enable` can still write its shims there non-root.
ARG COREPACK_VERSION=0.36.0
RUN npm install -g "corepack@${COREPACK_VERSION}" && corepack --version
CMD ["bash"]
