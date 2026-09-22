# Base image pinned BY DIGEST (tag kept for readers): a re-pushed or
# compromised tag cannot change what a release image is built from. Bump both
# together (docker buildx imagetools inspect node:<ver>-alpine).
ARG NODE_IMAGE=node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
# Go toolchain that BUILDS cosign, pinned by digest like every other base
# (docker buildx imagetools inspect golang:<ver>-alpine). Upstream's own release
# binaries lag the Go security train — cosign v2.6.5's published binary carried 3
# Critical / 19 High from Go 1.26.4 alone — so we compile from source with a
# current toolchain instead of downloading a prebuilt asset.
ARG GO_IMAGE=golang:1.27.1-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414
# cosign signs plugin images with the plugin-signing key (this service is its
# only holder — see src/services/plugin-signing.ts). Built from the upstream tag,
# with the resolved commit pinned: the clone must land on COSIGN_COMMIT or the
# build fails, so a retagged v3.1.3 cannot change what gets the signing key.
# Module integrity comes from the repo's own go.sum (nothing here relaxes
# GONOSUMDB/GOFLAGS).
ARG COSIGN_VERSION=v3.1.3
ARG COSIGN_COMMIT=11926fa5bbbbde47e88fc006b625a17769b743b2

# Cross-compiles: the stage always runs on the BUILD platform and Go emits for
# $TARGETARCH, so the arm64 leg is never QEMU-emulated.
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS cosign
ARG TARGETARCH
ARG COSIGN_VERSION
ARG COSIGN_COMMIT
ENV CGO_ENABLED=0 GOOS=linux GOTOOLCHAIN=local
RUN apk add --no-cache git
WORKDIR /src
RUN case "${TARGETARCH:-amd64}" in amd64|arm64) ;; *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; esac \
    && git clone --depth 1 --branch "${COSIGN_VERSION}" https://github.com/sigstore/cosign.git . \
    && got="$(git rev-parse HEAD)" \
    && if [ "${got}" != "${COSIGN_COMMIT}" ]; then \
         echo "cosign ${COSIGN_VERSION} resolved to ${got}, expected ${COSIGN_COMMIT}" >&2; exit 1; \
       fi
# cosign v3.1.3 still pins grpc 1.82.0 / x/text 0.38.0, which carry fixable Highs
# (GHSA-2v4p-qf9q-27wj, GHSA-vp52-pcj8-j9qc, GHSA-hrxh-6v49-42gf, GO-2026-5970).
# Raise just those to their first fixed release. The bumps go into a go.mod
# COPY outside the worktree (-modfile), so the checkout stays clean and Go's VCS
# stamp still reports the real `v3.1.3` — a dirty tree would stamp a
# v3.0.0-<pseudo> that grype then matches against v3.0.x advisories.
RUN cp go.mod /tmp/cosign.mod && cp go.sum /tmp/cosign.sum \
    && go get -modfile=/tmp/cosign.mod google.golang.org/grpc@v1.83.2 golang.org/x/text@v0.41.0
# -trimpath + `-s -w` as upstream ships it, plus upstream's own version ldflags
# so `cosign version` still reports v3.1.3 and the commit it was built from.
RUN GOARCH="${TARGETARCH:-amd64}" go build -mod=readonly -modfile=/tmp/cosign.mod -trimpath \
      -ldflags "-s -w -buildid= \
        -X sigs.k8s.io/release-utils/version.gitVersion=${COSIGN_VERSION} \
        -X sigs.k8s.io/release-utils/version.gitCommit=${COSIGN_COMMIT} \
        -X sigs.k8s.io/release-utils/version.gitTreeState=clean" \
      -o /usr/local/bin/cosign ./cmd/cosign

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