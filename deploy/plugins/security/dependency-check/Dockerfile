# OWASP Dependency-Check Plugin — Software Composition Analysis (SCA)
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans project dependencies for known CVEs via NVD database
# Supports Java, .NET, Node.js, Python, Ruby, Go, and more

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    wget \
    jq \
    ca-certificates \
    build-essential \
    gnupg \
    openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

# ─── Node.js (for npm/yarn/pnpm dependency resolution) ───
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ─── Python (for pip dependency resolution) ───
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# ─── Go (for go.mod dependency resolution) ───
ENV GOENV_ROOT=/opt/goenv
RUN git clone https://github.com/go-nv/goenv.git ${GOENV_ROOT}
RUN ${GOENV_ROOT}/bin/goenv install 1.22.10 && ${GOENV_ROOT}/bin/goenv global 1.22.10
ENV PATH="${GOENV_ROOT}/shims:${GOENV_ROOT}/bin:${PATH}"

# ─── .NET SDK (for NuGet dependency resolution) ───
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && chmod +x /tmp/dotnet-install.sh \
    && /tmp/dotnet-install.sh --channel 8.0 --install-dir /opt/dotnet \
    && rm /tmp/dotnet-install.sh
ENV DOTNET_ROOT=/opt/dotnet
ENV PATH="${DOTNET_ROOT}:${DOTNET_ROOT}/tools:${PATH}"
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1

# ─── OWASP Dependency-Check CLI — multi-version support ───
RUN mkdir -p /opt/dependency-check/versions

# Install Dependency-Check versions
RUN curl -fsSL https://github.com/jeremylong/DependencyCheck/releases/download/v11.1.1/dependency-check-11.1.1-release.zip \
    -o /tmp/dc-11.1.1.zip \
    && unzip -q /tmp/dc-11.1.1.zip -d /opt/dependency-check/versions/dc-11.1.1 \
    && rm /tmp/dc-11.1.1.zip

RUN curl -fsSL https://github.com/jeremylong/DependencyCheck/releases/download/v12.0.0/dependency-check-12.0.0-release.zip \
    -o /tmp/dc-12.0.0.zip \
    && unzip -q /tmp/dc-12.0.0.zip -d /opt/dependency-check/versions/dc-12.0.0 \
    && rm /tmp/dc-12.0.0.zip

# Default to latest installed version
RUN ln -sf /opt/dependency-check/versions/dc-12.0.0/dependency-check /opt/dependency-check/current
ENV PATH="/opt/dependency-check/current/bin:${PATH}"

# ─── Runtime configuration defaults ───
# Non-sensitive config only — NVD API key injected at runtime via CodeBuild secrets
ENV DC_VERSION=12.0.0
ENV DC_FAIL_ON_CVSS=7
ENV DC_FORMAT=JSON
ENV DC_SUPPRESSION_FILE=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
