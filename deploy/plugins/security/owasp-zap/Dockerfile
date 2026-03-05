# OWASP ZAP Plugin — Dynamic Application Security Testing (DAST)
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs ZAP scans against a target URL to find runtime vulnerabilities
# Supports baseline, full, and API scan modes

# ─── Tool versions (override with --build-arg) ───
ARG ZAP_VERSION=2.16.0

FROM public.ecr.aws/docker/library/ubuntu:24.04

ARG ZAP_VERSION

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
    python3 \
    python3-pip \
    openjdk-17-jre-headless \
    xmlstarlet \
    && rm -rf /var/lib/apt/lists/*

# ─── OWASP ZAP ───
RUN mkdir -p /opt/zap/versions \
    && curl -fsSL https://github.com/zaproxy/zaproxy/releases/download/v${ZAP_VERSION}/ZAP_${ZAP_VERSION}_Linux.tar.gz \
    | tar -xz -C /opt/zap/versions \
    && mv /opt/zap/versions/ZAP_${ZAP_VERSION} /opt/zap/versions/zap-${ZAP_VERSION} \
    && ln -sf /opt/zap/versions/zap-${ZAP_VERSION} /opt/zap/current
ENV PATH="/opt/zap/current:${PATH}"

# Install ZAP Python API client
RUN pip3 install --no-cache-dir --break-system-packages python-owasp-zap-v2.4==0.0.22

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
