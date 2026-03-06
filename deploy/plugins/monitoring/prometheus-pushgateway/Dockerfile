# Prometheus Pushgateway Plugin — Build Metrics
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Pushes pipeline metrics to Prometheus via Pushgateway

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ─── Runtime configuration defaults ───
ENV PUSHGATEWAY_URL=""
ENV JOB_NAME=pipeline
ENV SERVICE_NAME=""
ENV ENVIRONMENT=production
ENV BUILD_STATUS=1

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
