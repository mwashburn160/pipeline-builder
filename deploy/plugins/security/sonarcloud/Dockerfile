# SonarCloud Plugin — Node.js / C++ scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# For other languages, use sonarcloud-python, sonarcloud-java, sonarcloud-go, sonarcloud-dotnet, sonarcloud-ruby, or sonarcloud-rust

# ─── Tool versions (override with --build-arg) ───
ARG SONAR_DEFAULT_VERSION=12.0
ARG SONAR_PREV_VERSION=11.5

FROM sonarsource/sonar-scanner-cli:${SONAR_DEFAULT_VERSION} AS scanner-default
FROM sonarsource/sonar-scanner-cli:${SONAR_PREV_VERSION} AS scanner-prev

FROM public.ecr.aws/docker/library/ubuntu:24.04

ARG SONAR_DEFAULT_VERSION
ARG SONAR_PREV_VERSION

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    build-essential \
    gnupg \
    cmake \
    clang \
    ninja-build \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# ─── Node.js (default runtime) ───
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ─── SonarScanner CLI (copied from official images) ───
RUN mkdir -p /opt/sonar-scanner/versions
COPY --from=scanner-default /opt/sonar-scanner /opt/sonar-scanner/versions/scanner-${SONAR_DEFAULT_VERSION}
COPY --from=scanner-prev /opt/sonar-scanner /opt/sonar-scanner/versions/scanner-${SONAR_PREV_VERSION}
RUN ln -sf /opt/sonar-scanner/versions/scanner-${SONAR_DEFAULT_VERSION}/bin/sonar-scanner /usr/local/bin/sonar-scanner

# ─── Runtime configuration defaults ───
ENV SONAR_SCANNER_VERSION=${SONAR_DEFAULT_VERSION}
ENV SONAR_ORGANIZATION=""
ENV SONAR_PROJECT_KEY=""

# Working directory for pipeline source
WORKDIR /app

CMD ["bash"]
