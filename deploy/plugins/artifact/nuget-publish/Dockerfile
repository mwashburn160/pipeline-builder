# NuGet Publish Plugin — Publish packages to NuGet Gallery
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Publishes .NET packages to NuGet Gallery or custom feeds
# Requires NUGET_API_KEY injected at runtime via CodeBuild secrets

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ─── .NET SDK 8.0 via dotnet-install.sh ───
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && chmod +x /tmp/dotnet-install.sh \
    && /tmp/dotnet-install.sh --channel 8.0 --install-dir /opt/dotnet \
    && rm /tmp/dotnet-install.sh

# Add .NET to PATH
ENV DOTNET_ROOT=/opt/dotnet
ENV PATH="${DOTNET_ROOT}:${PATH}"

# ─── Runtime configuration defaults ───
# Non-sensitive config only — NUGET_API_KEY injected at runtime via CodeBuild secrets
ENV NUGET_SOURCE=https://api.nuget.org/v3/index.json

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
