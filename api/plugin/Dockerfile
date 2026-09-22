# Base image pinned BY DIGEST (tag kept for readers): a re-pushed or
# compromised tag cannot change what a release image is built from. Bump both
# together (docker buildx imagetools inspect node:<ver>-slim).
ARG NODE_IMAGE=node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
# buildctl matches the buildkitd sidecar (moby/buildkit:v0.32.1-rootless in
# deploy/*/k8s/plugin.yaml) — attestation + --metadata-file support lives in
# both halves, so the client must not lag the daemon.
ARG BUILDKIT_VERSION=v0.32.1
ARG BUILDKIT_SHA256_AMD64=f3d7c940af614f9d7a158873eef8d1d69476f88dde61e9d14ab9186e99ad6dd5
ARG BUILDKIT_SHA256_ARM64=1ad31947395de1f1d49bd4d1024e9c3f9167f80bfdd2ad362bfe6a42e19ab721
ARG CRANE_VERSION=v0.20.2
ARG CRANE_SHA256_AMD64=c14340087103ba9dadf61d45acd20675490fd0ccbd56ac7901fc1b502137f44b
ARG CRANE_SHA256_ARM64=aff0db48825124c9331ea310057214bd4e92c01aa2e414d539e9659841d9422a
# cosign v2 (not v3): v2 keeps the key-based, tlog-off flags and the
# `sha256-<digest>.sig/.att` tag layout the in-cluster registry:3 serves (it has
# no reliable OCI referrers API, which v3's bundle format defaults to).
ARG COSIGN_VERSION=v2.6.5
ARG COSIGN_SHA256_AMD64=c3b4f5410e608af03a5eb0aaac84a4313d8da131248e08ff1759ac70c79d1644
ARG COSIGN_SHA256_ARM64=426193b4c5da4d4d643e822f48fe0cc8a476ca1782a272704831f5a0cef716d7
ARG SYFT_VERSION=1.52.0
ARG SYFT_SHA256_AMD64=caeedb81fb0491615f1ebd1761e4145d41ee86dd2cc7bf80669f9f5ad9d6133d
ARG SYFT_SHA256_ARM64=c46d5e4c28e12aa4c5becfaa343ef1c7f89045b6b895f2c21d471c62db09c706
# grype matches syft 1.52 (same release train). Hashes from the release's
# grype_<version>_checksums.txt.
ARG GRYPE_VERSION=0.119.0
ARG GRYPE_SHA256_AMD64=3fa2dc4b924621ab65404cf08d0b8438d896d80ab949c9d5a4ca283c36004c9b
ARG GRYPE_SHA256_ARM64=29f0ec7c549ddb0e2b6a0ca714851f7399438afc399b80c12808e065edc9a8f8

# =============================================================================
# Plugin service image.
#
# Builds run against a rootless buildkitd sidecar; this image only carries the
# `buildctl` client. The single dockerd/podman/kaniko strategy switch is gone —
# every deploy target uses the same code path now.
# =============================================================================

