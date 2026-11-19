# OWASP Dependency-Check Plugin — Software Composition Analysis (SCA)
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans project dependencies for known CVEs via NVD database
# Supports Java, .NET, Node.js, Python, Ruby, Go, and more

# ─── Tool versions (override with --build-arg) ───
ARG DC_VERSION=13.0.0

FROM owasp/dependency-check:${DC_VERSION} AS dc-src

FROM plugin-base:26.10

# Re-declare ARGs after FROM so they're available in this stage
ARG DC_VERSION

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
# libatomic1: the official Node tarball below links libatomic.so.1, which the
# 26.10 base no longer carries (and build-essential, which would pull it, is not installed).
RUN apt-retry-install openjdk-17-jre-headless python3 python3-pip libicu-dev libatomic1

# Node.js — official tarball, pinned version + pinned digest (nodejs.org
# SHASUMS256.txt for this release), installed under /usr/local.
ARG NODE_VERSION=26.13.1
# Node 25+ no longer bundles corepack, so it is installed from npm (pinned).
ARG COREPACK_VERSION=0.36.0
ARG NODE_SHA256_AMD64=518674de2b621728a5e4486f5fb3b7d2900bb3cc4aa97969edaa463db99f9778
ARG NODE_SHA256_ARM64=80a330b35415382878df18d41afbd106ea89bfb3be0087d6608e289a14c5cc7d
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) NODE_ARCH=x64;   sum="${NODE_SHA256_AMD64}" ;; \
      arm64) NODE_ARCH=arm64; sum="${NODE_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" "$sum" /tmp/node.tar.gz; \
    tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1; \
    rm /tmp/node.tar.gz; \
    npm install -g "corepack@${COREPACK_VERSION}"; \
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
# Pinned .NET 10 SDK — the LTS line, same SDK as plugin-dotnet-base. Moved off
# 9.0 on 2026-11-18: 9.0 is end-of-life (9.0.321 of 2026-11-10 was its last
# release), and a 10 SDK also restores net10.0 projects, which 9 cannot.
# 11.0 (STS) is held, as for plugin-dotnet-base — see "Current holds" in
# deploy/plugins/README.md. Digests are the SHA-512s Microsoft publishes in
# the 10.0 releases.json.
ARG DOTNET_SDK_VERSION=10.0.404
ARG DOTNET_SDK_SHA512_AMD64=577d0eb17fec33d029104c5c63a1ab0accc3e28776274abef2218dbac5af18d2109b5406d26b31d76f5c245215e3ba0926a94c20246c672c41847c9e1eb1dc50
ARG DOTNET_SDK_SHA512_ARM64=3533a3869da219cac45c567aadac3d8e96cdf1c6a04fe1c1d5fdeefea5d45af8424488f0144730d11b4a751f7ad546fb11e4c2b2725cd8401efee726711f8f11
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
COPY --from=dc-src /usr/share/dependency-check /opt/dependency-check/versions/dc-${DC_VERSION}

# Default to latest installed version. /opt/dependency-check is owned by uid
# 1000: the NVD database is cached inside each install's data/ dir, and the
# spec's DC_VERSION switch re-points `current` at runtime.
RUN ln -sfn /opt/dependency-check/versions/dc-${DC_VERSION} /opt/dependency-check/current \
    && chown -R 1000:1000 /opt/dependency-check
ENV PATH="/opt/dependency-check/current/bin:${PATH}"

# ─── Runtime configuration defaults ───
# Non-sensitive config only — NVD API key injected at runtime via CodeBuild secrets
ENV DC_VERSION=${DC_VERSION}
ENV DC_FAIL_ON_CVSS=7
ENV DC_FORMAT=JSON
ENV DC_SUPPRESSION_FILE=""

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
