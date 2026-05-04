# Health Check Plugin — Post-Deploy Smoke Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Verifies deployed application endpoints are healthy
# Supports HTTP checks, TCP connectivity, and custom health endpoints

FROM pipeline-plugin-base:24.04

RUN apt-retry-install netcat-openbsd dnsutils

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
