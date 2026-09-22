# OWASP Dependency-Check Plugin — Software Composition Analysis (SCA)
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans project dependencies for known CVEs via NVD database
# Supports Java, .NET, Node.js, Python, Ruby, Go, and more

# ─── Tool versions (override with --build-arg) ───
ARG DC_DEFAULT_VERSION=13.0.0
ARG DC_PREV_VERSION=12.2.2

FROM owasp/dependency-check:${DC_DEFAULT_VERSION} AS dc-default
FROM owasp/dependency-check:${DC_PREV_VERSION} AS dc-prev

FROM pipeline-plugin-base:24.04

# Re-declare ARGs after FROM so they're available in this stage
ARG DC_DEFAULT_VERSION
ARG DC_PREV_VERSION

# Build steps below need root (apt, writes under /usr/local and /opt); the
# image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

# Java JRE (required by dependency-check engine), Python (pip lockfile
# parsing), and Node.js (npm lockfile parsing). build-essential is NOT
# needed at runtime — dependency-check parses lockfiles, never compiles.
# Base image already provides git, curl, jq, ca-certificates, gnupg, etc.
#
# libicu-dev: the .NET SDK below aborts on every invocation without ICU
# ("Couldn't find a valid ICU package") — same dependency pipeline-dotnet-base
# installs.
RUN apt-retry-install openjdk-17-jre-headless python3 python3-pip libicu-dev

# Node.js — official tarball, pinned version + pinned digest (nodejs.org
# SHASUMS256.txt for this release), installed under /usr/local.
ARG NODE_VERSION=24.21.0
ARG NODE_SHA256_AMD64=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff
ARG NODE_SHA256_ARM64=724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) NODE_ARCH=x64;   sum="${NODE_SHA256_AMD64}" ;; \
      arm64) NODE_ARCH=arm64; sum="${NODE_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" "$sum" /tmp/node.tar.gz; \
    tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1; \
    rm /tmp/node.tar.gz; \
    corepack enable

# Runtime `npm install -g` (the spec installs yarn/pnpm for projects that use
# them) goes to a prefix the plugin user owns; /usr/local stays root-owned.
RUN install -d -o 1000 -g 1000 /opt/npm-global
ENV NPM_CONFIG_PREFIX=/opt/npm-global
ENV PATH="/opt/npm-global/bin:${PATH}"

# ─── Go (for go.mod dependency resolution) ───
# Copied from pipeline-go-base (pinned + checksum-verified Go from the base — the same
# version goenv used to build here) instead of cloning goenv at HEAD. GOPATH
# is owned by uid 1000 so module downloads work as the runtime user.
COPY --from=pipeline-go-base:1.0 /opt/go-sdk /opt/go-sdk
ENV GOPATH=/opt/go
ENV PATH="/opt/go-sdk/bin:${GOPATH}/bin:${PATH}"
RUN install -d -o 1000 -g 1000 "${GOPATH}" "${GOPATH}/bin" && go version

# ─── .NET SDK (for NuGet dependency resolution) ───
# Pinned .NET 9 SDK (was `dotnet-install.sh --channel 9.0`, i.e. latest 9.0.x
# via a downloaded installer script). Digests are the SHA-512s Microsoft
# publishes in the 9.0 releases.json.
ARG DOTNET_SDK_VERSION=9.0.318
ARG DOTNET_SDK_SHA512_AMD64=e8685293a3512178e0de1bb3c1663e31fdf9d761af705094bf833cc1ff6b9a18c543aa4141f0216503c98039c719585a6d32905b0bbb3279e93b7e7616e047c3
ARG DOTNET_SDK_SHA512_ARM64=f9c957867bddea8f82ec0459432ce7ddff8fafc846537b8003eb9f239d9c2e38586031a15954e74691c5a8cf5b3ab125d99bca85c74ca45dc8745071ca81e7ff
ENV DOTNET_ROOT=/opt/dotnet
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x64;   sum="${DOTNET_SDK_SHA512_AMD64}" ;; \
      arm64) arch=arm64; sum="${DOTNET_SDK_SHA512_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://builds.dotnet.microsoft.com/dotnet/Sdk/${DOTNET_SDK_VERSION}/dotnet-sdk-${DOTNET_SDK_VERSION}-linux-${arch}.tar.gz" "$sum" /tmp/dotnet.tar.gz; \
    mkdir -p "${DOTNET_ROOT}/tools"; \
    tar -xzf /tmp/dotnet.tar.gz -C "${DOTNET_ROOT}"; \
    rm -f /tmp/dotnet.tar.gz; \
    chown -R 1000:1000 "${DOTNET_ROOT}"; \
    "${DOTNET_ROOT}/dotnet" --version
ENV PATH="${DOTNET_ROOT}:${DOTNET_ROOT}/tools:${PATH}"
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1

# ─── OWASP Dependency-Check CLI (copied from official images) ───
RUN mkdir -p /opt/dependency-check/versions
COPY --from=dc-default /usr/share/dependency-check /opt/dependency-check/versions/dc-${DC_DEFAULT_VERSION}
COPY --from=dc-prev /usr/share/dependency-check /opt/dependency-check/versions/dc-${DC_PREV_VERSION}

# Default to latest installed version. /opt/dependency-check is owned by uid
# 1000: the NVD database is cached inside each install's data/ dir, and the
# spec's DC_VERSION switch re-points `current` at runtime.
RUN ln -sfn /opt/dependency-check/versions/dc-${DC_DEFAULT_VERSION} /opt/dependency-check/current \
    && chown -R 1000:1000 /opt/dependency-check
ENV PATH="/opt/dependency-check/current/bin:${PATH}"

# ─── Runtime configuration defaults ───
# Non-sensitive config only — NVD API key injected at runtime via CodeBuild secrets
ENV DC_VERSION=${DC_DEFAULT_VERSION}
ENV DC_FAIL_ON_CVSS=7
ENV DC_FORMAT=JSON
ENV DC_SUPPRESSION_FILE=""

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