FROM ${NODE_IMAGE} AS tools
ARG TARGETARCH
ARG BUILDKIT_VERSION
ARG BUILDKIT_SHA256_AMD64
ARG BUILDKIT_SHA256_ARM64
ARG CRANE_VERSION
ARG CRANE_SHA256_AMD64
ARG CRANE_SHA256_ARM64
ARG COSIGN_VERSION
ARG COSIGN_SHA256_AMD64
ARG COSIGN_SHA256_ARM64
ARG SYFT_VERSION
ARG SYFT_SHA256_AMD64
ARG SYFT_SHA256_ARM64
ARG GRYPE_VERSION
ARG GRYPE_SHA256_AMD64
ARG GRYPE_SHA256_ARM64
# buildctl: connects to the rootless buildkitd sidecar to run the actual build.
# crane:    pushes prebuilt `docker save` tarballs (buildctl cannot do that).
# syft:     generates the SPDX SBOM of every pushed plugin image.
# cosign:   verifies plugin signatures and reads back the signed SBOM attestation.
# grype:    scans that SBOM for known vulnerabilities (build + nightly rescan).
# All download as static Linux binaries from upstream GitHub releases, each
# checked against a pinned per-arch SHA-256 — these tools hold the plugin-signing
# key and the registry push credential, so a swapped release asset must fail the build.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && case "${TARGETARCH:-amd64}" in \
         amd64) crane_arch=x86_64 \
                buildkit_sum="${BUILDKIT_SHA256_AMD64}" crane_sum="${CRANE_SHA256_AMD64}" \
                cosign_sum="${COSIGN_SHA256_AMD64}" syft_sum="${SYFT_SHA256_AMD64}" \
                grype_sum="${GRYPE_SHA256_AMD64}" ;; \
         arm64) crane_arch=arm64 \
                buildkit_sum="${BUILDKIT_SHA256_ARM64}" crane_sum="${CRANE_SHA256_ARM64}" \
                cosign_sum="${COSIGN_SHA256_ARM64}" syft_sum="${SYFT_SHA256_ARM64}" \
                grype_sum="${GRYPE_SHA256_ARM64}" ;; \
         *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    && arch="${TARGETARCH:-amd64}" \
    && cd /tmp \
    && curl -fsSLo buildkit.tgz "https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/buildkit-${BUILDKIT_VERSION}.linux-${arch}.tar.gz" \
    && echo "${buildkit_sum}  buildkit.tgz" | sha256sum -c - \
    && tar -xzf buildkit.tgz -C /usr/local bin/buildctl \
    && curl -fsSLo crane.tgz "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_${crane_arch}.tar.gz" \
    && echo "${crane_sum}  crane.tgz" | sha256sum -c - \
    && tar -xzf crane.tgz -C /usr/local/bin crane \
    && curl -fsSLo /usr/local/bin/cosign "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-${arch}" \
    && echo "${cosign_sum}  /usr/local/bin/cosign" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/cosign \
    && curl -fsSLo syft.tgz "https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/syft_${SYFT_VERSION}_linux_${arch}.tar.gz" \
    && echo "${syft_sum}  syft.tgz" | sha256sum -c - \
    && tar -xzf syft.tgz -C /usr/local/bin syft \
    && curl -fsSLo grype.tgz "https://github.com/anchore/grype/releases/download/v${GRYPE_VERSION}/grype_${GRYPE_VERSION}_linux_${arch}.tar.gz" \
    && echo "${grype_sum}  grype.tgz" | sha256sum -c - \
    && tar -xzf grype.tgz -C /usr/local/bin grype \
    && rm -f buildkit.tgz crane.tgz syft.tgz grype.tgz

FROM ${NODE_IMAGE}
# Runtime hardening: pull the latest patched OS packages (the base digest can lag
# an openssl/musl/zlib fix) and drop the npm/corepack/yarn CLIs the image never runs —
# they ship their own dependency trees (tar, pacote, sigstore, minimatch …) that the
# release grype gate would otherwise flag.
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
       /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
COPY --from=tools /usr/local/bin/buildctl /usr/local/bin/buildctl
COPY --from=tools /usr/local/bin/crane /usr/local/bin/crane
COPY --from=tools /usr/local/bin/cosign /usr/local/bin/cosign
COPY --from=tools /usr/local/bin/syft /usr/local/bin/syft
COPY --from=tools /usr/local/bin/grype /usr/local/bin/grype
WORKDIR /app
# F-0.3: node_modules is built OUTSIDE Docker by the docker:build script
# (`pnpm deploy --filter plugin --prod --legacy .docker-build`) so the
# install runs against pnpm-lock.yaml. The deps stage that used
# `npm install --omit=dev` was removed — caret-range drift on rebuild
# is no longer possible.
COPY .docker-build/node_modules ./node_modules
COPY .docker-build/package.json .
COPY .docker-build/lib/ /app
# /var/cache/grype: the vulnerability DB (GRYPE_DB_CACHE_DIR). Every deploy
# mounts a volume here; pre-creating it node-owned makes a fresh Docker named
# volume inherit that ownership (k8s mounts a world-writable emptyDir).
RUN mkdir -p /app/tmp /app/uploads /var/cache/grype \
    && chown -R node:node /app/tmp /app/uploads /var/cache/grype
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
CMD ["node", "--import", "@pipeline-builder/api-server/lib/otel-bootstrap.js", "index.js"]