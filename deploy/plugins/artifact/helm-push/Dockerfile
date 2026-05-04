# Helm Push Plugin — Package and Push Helm Charts
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports OCI registries, ChartMuseum, and S3

FROM pipeline-aws-cli-base:1.0

# ─── Helm 3 ───
RUN curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# ─── Helm push plugin for ChartMuseum ───
RUN helm plugin install https://github.com/chartmuseum/helm-push || \
    (echo "WARNING: Failed to install helm-push plugin for ChartMuseum support" && exit 0)

# ─── Runtime configuration defaults ───
ENV HELM_CHART_PATH=.
ENV HELM_REGISTRY=""
ENV HELM_REGISTRY_TYPE=oci
ENV CHART_VERSION=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
