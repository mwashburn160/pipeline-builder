# Health Check Plugin — Post-Deploy Smoke Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Verifies deployed application endpoints are healthy
# Supports HTTP checks, TCP connectivity, and custom health endpoints

FROM pipeline-plugin-base:24.04

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

RUN apt-retry-install netcat-openbsd dnsutils jq

# ─── Runtime configuration defaults ───
ENV HEALTH_ENDPOINTS=""
ENV HEALTH_TIMEOUT=10
ENV HEALTH_RETRIES=3
ENV HEALTH_RETRY_DELAY=5
ENV EXPECTED_STATUS=200

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
