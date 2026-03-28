# OWASP Dependency-Check Plugin — Software Composition Analysis (SCA)
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans project dependencies for known CVEs via NVD database
# Supports Java, .NET, Node.js, Python, Ruby, Go, and more

# ─── Tool versions (override with --build-arg) ───
ARG DC_DEFAULT_VERSION=12.2.0
ARG DC_PREV_VERSION=11.1.1

FROM owasp/dependency-check:${DC_DEFAULT_VERSION} AS dc-default
FROM owasp/dependency-check:${DC_PREV_VERSION} AS dc-prev

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Re-declare ARGs after FROM so they're available in this stage
ARG DC_DEFAULT_VERSION
ARG DC_PREV_VERSION

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies + Python + Node.js for multi-language dependency resolution
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
    python3 \
    python3-pip \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ─── Go (for go.mod dependency resolution) ───
ENV GOENV_ROOT=/opt/goenv
RUN git clone https://github.com/go-nv/goenv.git ${GOENV_ROOT}
RUN ${GOENV_ROOT}/bin/goenv install 1.24.13 && ${GOENV_ROOT}/bin/goenv global 1.24.13
ENV PATH="${GOENV_ROOT}/shims:${GOENV_ROOT}/bin:${PATH}"

# ─── .NET SDK (for NuGet dependency resolution) ───
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && chmod +x /tmp/dotnet-install.sh \
    && /tmp/dotnet-install.sh --channel 8.0 --install-dir /opt/dotnet \
    && rm /tmp/dotnet-install.sh
ENV DOTNET_ROOT=/opt/dotnet
ENV PATH="${DOTNET_ROOT}:${DOTNET_ROOT}/tools:${PATH}"
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1

# ─── OWASP Dependency-Check CLI (copied from official images) ───
RUN mkdir -p /opt/dependency-check/versions
COPY --from=dc-default /usr/share/dependency-check /opt/dependency-check/versions/dc-${DC_DEFAULT_VERSION}
COPY --from=dc-prev /usr/share/dependency-check /opt/dependency-check/versions/dc-${DC_PREV_VERSION}

# Default to latest installed version
RUN ln -sf /opt/dependency-check/versions/dc-${DC_DEFAULT_VERSION} /opt/dependency-check/current
ENV PATH="/opt/dependency-check/current/bin:${PATH}"

# ─── Runtime configuration defaults ───
# Non-sensitive config only — NVD API key injected at runtime via CodeBuild secrets
ENV DC_VERSION=${DC_DEFAULT_VERSION}
ENV DC_FAIL_ON_CVSS=7
ENV DC_FORMAT=JSON
ENV DC_SUPPRESSION_FILE=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
