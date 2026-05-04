# Azure Deploy Plugin — Azure Infrastructure Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports Web App, Container Instances, AKS, and Function deployments
# Includes Azure CLI and kubectl for infrastructure management

ARG KUBECTL_VERSION=1.31.4

FROM pipeline-plugin-base:24.04
ARG KUBECTL_VERSION

RUN apt-retry-install apt-transport-https lsb-release

# ─── Azure CLI ───
RUN curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/microsoft.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ $(lsb_release -cs) main" \
       > /etc/apt/sources.list.d/azure-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends azure-cli \
    && rm -rf /var/lib/apt/lists/*

# ─── kubectl ───
# Pinned + SHA256-verified, matching kubectl-deploy/helm-deploy.
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" \
       -o /usr/local/bin/kubectl \
    && curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl.sha256" \
       -o /tmp/kubectl.sha256 \
    && echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum -c - \
    && rm /tmp/kubectl.sha256 \
    && chmod +x /usr/local/bin/kubectl

# ─── Runtime configuration defaults ───
# Non-sensitive config only — AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID injected at runtime
ENV AZURE_SUBSCRIPTION=""
ENV AZURE_RESOURCE_GROUP=""
ENV DEPLOY_TYPE=webapp

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
