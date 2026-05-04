# kubectl Deploy Plugin — Kubernetes Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Deploys, deletes, or performs rollout restarts via kubectl
# Supports EKS authentication via AWS CLI

# ─── Tool versions (override with --build-arg) ───
ARG KUBECTL_VERSION=1.31.4

FROM pipeline-plugin-base:24.04

ARG KUBECTL_VERSION

# ─── AWS CLI v2 (for EKS authentication) ───
RUN ARCH=$(uname -m) && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscli.zip

# ─── kubectl ───
# SHA256-verified — kubernetes.io publishes a `kubectl.sha256` companion
# file alongside every binary. Without this, a TLS interception or mirror
# compromise could substitute a malicious binary that we'd silently install.
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" \
       -o /usr/local/bin/kubectl \
    && curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl.sha256" \
       -o /tmp/kubectl.sha256 \
    && echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum -c - \
    && rm /tmp/kubectl.sha256 \
    && chmod +x /usr/local/bin/kubectl

# ─── Runtime configuration defaults ───
ENV KUBE_CONTEXT=""
ENV KUBE_NAMESPACE=default
ENV DEPLOY_ACTION=apply
ENV MANIFEST_PATH=k8s/
ENV ROLLOUT_TIMEOUT=300s

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
