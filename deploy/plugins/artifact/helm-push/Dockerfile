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

# ─── Helm push plugin for ChartMuseum ───
# Pinned release tarball unpacked straight into a shared plugins dir (NOT
# `helm plugin install <git-url>`, which tracked HEAD and whose install hook
# curls an unverified binary). HELM_PLUGINS points helm at it for every user —
# the default (~/.local/share/helm/plugins) is per-user and would be invisible
# to the uid-1000 runtime user. Fail the build if the plugin doesn't load — a
# helm-push image without it silently can't push charts (honest gating).
#
# The upstream plugin.yaml also declares a `cm://` downloader; Helm 4 then
# classifies the plugin as getter-only and never registers the `cm-push`
# command. The spec only calls `helm cm-push`, so we write a CLI-only manifest
# (same name/version/command, no downloaders/install hooks) instead of the
# vendor's.
ARG HELM_PUSH_VERSION=0.11.1
ARG HELM_PUSH_SHA256_AMD64=d52a58ef598f0c228f178eabbb061c3195fc051f78001b54fc8f27d4673c9a61
ARG HELM_PUSH_SHA256_ARM64=984d0f2030a369d361f6e126424ce56ced7d29233504ca4966d03767793e71ee
ENV HELM_PLUGINS=/opt/helm/plugins
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=amd64; sum="${HELM_PUSH_SHA256_AMD64}" ;; \
      arm64) arch=arm64; sum="${HELM_PUSH_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://github.com/chartmuseum/helm-push/releases/download/v${HELM_PUSH_VERSION}/helm-push_${HELM_PUSH_VERSION}_linux_${arch}.tar.gz" "$sum" /tmp/helm-push.tar.gz; \
    mkdir -p "${HELM_PLUGINS}/helm-push"; \
    tar -xzf /tmp/helm-push.tar.gz -C "${HELM_PLUGINS}/helm-push" bin/helm-cm-push; \
    rm -f /tmp/helm-push.tar.gz; \
    printf '%s\n' 'name: "cm-push"' "version: \"${HELM_PUSH_VERSION}\"" \
      'usage: "Please see https://github.com/chartmuseum/helm-push for usage"' \
      'description: "Push chart package to ChartMuseum"' \
      'command: "$HELM_PLUGIN_DIR/bin/helm-cm-push"' \
      > "${HELM_PLUGINS}/helm-push/plugin.yaml"; \
    chmod -R a+rX "${HELM_PLUGINS}"; \
    helm cm-push --help >/dev/null

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
