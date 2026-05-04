# Health Check Plugin — Post-Deploy Smoke Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Verifies deployed application endpoints are healthy
# Supports HTTP checks, TCP connectivity, and custom health endpoints

FROM pipeline-plugin-base:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    wget \
    jq \
    ca-certificates \
    netcat-openbsd \
    dnsutils \
    && rm -rf /var/lib/apt/lists/*

# ─── Runtime configuration defaults ───
ENV HEALTH_ENDPOINTS=""
ENV HEALTH_TIMEOUT=10
ENV HEALTH_RETRIES=3
ENV HEALTH_RETRY_DELAY=5
ENV EXPECTED_STATUS=200

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
