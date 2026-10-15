# Pipeline Builder — Shared .NET Base Image
#
# Build target tag: plugin-dotnet-base:1.0
#
# One pinned .NET SDK channel, baked once, shared by every .NET plugin
# (dotnet-test, dotnet-format, roslyn-analyzers, nuget-publish, and the
# snyk/trivy/sonarcloud .NET scanners). SINGLE-VERSION MODEL: bump
# DOTNET_VERSION and rebuild to change.

FROM plugin-base:24.04

USER root

RUN apt-retry-install build-essential libssl-dev libicu-dev

# Single pinned .NET SDK from the official tarball (no dotnet-install.sh —
# that script resolves "latest in channel" at build time). Microsoft publishes
# SHA-512 digests in the release metadata
# (builds.dotnet.microsoft.com/dotnet/release-metadata/<channel>/releases.json).
# DOTNET_ROOT is owned by the plugin user so `dotnet tool install --tool-path
# ${DOTNET_ROOT}/tools` and workload restores work without root.
ARG DOTNET_VERSION=10.0
ARG DOTNET_SDK_VERSION=10.0.402
ARG DOTNET_SDK_SHA512_AMD64=1904a98dda2db34ba78ba3c4fb1b224455329af91c341d83547843c1839e112b04ae699ee92fa2449a8f62249196a938723078c0c60b9f65c88539d5687729c2
ARG DOTNET_SDK_SHA512_ARM64=db85ae85527251fbb1290720ac3bf324bb1d9eea74516ef291ed4bb1f8ff6ec63a17593367f49b456115e8b24ead6d0c2ece2801e501f36a6cd4444ed01a498f
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
