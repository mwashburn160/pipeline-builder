# kubectl Deploy Plugin — Kubernetes Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Deploys, deletes, or performs rollout restarts via kubectl
# Supports EKS authentication via AWS CLI

# ─── Tool versions (override with --build-arg) ───
ARG KUBECTL_VERSION=1.37.0

FROM pipeline-aws-cli-base:1.0

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

ARG KUBECTL_VERSION

# ─── kubectl ───
# Pinned digest — the values are kubernetes.io's published `kubectl.sha256`
# companions for this release, baked into the Dockerfile (not fetched at build
# time next to the binary, which a mirror compromise could swap together).
# fetch-verified refuses to install on mismatch.
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

# ─── Runtime configuration defaults ───
ENV KUBE_CONTEXT=""
ENV KUBE_NAMESPACE=default
ENV DEPLOY_ACTION=apply
ENV MANIFEST_PATH=k8s/
ENV ROLLOUT_TIMEOUT=300s

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
