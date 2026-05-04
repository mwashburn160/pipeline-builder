# dotnet format Plugin — Code Formatting Checker
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder

FROM pipeline-plugin-base:24.04

RUN apt-retry-install build-essential libssl-dev libicu-dev

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
