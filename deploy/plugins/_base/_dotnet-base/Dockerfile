# Pipeline Builder — Shared .NET Base Image
#
# Build target tag: plugin-dotnet-base:1.0
#
# One pinned .NET SDK channel, baked once, shared by every .NET plugin
# (dotnet-test, dotnet-format, roslyn-analyzers, nuget-publish, and the
# snyk/trivy/sonarcloud .NET scanners). SINGLE-VERSION MODEL: bump
# DOTNET_VERSION and rebuild to change.

FROM plugin-base:26.10

USER root

# Ubuntu 26.10 defaults to OpenSSL 4 (libssl.so.4), which .NET 10 cannot load
# ("No usable version of libssl was found" -> abort). libssl3t64 puts OpenSSL 3
# alongside it, which .NET probes for and uses.
RUN apt-retry-install build-essential libssl-dev libicu-dev libssl3t64

# Single pinned .NET SDK from the official tarball (no dotnet-install.sh —
# that script resolves "latest in channel" at build time). Microsoft publishes
# SHA-512 digests in the release metadata
# (builds.dotnet.microsoft.com/dotnet/release-metadata/<channel>/releases.json).
# DOTNET_ROOT is owned by the plugin user so `dotnet tool install --tool-path
# ${DOTNET_ROOT}/tools` and workload restores work without root.
ARG DOTNET_VERSION=10.0
ARG DOTNET_SDK_VERSION=10.0.403
ARG DOTNET_SDK_SHA512_AMD64=b7b3d8461cf98b07d2552ce9199702fa3ad010ac2671a5f8cd5136f7534e50f6855ba7bbb02b11494563f1d04156276a31cda1103b900e5eecd0d9473dc7b9c5
ARG DOTNET_SDK_SHA512_ARM64=0966aa2b70f4677b8319be9df447a78a0dcd6164836425b55a68fd714f4023feb87b4cac21b9a996b79472ad54487cd0adcd2a9dfd570e2b2a1d26423a2baa9b
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
    chown -R 1000:1000 "${DOTNET_ROOT}"

ENV PATH="${DOTNET_ROOT}:${DOTNET_ROOT}/tools:${PATH}"
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_NOLOGO=1
ENV DOTNET_VERSION=${DOTNET_VERSION}

RUN dotnet --version

WORKDIR /app
USER 1000:1000
CMD ["bash"]
