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
# Retries on apt mirror flaps. NO --fix-missing: see _snyk-base/Dockerfile.
RUN set -eux; \
    for i in 1 2 3 4 5; do \
      curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && break \
        || { echo "NodeSource setup attempt $i failed; sleeping $((i * 10))s"; sleep $((i * 10)); }; \
    done; \
    for i in 1 2 3 4 5; do \
      apt-get install -y --no-install-recommends nodejs && break \
        || { echo "apt install nodejs attempt $i failed; sleeping $((i * 10))s"; sleep $((i * 10)); }; \
    done; \
    NODE_MAJOR=$(node --version | sed 's/^v//;s/\..*//'); \
    [ "$NODE_MAJOR" -ge 24 ] || { echo "ERROR: nodejs $NODE_MAJOR installed (expected 24+); NodeSource source likely not active"; exit 1; }; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb; \
    corepack enable

# Two scanner versions; default symlinked to /usr/local/bin/sonar-scanner.
RUN mkdir -p /opt/sonar-scanner/versions
COPY --from=scanner-default /opt/sonar-scanner /opt/sonar-scanner/versions/scanner-${SONAR_DEFAULT_VERSION}
COPY --from=scanner-prev /opt/sonar-scanner /opt/sonar-scanner/versions/scanner-${SONAR_PREV_VERSION}
RUN ln -sf /opt/sonar-scanner/versions/scanner-${SONAR_DEFAULT_VERSION}/bin/sonar-scanner /usr/local/bin/sonar-scanner

ENV SONAR_SCANNER_VERSION=${SONAR_DEFAULT_VERSION}
ENV SONAR_ORGANIZATION=""
ENV SONAR_PROJECT_KEY=""
