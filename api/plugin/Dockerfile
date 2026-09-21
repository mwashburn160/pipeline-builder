ARG NODE_VERSION=24.14.0
# buildctl matches the buildkitd sidecar (moby/buildkit:v0.32.1-rootless in
# deploy/*/k8s/plugin.yaml) — attestation + --metadata-file support lives in
# both halves, so the client must not lag the daemon.
ARG BUILDKIT_VERSION=v0.32.1
ARG BUILDKIT_SHA256=f3d7c940af614f9d7a158873eef8d1d69476f88dde61e9d14ab9186e99ad6dd5
ARG CRANE_VERSION=v0.20.2
ARG CRANE_SHA256=c14340087103ba9dadf61d45acd20675490fd0ccbd56ac7901fc1b502137f44b
# cosign v2 (not v3): v2 keeps the key-based, tlog-off flags and the
# `sha256-<digest>.sig/.att` tag layout the in-cluster registry:3 serves (it has
# no reliable OCI referrers API, which v3's bundle format defaults to).
ARG COSIGN_VERSION=v2.6.5
ARG COSIGN_SHA256=c3b4f5410e608af03a5eb0aaac84a4313d8da131248e08ff1759ac70c79d1644
ARG SYFT_VERSION=1.52.0
ARG SYFT_SHA256=caeedb81fb0491615f1ebd1761e4145d41ee86dd2cc7bf80669f9f5ad9d6133d

# =============================================================================
# Plugin service image.
#
# Builds run against a rootless buildkitd sidecar; this image only carries the
# `buildctl` client. The single dockerd/podman/kaniko strategy switch is gone —
# every deploy target uses the same code path now.
# =============================================================================

FROM node:${NODE_VERSION}-slim AS tools
ARG BUILDKIT_VERSION
ARG BUILDKIT_SHA256
ARG CRANE_VERSION
ARG CRANE_SHA256
ARG COSIGN_VERSION
ARG COSIGN_SHA256
ARG SYFT_VERSION
ARG SYFT_SHA256
# buildctl: connects to the rootless buildkitd sidecar to run the actual build.
# crane:    pushes prebuilt `docker save` tarballs (buildctl cannot do that).
# syft:     generates the SPDX SBOM of every pushed plugin image.
# cosign:   signs each pushed digest and attaches the SBOM as a signed attestation.
# All download as static Linux binaries from upstream GitHub releases, each
# checked against a pinned SHA-256 — these tools hold the plugin-signing key and
# the registry push credential, so a swapped release asset must fail the build.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && cd /tmp \
    && curl -fsSLo buildkit.tgz "https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/buildkit-${BUILDKIT_VERSION}.linux-amd64.tar.gz" \
    && echo "${BUILDKIT_SHA256}  buildkit.tgz" | sha256sum -c - \
    && tar -xzf buildkit.tgz -C /usr/local bin/buildctl \
    && curl -fsSLo crane.tgz "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz" \
    && echo "${CRANE_SHA256}  crane.tgz" | sha256sum -c - \
    && tar -xzf crane.tgz -C /usr/local/bin crane \
    && curl -fsSLo /usr/local/bin/cosign "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64" \
    && echo "${COSIGN_SHA256}  /usr/local/bin/cosign" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/cosign \
    && curl -fsSLo syft.tgz "https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/syft_${SYFT_VERSION}_linux_amd64.tar.gz" \
    && echo "${SYFT_SHA256}  syft.tgz" | sha256sum -c - \
    && tar -xzf syft.tgz -C /usr/local/bin syft \
    && rm -f buildkit.tgz crane.tgz syft.tgz

FROM node:${NODE_VERSION}-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=tools /usr/local/bin/buildctl /usr/local/bin/buildctl
COPY --from=tools /usr/local/bin/crane /usr/local/bin/crane
COPY --from=tools /usr/local/bin/cosign /usr/local/bin/cosign
COPY --from=tools /usr/local/bin/syft /usr/local/bin/syft
WORKDIR /app
# F-0.3: node_modules is built OUTSIDE Docker by the docker:build script
# (`pnpm deploy --filter plugin --prod --legacy .docker-build`) so the
# install runs against pnpm-lock.yaml. The deps stage that used
# `npm install --omit=dev` was removed — caret-range drift on rebuild
# is no longer possible.
COPY .docker-build/node_modules ./node_modules
COPY .docker-build/package.json .
COPY .docker-build/lib/ /app
RUN mkdir -p /app/tmp /app/uploads && chown -R node:node /app/tmp /app/uploads
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
CMD ["node", "--import", "@pipeline-builder/api-server/lib/otel-bootstrap.js", "index.js"]