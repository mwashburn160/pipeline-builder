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
# The npm Node 26.13.1 bundles (11.20.0) vendors undici 6.28.0 and
# brace-expansion 5.0.9, six High advisories between them; npm 12.2.3 ships
# undici 6.29.1 and brace-expansion 5.0.12.
ARG NPM_VERSION=12.2.3
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
    npm install -g "npm@${NPM_VERSION}"; \
    test "$(npm --version)" = "${NPM_VERSION}"; \
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

# ─── Patched jars ───
# dependency-check 13.0.0 (upstream's latest) bundles jackson-core/databind
# 2.22.1, jsoup 1.23.1, guava 33.6.0-jre and the postgresql 42.7.11 driver,
# each with a fixable High advisory. Each is replaced with the fixed release
# from Maven Central (digest = sha256 of the jar, cross-checked against
# Central's .sha1). The CLI jar's manifest Class-Path names its lib/ jars
# EXPLICITLY, so a lib/ replacement keeps the ORIGINAL file name (the jar's own
# pom.properties carries the new version); plugins/ is loaded as a directory,
# so the driver is swapped by name. The jackson modules move together, on the
# 2.22 line the CLI was built against (2.23 would need every module at 2.23);
# jsoup stays on 1.23.x for the same reason.
ARG JACKSON_VERSION=2.22.4
ARG JSOUP_VERSION=1.23.2
ARG GUAVA_VERSION=33.8.0-jre
ARG PGJDBC_VERSION=42.7.15
RUN set -eux; \
    lib="/opt/dependency-check/versions/dc-${DC_VERSION}/lib"; \
    plugins="/opt/dependency-check/versions/dc-${DC_VERSION}/plugins"; \
    m=https://repo1.maven.org/maven2; \
    swap() { \
      test -f "$lib/$4"; \
      fetch-verified "$m/$1/$2/$3/$2-$3.jar" "$5" "$lib/$4"; \
    }; \
    swap com/fasterxml/jackson/core jackson-core "${JACKSON_VERSION}" jackson-core-2.22.1.jar 2d30c375cddea9657a1e1ef97547a2694b663b355facb4de53a097782b312d1a; \
    swap com/fasterxml/jackson/core jackson-databind "${JACKSON_VERSION}" jackson-databind-2.22.1.jar d4cbf8947087f305869826801913abdc50735a1fab2074a1993e7bc67ca974a3; \
    swap com/fasterxml/jackson/dataformat jackson-dataformat-yaml "${JACKSON_VERSION}" jackson-dataformat-yaml-2.22.1.jar 2f55e2b864f6354b24d4bcccd488f7c4a3fce4977f8c8dbad07242a68e11dde9; \
    swap com/fasterxml/jackson/datatype jackson-datatype-jsr310 "${JACKSON_VERSION}" jackson-datatype-jsr310-2.22.1.jar ec961697cbd631935b6fb6f673406861c75243521fb67fec10b59f1412ac50f7; \
    swap com/fasterxml/jackson/module jackson-module-blackbird "${JACKSON_VERSION}" jackson-module-blackbird-2.22.1.jar 38fba776ff2d5a626c77c9a64a752bd5b4c390a780a7be3c5533111e13d66f29; \
    swap org/jsoup jsoup "${JSOUP_VERSION}" jsoup-1.23.1.jar e9d8c856856680427f096d156f02a414289985c930998fcb519ce5be39b42003; \
    swap com/google/guava guava "${GUAVA_VERSION}" guava-33.6.0-jre.jar 97b79ec3f2c0a6313a0c2df51ce1abdf8907e6531803467b81efcaaf99b35161; \
    rm "$plugins/postgresql-42.7.11.jar"; \
    fetch-verified "$m/org/postgresql/postgresql/${PGJDBC_VERSION}/postgresql-${PGJDBC_VERSION}.jar" \
      9776fca62dfc84f312d5c1aff9791f6f3cf56d518a8eca4a3a8dca7a95ef8881 "$plugins/postgresql-${PGJDBC_VERSION}.jar"

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
