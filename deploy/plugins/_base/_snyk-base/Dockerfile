# Pipeline Builder — Snyk Family Base Image
#
# Built tag: pipeline-snyk-base:1.0
#
# Used as the FROM by all 7 snyk-{nodejs,python,go,java,dotnet,ruby,rust}
# plugins. Centralizes the ~30 lines of Node.js + corepack + snyk CLI
# installation that previously lived in every variant.
#
# Each variant adds only its language toolchain (goenv/pyenv/SDKMAN/etc.)
# in ~10 lines.

FROM pipeline-plugin-base:24.04

# Snyk's CLI is JavaScript — needs Node + npm. corepack ships with
# NodeSource's nodejs and provides the npm/pnpm/yarn shims at /usr/local/bin
# without conflicting with Ubuntu's `npm` deb (which would shadow nodejs).
# Install Node.js from the official prebuilt tarball, bypassing apt entirely.
#
# Why not NodeSource's apt source: their setup_X.x script does its own
# apt-get update internally, which on slow/flaky networks (EC2 ↔ ubuntu
# mirrors) can partially succeed — curl returns 0, but NodeSource's
# package index never lands. Then `apt-get install nodejs` silently falls
# back to Ubuntu's old nodejs 18 (which doesn't ship corepack), and the
# build looks like it succeeded but produces an unusable image.
#
# The official tarball at nodejs.org/dist is a single static binary tree.
# No transitive deps, no apt state, no mirror dance — just curl + tar.
ARG NODE_VERSION=24.15.0
RUN set -eux; \
    ARCH=$(uname -m); \
    case "$ARCH" in \
      x86_64)  NODE_ARCH=x64 ;; \
      aarch64) NODE_ARCH=arm64 ;; \
      *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
    esac; \
    # Use .tar.gz, not .tar.xz — gzip is in the base image, xz-utils is not.
    for i in 1 2 3 4 5; do \
      curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" -o /tmp/node.tar.gz \
        && break \
        || { echo "node tarball download attempt $i failed; sleeping $((i * 10))s"; sleep $((i * 10)); }; \
    done; \
    tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1; \
    rm /tmp/node.tar.gz; \
    node --version; \
    npm --version; \
    corepack enable

# Snyk CLI itself.
RUN npm install -g snyk

# Common runtime defaults (variants may override).
ENV SNYK_SEVERITY_THRESHOLD=high
