# Pipeline Builder — Shared Node.js Base Image
#
# Build target tag: plugin-node-base:1.0
#
# One pinned Node, baked once, shared by every Node plugin (nodejs-bundle,
# eslint, prettier, typescript-check, jest, cypress, playwright, npm-publish,
# npm-audit, and the snyk/trivy/sonarcloud Node scanners). Replaces the
# per-plugin nvm installs. SINGLE-VERSION MODEL: bump NODE_BUILD/NODE_VERSION
# and rebuild to change.

FROM plugin-base:24.04

USER root

RUN apt-retry-install build-essential

# Official Node.js binary tarball (no nvm), pinned: the exact patch build +
# per-arch SHA-256 from https://nodejs.org/dist/v<build>/SHASUMS256.txt.
# NODE_HOME is owned by the plugin user so `npm install -g` (e.g. a pipeline
# installing pnpm/yarn) works non-root.
ARG NODE_VERSION=26
ARG NODE_BUILD=26.13.0
ARG NODE_SHA256_AMD64=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
ARG NODE_SHA256_ARM64=406fe3fbde1c054adff8b297c16fdb5af6659db327c1ac8acd46b56ef1af9a92
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
