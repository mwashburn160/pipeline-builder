# Pipeline Builder — SonarCloud Family Base Image
#
# Built tag: pipeline-sonarcloud-base:1.0
#
# Used as the FROM by all 7 sonarcloud-{nodejs,python,go,java,dotnet,ruby,
# rust} plugins. Bundles two pinned sonar-scanner-cli versions (default +
# previous) for runtime selection.
#
# Each variant adds only its language toolchain in ~10 lines.
#
# Versions can be overridden at build time:
#   docker build --build-arg SONAR_DEFAULT_VERSION=12.0 ...

ARG SONAR_DEFAULT_VERSION=12.0
ARG SONAR_PREV_VERSION=11.5

FROM sonarsource/sonar-scanner-cli:${SONAR_DEFAULT_VERSION} AS scanner-default
FROM sonarsource/sonar-scanner-cli:${SONAR_PREV_VERSION} AS scanner-prev

FROM pipeline-plugin-base:24.04
ARG SONAR_DEFAULT_VERSION
ARG SONAR_PREV_VERSION

# Sonar-scanner is JavaScript-based — needs Node + npm at runtime. corepack
# ships with NodeSource's nodejs and provides npm/pnpm/yarn shims without
# conflicting with Ubuntu's npm deb.
# Install Node.js from the official prebuilt tarball — see _snyk-base/Dockerfile
# for full rationale (NodeSource's apt source is too flaky on slow networks).
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

# Two scanner versions; default symlinked to /usr/local/bin/sonar-scanner.
RUN mkdir -p /opt/sonar-scanner/versions
COPY --from=scanner-default /opt/sonar-scanner /opt/sonar-scanner/versions/scanner-${SONAR_DEFAULT_VERSION}
COPY --from=scanner-prev /opt/sonar-scanner /opt/sonar-scanner/versions/scanner-${SONAR_PREV_VERSION}
RUN ln -sf /opt/sonar-scanner/versions/scanner-${SONAR_DEFAULT_VERSION}/bin/sonar-scanner /usr/local/bin/sonar-scanner

ENV SONAR_SCANNER_VERSION=${SONAR_DEFAULT_VERSION}
ENV SONAR_ORGANIZATION=""
ENV SONAR_PROJECT_KEY=""
