# Helm Push Plugin — Package and Push Helm Charts
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports OCI registries, ChartMuseum, and S3

FROM pipeline-plugin-base:24.04

# ─── Helm 3 ───
RUN curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# ─── AWS CLI v2 (for ECR OCI registry support) ───
RUN ARCH=$(uname -m) && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscli.zip

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
