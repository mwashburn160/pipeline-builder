# Snyk Security Plugin — .NET scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Inherits from the snyk family base image (pipeline-snyk-base:1.0)
# which provides snyk CLI + (where applicable) Node.js. This file
# only adds the .NET toolchain.

FROM pipeline-snyk-base:1.0

# ─── .NET SDK ───
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && chmod +x /tmp/dotnet-install.sh \
    && /tmp/dotnet-install.sh --channel 8.0 --install-dir /opt/dotnet \
    && /tmp/dotnet-install.sh --channel 9.0 --install-dir /opt/dotnet \
    && rm /tmp/dotnet-install.sh
ENV DOTNET_ROOT=/opt/dotnet
ENV PATH="${DOTNET_ROOT}:${DOTNET_ROOT}/tools:${PATH}"
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_NOLOGO=1
ENV DOTNET_VERSION=9.0

WORKDIR /app
CMD ["bash"]
