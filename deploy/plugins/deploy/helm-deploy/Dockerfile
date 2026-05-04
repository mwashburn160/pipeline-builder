# Helm Deploy Plugin — Kubernetes Helm Chart Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Installs, upgrades, uninstalls, or templates Helm charts
# Includes kubectl and AWS CLI for EKS authentication

# ─── Tool versions (override with --build-arg) ───
ARG KUBECTL_VERSION=1.31.4
ARG HELM_VERSION=3.16.4

FROM alpine/helm:${HELM_VERSION} AS helm-src

FROM pipeline-aws-cli-base:1.0

ARG KUBECTL_VERSION
ARG HELM_VERSION

# ─── kubectl ───
# SHA256-verified — see deploy/kubectl-deploy/Dockerfile for the rationale.
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" \
       -o /usr/local/bin/kubectl \
    && curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl.sha256" \
       -o /tmp/kubectl.sha256 \
    && echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum -c - \
    && rm /tmp/kubectl.sha256 \
    && chmod +x /usr/local/bin/kubectl

# ─── Helm (copied from official image) ───
COPY --from=helm-src /usr/bin/helm /usr/local/bin/helm

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
