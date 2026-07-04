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

RUN apt-retry-install build-essential

# Official Node.js binary tarball (no nvm). The tarball URL needs the exact
# patch version, so NODE_BUILD is pinned separately from the NODE_VERSION major.
ARG NODE_VERSION=24
# TODO(prototype): confirm the exact current 24.x patch at build time.
ARG NODE_BUILD=24.10.0
ENV NODE_HOME=/opt/node
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_BUILD}/node-v${NODE_BUILD}-linux-${arch}.tar.xz" -o /tmp/node.tar.xz; \
    mkdir -p "${NODE_HOME}"; \
    tar -xJf /tmp/node.tar.xz -C "${NODE_HOME}" --strip-components=1; \
    rm -f /tmp/node.tar.xz; \
    test -x "${NODE_HOME}/bin/node"

ENV PATH="${NODE_HOME}/bin:${PATH}"
ENV NODE_VERSION=${NODE_VERSION}
ENV PACKAGE_MANAGER=auto

RUN node --version && npm --version

WORKDIR /app
CMD ["bash"]
