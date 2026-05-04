# GCP Deploy Plugin — Google Cloud Infrastructure Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports App Engine, Cloud Run, GKE, and Compute Engine deployments
# Includes gcloud SDK, kubectl, and Terraform for infrastructure management

ARG KUBECTL_VERSION=1.31.4
ARG TERRAFORM_VERSION=1.10.3

FROM pipeline-plugin-base:24.04
ARG KUBECTL_VERSION
ARG TERRAFORM_VERSION

RUN apt-retry-install apt-transport-https

# ─── Google Cloud SDK ───
RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
       > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update && apt-get install -y --no-install-recommends \
       google-cloud-cli \
       google-cloud-cli-gke-gcloud-auth-plugin \
    && rm -rf /var/lib/apt/lists/*

# ─── kubectl ───
# Pinned + SHA256-verified, matching kubectl-deploy/helm-deploy. Was previously
# using `stable.txt` (floating) and no checksum.
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" \
       -o /usr/local/bin/kubectl \
    && curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl.sha256" \
       -o /tmp/kubectl.sha256 \
    && echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum -c - \
    && rm /tmp/kubectl.sha256 \
    && chmod +x /usr/local/bin/kubectl

# ─── Terraform ───
# Bumping requires only changing TERRAFORM_VERSION arg, not edit-search-replace.
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${ARCH}.zip" \
       -o /tmp/terraform.zip \
    && unzip -q /tmp/terraform.zip -d /usr/local/bin \
    && rm /tmp/terraform.zip

# ─── Runtime configuration defaults ───
# Non-sensitive config only — GOOGLE_APPLICATION_CREDENTIALS injected at runtime via CodeBuild secrets
ENV GCP_PROJECT=""
ENV GCP_REGION=us-central1
ENV DEPLOY_TYPE=app-engine

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
