# Pipeline Builder — Shared .NET Base Image
#
# Build target tag: pipeline-dotnet-base:1.0
#
# One pinned .NET SDK channel, baked once, shared by every .NET plugin
# (dotnet-test, dotnet-format, roslyn-analyzers, nuget-publish, and the
# snyk/trivy/sonarcloud .NET scanners). SINGLE-VERSION MODEL: bump
# DOTNET_VERSION and rebuild to change.

FROM pipeline-plugin-base:24.04

USER root

RUN apt-retry-install build-essential libssl-dev libicu-dev

# Single pinned .NET SDK from the official tarball (no dotnet-install.sh —
# that script resolves "latest in channel" at build time). Microsoft publishes
# SHA-512 digests in the release metadata
# (builds.dotnet.microsoft.com/dotnet/release-metadata/<channel>/releases.json).
# DOTNET_ROOT is owned by the plugin user so `dotnet tool install --tool-path
# ${DOTNET_ROOT}/tools` and workload restores work without root.
ARG DOTNET_VERSION=10.0
ARG DOTNET_SDK_VERSION=10.0.401
ARG DOTNET_SDK_SHA512_AMD64=51c8b999af9e8dd9998c9edc5944e19a90788862068acd38694e098889054ce8c23d4f0c5cccfa16bf187d044562359e5ee69a9f8ad0bbe913ba90311fbce25b
ARG DOTNET_SDK_SHA512_ARM64=58ace73ced6b4360754689a686bdfb8a317f4da6cb8bb416dbc7d0ba9f47e43e3c09f5eb1f1a1cfaacbd10df9558da4882bf2a5e195d6ab56a02c1f9f76102ed
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
