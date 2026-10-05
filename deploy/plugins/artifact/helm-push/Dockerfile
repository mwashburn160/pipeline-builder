# Helm Push Plugin — Package and Push Helm Charts
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports OCI registries, ChartMuseum, and S3

FROM pipeline-aws-cli-base:1.0

# Build steps below need root (writes under /usr/local and /opt); the image
# drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

# ─── Helm 3 ───
# Pinned release tarball + get.helm.sh's published SHA-256 (replaces the
# unpinned `get-helm-3 | bash` installer, which always pulled latest).
ARG HELM_VERSION=4.3.0
ARG HELM_SHA256_AMD64=86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb
ARG HELM_SHA256_ARM64=31c5794dd55c66a51e6b7d2e2ac7a114ae8b1de41ff1d9ba51748ac973b06a08
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=amd64; sum="${HELM_SHA256_AMD64}" ;; \
      arm64) arch=arm64; sum="${HELM_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${arch}.tar.gz" "$sum" /tmp/helm.tar.gz; \
    tar -xzf /tmp/helm.tar.gz -C /usr/local/bin --strip-components=1 "linux-${arch}/helm"; \
    rm -f /tmp/helm.tar.gz; \
    helm version --short

# ─── No ChartMuseum plugin ───
# `helm-cm-push` (chartmuseum/helm-push) was installed here and is deliberately
# gone. Its latest release, v0.11.1 (2026-02-09), is built against
# go1.25.0 / grpc v1.72.2 / x/crypto v0.46.0 and carries NINE fixable Critical
# findings, which fails PLUGIN_VULN_GATE (PLUGIN_VULN_MAX_CRITICAL=0). There was
# nothing to upgrade to: 0.11.1 IS the newest, and the project has shipped
# nothing since.
#
# It was NOT helm that was behind — helm 4.3.0 already ships grpc v1.83.1 and
# x/crypto v0.55.0, newer than the fixes the gate asked for. Every one of those
# findings came from this one binary.
#
# Helm's native `helm push` covers OCI registries, which is what the spec's
# `oci` path uses and what ECR, GHCR, Harbor and ACR all speak. The chartmuseum
# path went with it. A pipeline that still targets a ChartMuseum server needs a
# plugin of its own; this image no longer pretends to support it.

# ─── Runtime configuration defaults ───
ENV HELM_CHART_PATH=.
ENV HELM_REGISTRY=""
ENV HELM_REGISTRY_TYPE=oci
ENV CHART_VERSION=""

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
