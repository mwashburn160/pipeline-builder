# OWASP ZAP Plugin — Dynamic Application Security Testing (DAST)
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs ZAP scans against a target URL to find runtime vulnerabilities
# Supports baseline, full, and API scan modes

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
    python3 \
    python3-pip \
    openjdk-17-jre-headless \
    xmlstarlet \
    && rm -rf /var/lib/apt/lists/*

# ─── OWASP ZAP — multi-version support ───
RUN mkdir -p /opt/zap/versions

# Install ZAP versions
RUN curl -fsSL https://github.com/zaproxy/zaproxy/releases/download/v2.15.0/ZAP_2.15.0_Linux.tar.gz \
    | tar -xz -C /opt/zap/versions && mv /opt/zap/versions/ZAP_2.15.0 /opt/zap/versions/zap-2.15.0

RUN curl -fsSL https://github.com/zaproxy/zaproxy/releases/download/v2.16.0/ZAP_2.16.0_Linux.tar.gz \
    | tar -xz -C /opt/zap/versions && mv /opt/zap/versions/ZAP_2.16.0 /opt/zap/versions/zap-2.16.0

# Default to latest installed version
RUN ln -sf /opt/zap/versions/zap-2.16.0 /opt/zap/current
ENV PATH="/opt/zap/current:${PATH}"

# Install ZAP Python API client
RUN pip3 install --no-cache-dir python-owasp-zap-v2.4==0.0.22

# ─── Runtime configuration defaults ───
# Non-sensitive config only — no tokens or secrets in ENV/ARG
ENV ZAP_VERSION=2.16.0
ENV ZAP_SCAN_TYPE=baseline
ENV ZAP_TARGET_URL=""
ENV ZAP_RULES_CONFIG=""
ENV ZAP_FORMAT=json

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
