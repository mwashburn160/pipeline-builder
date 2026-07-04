# Pipeline Builder — Shared .NET Base Image
#
# Build target tag: pipeline-dotnet-base:1.0
#
# One pinned .NET SDK channel, baked once, shared by every .NET plugin
# (dotnet-test, dotnet-format, roslyn-analyzers, nuget-publish, and the
# snyk/trivy/sonarcloud .NET scanners). SINGLE-VERSION MODEL: bump
# DOTNET_VERSION and rebuild to change.

FROM pipeline-plugin-base:24.04

RUN apt-retry-install build-essential libssl-dev libicu-dev

# Single .NET SDK channel via the official installer (bakes one version).
ARG DOTNET_VERSION=9.0
ENV DOTNET_ROOT=/opt/dotnet
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && chmod +x /tmp/dotnet-install.sh \
    && /tmp/dotnet-install.sh --channel "${DOTNET_VERSION}" --install-dir "${DOTNET_ROOT}" \
    && rm /tmp/dotnet-install.sh

ENV PATH="${DOTNET_ROOT}:${DOTNET_ROOT}/tools:${PATH}"
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_NOLOGO=1
ENV DOTNET_VERSION=${DOTNET_VERSION}

RUN dotnet --version

WORKDIR /app
CMD ["bash"]
