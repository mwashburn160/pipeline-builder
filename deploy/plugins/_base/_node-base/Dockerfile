# Pipeline Builder — Shared Node.js Base Image
#
# Build target tag: pipeline-node-base:1.0
#
# One pinned Node, baked once, shared by every Node plugin (nodejs-bundle,
# eslint, prettier, typescript-check, jest, cypress, playwright, npm-publish,
# npm-audit, and the snyk/trivy/sonarcloud Node scanners). Replaces the
# per-plugin nvm installs. SINGLE-VERSION MODEL: bump NODE_BUILD/NODE_VERSION
# and rebuild to change.

FROM pipeline-plugin-base:24.04

USER root

RUN apt-retry-install build-essential

# Official Node.js binary tarball (no nvm), pinned: the exact patch build +
# per-arch SHA-256 from https://nodejs.org/dist/v<build>/SHASUMS256.txt.
# NODE_HOME is owned by the plugin user so `npm install -g` (e.g. a pipeline
# installing pnpm/yarn) works non-root.
ARG NODE_VERSION=24
ARG NODE_BUILD=24.10.0
ARG NODE_SHA256_AMD64=2642f4428869aca32443660fd71b3918e2be1277a899bdcaeb64c93b54b5af17
ARG NODE_SHA256_ARM64=07f0558316ebb8977dd6fb29b4de8d369a639d3d8cef544293852a6f5eea6af8
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
CMD ["bash"]
