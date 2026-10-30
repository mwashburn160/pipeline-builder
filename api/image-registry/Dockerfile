# Base image pinned BY DIGEST (tag kept for readers): a re-pushed or
# compromised tag cannot change what a release image is built from. Bump both
# together (docker buildx imagetools inspect node:<ver>-alpine).
ARG NODE_IMAGE=node:26.13.0-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94
# Go toolchain that BUILDS cosign, pinned by digest like every other base
# (docker buildx imagetools inspect golang:<ver>-alpine). Upstream's own release
# binaries lag the Go security train — cosign v2.6.5's published binary carried 3
# Critical / 19 High from Go 1.26.4 alone — so we compile from source with a
# current toolchain instead of downloading a prebuilt asset.
ARG GO_IMAGE=golang:1.27.3-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb
# cosign signs plugin images with the plugin-signing key (this service is its
# only holder — see src/services/plugin-signing.ts). Built from the upstream tag,
# with the resolved commit pinned: the clone must land on COSIGN_COMMIT or the
# build fails, so a retagged v3.1.4 cannot change what gets the signing key.
# Module integrity comes from the repo's own go.sum (nothing here relaxes
# GONOSUMDB/GOFLAGS).
ARG COSIGN_VERSION=v3.1.4
ARG COSIGN_COMMIT=0e48502cf5ef34e2e60bbd3617aa19945712f705

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
# Raise only what still carries a FIXABLE finding at this tag. Re-derived for
# cosign v3.1.4 from its go.mod plus OSV, not inherited:
#   - grpc and x/text are GONE from the list. v3.1.4 ships grpc 1.84.0 and
#     x/text 0.43.0, both clean, where v3.1.3 shipped grpc 1.82.0 / x/text
#     0.38.0 and the Highs GHSA-2v4p-qf9q-27wj, GHSA-vp52-pcj8-j9qc,
#     GHSA-hrxh-6v49-42gf and GO-2026-5970. `go get pkg@vX` pins that EXACT
#     version, so keeping grpc@v1.83.2 here would now DOWNGRADE a clean 1.84.0.
#   - x/net rises to 0.62.0, not 0.60.0. v3.1.4 ships 0.61.0, and 0.60.0 and
#     0.61.0 both carry GO-2026-6860 and GO-2026-6866; 0.62.0 is the first
#     release that fixes them, so the previous raise never reached the fix.
#   - klauspost/compress is GONE too: v3.1.4 ships v1.20.1, so pinning v1.18.7
#     would downgrade a clean version.
#   - x/crypto, x/text and x/mod stay, as COMPANIONS not remediations:
#     x/net@v0.62.0 requires crypto v0.58.0 and text v0.43.0, and text v0.43.0
#     requires mod v0.41.0. Raising x/net alone leaves the graph incomplete and
#     `go build -mod=readonly` fails with "updates to go.mod needed". Dropping
#     them was tried and broke the build. x/crypto's own GO-2026-5932 (openpgp
#     unmaintained) has no fixed version anywhere, so it is carried.
# The bumps go into a go.mod COPY outside the worktree (-modfile), so the
# checkout stays clean and Go's VCS stamp still reports the real `v3.1.4` — a
# dirty tree would stamp a v3.0.0-<pseudo> that grype then matches against
# v3.0.x advisories.
RUN cp go.mod /tmp/cosign.mod && cp go.sum /tmp/cosign.sum \
    && go get -modfile=/tmp/cosign.mod \
         golang.org/x/net@v0.62.0 golang.org/x/crypto@v0.58.0 \
         golang.org/x/mod@v0.41.0 golang.org/x/text@v0.43.0
# Warm the module cache, WITH RETRIES, before building — same reason as
# api/plugin/Dockerfile, which builds the same family of Go tools.
#
# proxy.golang.org intermittently aborts a module download mid-stream
# ("stream error: ...; INTERNAL_ERROR; received from peer"), failing the layer
# although every pin above is correct. GOPROXY's `,direct` fallback does not
# cover it: Go advances to the next entry only on 404/410, never on a transport
# error. Retrying the download is the only thing that helps, and doing it here
# leaves the build step below needing no network at all.
RUN set -eux; \
    ok=0; \
    for attempt in 1 2 3 4 5; do \
      if go mod download -modfile=/tmp/cosign.mod all; then ok=1; break; fi; \
      echo "go mod download cosign failed (attempt $attempt/5); retrying" >&2; \
      sleep $((attempt * 5)); \
    done; \
    [ "$ok" = 1 ] || { echo "go mod download cosign failed after 5 attempts" >&2; exit 1; }

# -trimpath + `-s -w` as upstream ships it, plus upstream's own version ldflags
# so `cosign version` still reports v3.1.4 and the commit it was built from.
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