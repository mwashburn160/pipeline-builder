# Helm Deploy Plugin — Kubernetes Helm Chart Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Installs, upgrades, uninstalls, or templates Helm charts
# Includes kubectl and AWS CLI for EKS authentication

# ─── Tool versions (override with --build-arg) ───
ARG KUBECTL_VERSION=1.37.0
ARG HELM_VERSION=4.3.0

FROM alpine/helm:${HELM_VERSION} AS helm-src

FROM pipeline-aws-cli-base:1.0

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

ARG KUBECTL_VERSION
ARG HELM_VERSION

# ─── kubectl ───
# SHA256-verified — see deploy/kubectl-deploy/Dockerfile for the rationale.
ARG KUBECTL_SHA256_AMD64=6129359f4e1f3848a5572ccb0b26cf28b8ca08cef38c95a765b2f64a2c961a2f
ARG KUBECTL_SHA256_ARM64=922df28df248cc00a9e025f947704f1d1482de64ece54cfe57e61f19eaf1eef3
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=amd64; sum="${KUBECTL_SHA256_AMD64}" ;; \
      arm64) arch=arm64; sum="${KUBECTL_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" "$sum" /usr/local/bin/kubectl; \
    chmod 0755 /usr/local/bin/kubectl

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
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
