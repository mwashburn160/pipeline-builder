# Git Secrets Plugin — Secret/Credential Detection
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Combines Gitleaks + TruffleHog for comprehensive secret scanning
# Detects API keys, passwords, tokens, and other sensitive data in code

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
    && rm -rf /var/lib/apt/lists/*

# ─── Gitleaks — secret detection ───
RUN mkdir -p /opt/gitleaks/versions

RUN curl -fsSL https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_x64.tar.gz \
    | tar -xz -C /opt/gitleaks/versions && mv /opt/gitleaks/versions/gitleaks /opt/gitleaks/versions/gitleaks-8.21.2

RUN curl -fsSL https://github.com/gitleaks/gitleaks/releases/download/v8.22.0/gitleaks_8.22.0_linux_x64.tar.gz \
    | tar -xz -C /opt/gitleaks/versions && mv /opt/gitleaks/versions/gitleaks /opt/gitleaks/versions/gitleaks-8.22.0

RUN ln -sf /opt/gitleaks/versions/gitleaks-8.22.0 /usr/local/bin/gitleaks

# ─── TruffleHog — credential scanner ───
RUN mkdir -p /opt/trufflehog/versions

RUN curl -fsSL https://github.com/trufflesecurity/trufflehog/releases/download/v3.84.1/trufflehog_3.84.1_linux_amd64.tar.gz \
    | tar -xz -C /opt/trufflehog/versions && mv /opt/trufflehog/versions/trufflehog /opt/trufflehog/versions/trufflehog-3.84.1

RUN ln -sf /opt/trufflehog/versions/trufflehog-3.84.1 /usr/local/bin/trufflehog

# ─── Runtime configuration defaults ───
ENV GITLEAKS_VERSION=8.22.0
ENV SCAN_MODE=directory
ENV GITLEAKS_CONFIG=""
ENV REPORT_FORMAT=json

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
