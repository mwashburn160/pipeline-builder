# OWASP Dependency-Check Plugin — Software Composition Analysis (SCA)
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans project dependencies for known CVEs via NVD database
# Supports Java, .NET, Node.js, Python, Ruby, Go, and more

# ─── Tool versions (override with --build-arg) ───
ARG DC_DEFAULT_VERSION=13.0.0
ARG DC_PREV_VERSION=12.2.2

FROM owasp/dependency-check:${DC_DEFAULT_VERSION} AS dc-default
FROM owasp/dependency-check:${DC_PREV_VERSION} AS dc-prev

FROM plugin-base:24.04

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
# ("Couldn't find a valid ICU package") — same dependency plugin-dotnet-base
# installs.
RUN apt-retry-install openjdk-17-jre-headless python3 python3-pip libicu-dev

# Node.js — official tarball, pinned version + pinned digest (nodejs.org
# SHASUMS256.txt for this release), installed under /usr/local.
ARG NODE_VERSION=26.13.0
ARG NODE_SHA256_AMD64=5848553868b402d3fabb5b09270649977780a390f832155721025a08b5104455
ARG NODE_SHA256_ARM64=439e9c438acdf6a6ffe47418da709153d66c4bed812e30a473faacb107dd2791
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
# Copied from plugin-go-base (pinned + checksum-verified Go from the base — the same
# version goenv used to build here) instead of cloning goenv at HEAD. GOPATH
# is owned by uid 1000 so module downloads work as the runtime user.
COPY --from=plugin-go-base:1.0 /opt/go-sdk /opt/go-sdk
ENV GOPATH=/opt/go
ENV PATH="/opt/go-sdk/bin:${GOPATH}/bin:${PATH}"
RUN install -d -o 1000 -g 1000 "${GOPATH}" "${GOPATH}/bin" && go version

# ─── .NET SDK (for NuGet dependency resolution) ───
# Pinned .NET 9 SDK (was `dotnet-install.sh --channel 9.0`, i.e. latest 9.0.x
# via a downloaded installer script). Digests are the SHA-512s Microsoft
# publishes in the 9.0 releases.json.
ARG DOTNET_SDK_VERSION=9.0.319
ARG DOTNET_SDK_SHA512_AMD64=ed080b81dd2cca56a453c939468b0061a60a083a87eaf21e035794cd28a14fc00faf52d96a4e4116f3cc1de40e6289cd0f08a8fd478d49e4dc4f28570e2f602c
ARG DOTNET_SDK_SHA512_ARM64=940b056511b078c4ab15318f3a7a6114c57c6c636ab32027e90129e3f8b205236a1c6af794eb35a887d7bf3219ff49522da2cb9f9a6d5d26e390909c25536ed2
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
