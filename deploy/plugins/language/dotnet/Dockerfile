# .NET Plugin — Multi-version build environment using dotnet-install.sh
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# .NET version is selected at runtime via DOTNET_VERSION env var

FROM pipeline-plugin-base:24.04

# System dependencies for builds
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libssl-dev \
    libicu-dev \
    && rm -rf /var/lib/apt/lists/*

# Install current + previous .NET SDK versions
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && chmod +x /tmp/dotnet-install.sh \
    && /tmp/dotnet-install.sh --channel 8.0 --install-dir /opt/dotnet \
    && /tmp/dotnet-install.sh --channel 9.0 --install-dir /opt/dotnet \
    && rm /tmp/dotnet-install.sh

# Add .NET to PATH
ENV DOTNET_ROOT=/opt/dotnet
ENV PATH="${DOTNET_ROOT}:${DOTNET_ROOT}/tools:${PATH}"
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_NOLOGO=1

# Default .NET version (overridden by DOTNET_VERSION env var at runtime)
ENV DOTNET_VERSION=9.0

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
