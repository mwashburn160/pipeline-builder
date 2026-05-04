# OWASP Dependency-Check Plugin — Software Composition Analysis (SCA)
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans project dependencies for known CVEs via NVD database
# Supports Java, .NET, Node.js, Python, Ruby, Go, and more

# ─── Tool versions (override with --build-arg) ───
ARG DC_DEFAULT_VERSION=12.2.0
ARG DC_PREV_VERSION=11.1.1

FROM owasp/dependency-check:${DC_DEFAULT_VERSION} AS dc-default
FROM owasp/dependency-check:${DC_PREV_VERSION} AS dc-prev

FROM pipeline-plugin-base:24.04

# Re-declare ARGs after FROM so they're available in this stage
ARG DC_DEFAULT_VERSION
ARG DC_PREV_VERSION

# Java JRE (required by dependency-check engine), Python (pip lockfile
# parsing), and Node.js (npm lockfile parsing). build-essential is NOT
# needed at runtime — dependency-check parses lockfiles, never compiles.
# Base image already provides git, curl, jq, ca-certificates, gnupg, etc.
RUN apt-retry-install openjdk-17-jre-headless python3 python3-pip

# Node.js — installed from official tarball (apt-based NodeSource is too
# flaky on slow EC2 networks; see _base/_snyk-base for full rationale).
ARG NODE_VERSION=24.15.0
RUN set -eux; \
    ARCH=$(uname -m); \
    case "$ARCH" in \
      x86_64)  NODE_ARCH=x64 ;; \
      aarch64) NODE_ARCH=arm64 ;; \
      *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
    esac; \
    for i in 1 2 3 4 5; do \
      curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" -o /tmp/node.tar.gz && break \
        || { echo "node tarball attempt $i failed; sleeping $((i * 10))s"; sleep $((i * 10)); }; \
    done; \
    tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1; \
    rm /tmp/node.tar.gz; \
    corepack enable

# ─── Go (for go.mod dependency resolution) ───
ENV GOENV_ROOT=/opt/goenv
RUN git clone https://github.com/go-nv/goenv.git ${GOENV_ROOT}
RUN ${GOENV_ROOT}/bin/goenv install 1.24.13 && ${GOENV_ROOT}/bin/goenv global 1.24.13
ENV PATH="${GOENV_ROOT}/shims:${GOENV_ROOT}/bin:${PATH}"

# ─── .NET SDK (for NuGet dependency resolution) ───
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && chmod +x /tmp/dotnet-install.sh \
    && /tmp/dotnet-install.sh --channel 8.0 --install-dir /opt/dotnet \
    && rm /tmp/dotnet-install.sh
ENV DOTNET_ROOT=/opt/dotnet
ENV PATH="${DOTNET_ROOT}:${DOTNET_ROOT}/tools:${PATH}"
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1

# ─── OWASP Dependency-Check CLI (copied from official images) ───
RUN mkdir -p /opt/dependency-check/versions
COPY --from=dc-default /usr/share/dependency-check /opt/dependency-check/versions/dc-${DC_DEFAULT_VERSION}
COPY --from=dc-prev /usr/share/dependency-check /opt/dependency-check/versions/dc-${DC_PREV_VERSION}

# Default to latest installed version
RUN ln -sf /opt/dependency-check/versions/dc-${DC_DEFAULT_VERSION} /opt/dependency-check/current
ENV PATH="/opt/dependency-check/current/bin:${PATH}"

# ─── Runtime configuration defaults ───
# Non-sensitive config only — NVD API key injected at runtime via CodeBuild secrets
ENV DC_VERSION=${DC_DEFAULT_VERSION}
ENV DC_FAIL_ON_CVSS=7
ENV DC_FORMAT=JSON
ENV DC_SUPPRESSION_FILE=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
