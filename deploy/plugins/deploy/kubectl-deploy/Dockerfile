# kubectl Deploy Plugin — Kubernetes Deployment
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Deploys, deletes, or performs rollout restarts via kubectl
# Supports EKS authentication via AWS CLI

# ─── Tool versions (override with --build-arg) ───
#
# VULN SCAN (OSV, 2026-09-27): querying `Go:k8s.io/kubernetes` at this version matches
# GO-2025-3521 (CVE-2025-1767, the kubelet `gitRepo` volume) and GO-2025-3547
# (CVE-2024-7598, a kube-apiserver race). Neither affects the kubectl CLIENT this image
# ships, and neither advisory carries a `fixed` event — gitRepo is deprecated upstream and
# will not be patched — so an upgrade cannot clear either. 1.37.1 is the current k8s stable.
# Note the submodule `k8s.io/kubectl` has NO advisory data at all, so scanning under that
# name reports a clean result that means "nothing indexed", not "nothing wrong".
ARG KUBECTL_VERSION=1.37.1

FROM plugin-aws-cli-base:1.0

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

ARG KUBECTL_VERSION

# ─── kubectl ───
# Pinned digest — the values are kubernetes.io's published `kubectl.sha256`
# companions for this release, baked into the Dockerfile (not fetched at build
# time next to the binary, which a mirror compromise could swap together).
# fetch-verified refuses to install on mismatch.
ARG KUBECTL_SHA256_AMD64=65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8
ARG KUBECTL_SHA256_ARM64=ff749f4b78d9c4f1ec87307df9b50119ed819e2094aa9810cb9acffc3286c8c7
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
