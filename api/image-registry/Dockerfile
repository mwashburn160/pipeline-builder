# Base image pinned BY DIGEST (tag kept for readers): a re-pushed or
# compromised tag cannot change what a release image is built from. Bump both
# together (docker buildx imagetools inspect node:<ver>-alpine).
ARG NODE_IMAGE=node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
# cosign signs plugin images with the plugin-signing key (this service is its
# only holder — see src/services/plugin-signing.ts). v2, not v3: v2 keeps the
# key-based, tlog-off flags and the `sha256-<digest>.sig/.att` tag layout the
# in-cluster registry:3 serves. Pinned per-arch SHA-256; a swapped release asset
# must fail the build, since this binary is handed the signing key.
ARG COSIGN_VERSION=v2.6.5
ARG COSIGN_SHA256_AMD64=c3b4f5410e608af03a5eb0aaac84a4313d8da131248e08ff1759ac70c79d1644
ARG COSIGN_SHA256_ARM64=426193b4c5da4d4d643e822f48fe0cc8a476ca1782a272704831f5a0cef716d7

FROM ${NODE_IMAGE} AS cosign
ARG TARGETARCH
ARG COSIGN_VERSION
ARG COSIGN_SHA256_AMD64
ARG COSIGN_SHA256_ARM64
RUN apk add --no-cache curl \
    && case "${TARGETARCH:-amd64}" in \
         amd64) sum="${COSIGN_SHA256_AMD64}" ;; \
         arm64) sum="${COSIGN_SHA256_ARM64}" ;; \
         *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    && curl -fsSLo /usr/local/bin/cosign "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-${TARGETARCH:-amd64}" \
    && echo "${sum}  /usr/local/bin/cosign" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/cosign

# Production stage
# F-0.3: node_modules is built OUTSIDE Docker by the docker:build script
# (`pnpm deploy --filter <name> --prod --legacy .docker-build`) so the
# install runs against pnpm-lock.yaml. The .docker-build/ tree carries a
# lockfile-locked, prod-only dep set; this stage just copies it in.
# Closes the caret-range drift trap that bit jest in May 2026: a Docker
# rebuild can no longer pull a newer caret-compatible version of any
# dep behind the platform's back.
FROM ${NODE_IMAGE}
# Runtime hardening: pull the latest patched OS packages (the base digest can lag
# an openssl/musl/zlib fix) and drop the npm/corepack/yarn CLIs the image never runs —
# they ship their own dependency trees (tar, pacote, sigstore, minimatch …) that the
# release grype gate would otherwise flag.
RUN apk upgrade --no-cache \
    && apk add --no-cache curl \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
       /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
COPY --from=cosign /usr/local/bin/cosign /usr/local/bin/cosign

WORKDIR /app
COPY --chown=node:node .docker-build/node_modules ./node_modules
COPY --chown=node:node .docker-build/package.json .
COPY --chown=node:node .docker-build/lib/ /app

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

USER node
CMD ["node", "--import", "@pipeline-builder/api-server/lib/otel-bootstrap.js", "index.js"]