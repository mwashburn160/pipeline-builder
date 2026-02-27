# GCP Deploy Plugin — Google Cloud Infrastructure Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports App Engine, Cloud Run, GKE, and Compute Engine deployments
# Includes gcloud SDK, kubectl, and Terraform for infrastructure management

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    ca-certificates \
    gnupg \
    apt-transport-https \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# ─── Google Cloud SDK ───
RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
       > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update && apt-get install -y --no-install-recommends \
       google-cloud-cli \
       google-cloud-cli-gke-gcloud-auth-plugin \
    && rm -rf /var/lib/apt/lists/*

# ─── kubectl ───
RUN curl -fsSL "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    -o /usr/local/bin/kubectl && chmod +x /usr/local/bin/kubectl

# ─── Terraform ───
RUN curl -fsSL https://releases.hashicorp.com/terraform/1.10.3/terraform_1.10.3_linux_amd64.zip \
    -o /tmp/terraform.zip && unzip -q /tmp/terraform.zip -d /usr/local/bin && rm /tmp/terraform.zip

# ─── Runtime configuration defaults ───
# Non-sensitive config only — GOOGLE_APPLICATION_CREDENTIALS injected at runtime via CodeBuild secrets
ENV GCP_PROJECT=""
ENV GCP_REGION=us-central1
ENV DEPLOY_TYPE=app-engine

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
