# Helm Deploy Plugin — Kubernetes Helm Chart Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Installs, upgrades, uninstalls, or templates Helm charts
# Includes kubectl and AWS CLI for EKS authentication

# ─── Tool versions (override with --build-arg) ───
ARG KUBECTL_VERSION=1.31.4
ARG HELM_VERSION=3.16.4

FROM public.ecr.aws/docker/library/ubuntu:24.04

ARG KUBECTL_VERSION
ARG HELM_VERSION

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    jq \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# ─── AWS CLI v2 (for EKS authentication) ───
RUN curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscli.zip

# ─── kubectl ───
RUN curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl

# ─── Helm ───
RUN curl -fsSL https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz -o /tmp/helm.tar.gz \
    && tar -xzf /tmp/helm.tar.gz -C /tmp \
    && mv /tmp/linux-amd64/helm /usr/local/bin/helm \
    && chmod +x /usr/local/bin/helm \
    && rm -rf /tmp/helm.tar.gz /tmp/linux-amd64

# ─── Runtime configuration defaults ───
ENV HELM_RELEASE=""
ENV HELM_CHART=""
ENV HELM_NAMESPACE=default
ENV HELM_ACTION=upgrade
ENV HELM_VALUES_FILE=""
ENV HELM_SET_VALUES=""
ENV HELM_TIMEOUT=300s
ENV HELM_ATOMIC=true
ENV HELM_REPO_URL=""
ENV HELM_REPO_NAME=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
