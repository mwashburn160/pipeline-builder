# Grafana Annotation Plugin — Deploy Markers on Dashboards
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Posts annotations to Grafana dashboards via HTTP API

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
ENV GRAFANA_URL=""
ENV GRAFANA_DASHBOARD_ID=""
ENV GRAFANA_TAGS=deploy
ENV SERVICE_NAME=""
ENV SERVICE_VERSION=""
ENV ENVIRONMENT=production

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
