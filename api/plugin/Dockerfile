# Base image pinned BY DIGEST (tag kept for readers): a re-pushed or
# compromised tag cannot change what a release image is built from. Bump both
# together (docker buildx imagetools inspect node:<ver>-slim).
ARG NODE_IMAGE=node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
# Go toolchain that BUILDS every tool below, pinned by digest like the runtime
# base (docker buildx imagetools inspect golang:<ver>-alpine). Upstream release
# binaries lag the Go security train badly — the prebuilt cosign v2.6.5 carried 3
# Critical / 19 High and crane v0.20.2 (Go 1.21.12) 2 Critical — so every Go
# binary this image ships is compiled here from verified source instead.
ARG GO_IMAGE=golang:1.27.1-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414
# Every tool is pinned by BOTH its upstream release tag and the commit that tag
# must resolve to: the clone is checked against <TOOL>_COMMIT and the build fails
# on a mismatch, so a retagged release cannot change what gets the plugin-signing
# key or the registry push credential. Module integrity comes from each repo's own
# go.sum — nothing here relaxes GOFLAGS/GONOSUMDB.
#
# buildctl matches the buildkitd sidecar (moby/buildkit:v0.32.1-rootless in
# deploy/*/k8s/plugin.yaml) — attestation + --metadata-file support lives in
# both halves, so the client must not lag the daemon.
ARG BUILDKIT_VERSION=v0.32.1
ARG BUILDKIT_COMMIT=f1697c4f6e9f4562156ac34403b15da63f11c2bb
ARG CRANE_VERSION=v0.22.1
ARG CRANE_COMMIT=8a72a424fdecb4caa14f2d525e5d2503331442b5
# cosign v3: it keeps the `sha256-<digest>.sig/.att` tag layout the in-cluster
# registry:3 serves, but ONLY with the pinned flags in
# api/image-registry/src/services/plugin-signing.ts and src/helpers/supply-chain.ts
# (--new-bundle-format=false --use-signing-config=false --tlog-upload=false);
# v3's defaults would switch to Sigstore bundles over the OCI referrers API.
ARG COSIGN_VERSION=v3.1.3
ARG COSIGN_COMMIT=11926fa5bbbbde47e88fc006b625a17769b743b2
ARG SYFT_VERSION=1.52.0
ARG SYFT_COMMIT=02ba369d13b4248395b20a504eca94b0cab564d8
# grype matches syft 1.52 (same release train).
ARG GRYPE_VERSION=0.119.0
ARG GRYPE_COMMIT=b6f5194537747ee7f705f4113069ac9eb269919f

# =============================================================================
# Plugin service image.
#
# Builds run against a rootless buildkitd sidecar; this image only carries the
# `buildctl` client. The single dockerd/podman/kaniko strategy switch is gone —
# every deploy target uses the same code path now.
# =============================================================================

# buildctl: connects to the rootless buildkitd sidecar to run the actual build.
# crane:    pushes prebuilt `docker save` tarballs (buildctl cannot do that).
# syft:     generates the SPDX SBOM of every pushed plugin image.
# cosign:   verifies plugin signatures and reads back the signed SBOM attestation.
# grype:    scans that SBOM for known vulnerabilities (build + nightly rescan).
#
# All five are built here from source at their pinned tag+commit. The stage runs
# on the BUILD platform and Go emits for $TARGETARCH, so the arm64 leg is a real
# cross-compile rather than a QEMU-emulated one. CGO is off, so the binaries are
# static and drop straight into the Debian runtime stage.
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS tools
ARG TARGETARCH
ARG BUILDKIT_VERSION
ARG BUILDKIT_COMMIT
ARG CRANE_VERSION
ARG CRANE_COMMIT
ARG COSIGN_VERSION
ARG COSIGN_COMMIT
ARG SYFT_VERSION
ARG SYFT_COMMIT
ARG GRYPE_VERSION
ARG GRYPE_COMMIT
ENV CGO_ENABLED=0 GOOS=linux GOTOOLCHAIN=local
RUN apk add --no-cache git
# Clone each tool at its release tag and REFUSE to build unless the tag resolved
# to the pinned commit. `--branch <tag>` keeps the tag ref in the clone, which is
# what Go's VCS stamp reads: the binaries then report their true upstream module
# version (v3.1.3, v1.52.0 …) instead of a v0.0.0-<pseudo> that grype would match
# against every advisory ever filed for the project.
WORKDIR /src
RUN set -e; \
    case "${TARGETARCH:-amd64}" in amd64|arm64) ;; *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; esac; \
    for spec in \
      "buildkit https://github.com/moby/buildkit.git ${BUILDKIT_VERSION} ${BUILDKIT_COMMIT}" \
      "crane https://github.com/google/go-containerregistry.git ${CRANE_VERSION} ${CRANE_COMMIT}" \
      "cosign https://github.com/sigstore/cosign.git ${COSIGN_VERSION} ${COSIGN_COMMIT}" \
      "syft https://github.com/anchore/syft.git v${SYFT_VERSION} ${SYFT_COMMIT}" \
      "grype https://github.com/anchore/grype.git v${GRYPE_VERSION} ${GRYPE_COMMIT}" \
    ; do \
      set -- ${spec}; \
      git clone --depth 1 --branch "$3" "$2" "$1"; \
      got="$(git -C "$1" rev-parse HEAD)"; \
      if [ "${got}" != "$4" ]; then echo "$1 $3 resolved to ${got}, expected $4" >&2; exit 1; fi; \
    done

# Where a pinned dep still carries a fixable finding, raise ONLY that dep to its
# first fixed release. The edits land in a go.mod copy outside the worktree
# (-modfile), so each checkout stays clean and keeps its real VCS version stamp;
# -mod=readonly then builds from go.mod/go.sum (buildkit and crane vendor their
# deps, and a stale vendor/ tree must not silently win over the bumped go.mod).
#   buildkit v0.32.1: grpc 1.82.1  → GHSA-2v4p-qf9q-27wj, GHSA-vp52-pcj8-j9qc (High)
#                     containerd   → GHSA-7jxh-36q5-gcqv (Medium)
#                     otel sdk     → GHSA-8wmf-6v46-5gfg (Low)
#   cosign v3.1.3:    grpc 1.82.0  → the two above + GHSA-hrxh-6v49-42gf (High)
#                     x/text 0.38  → GO-2026-5970 (High)
#   syft / grype:     otel sdk     → GHSA-8wmf-6v46-5gfg (Low)
#   crane v0.22.1 builds clean — nothing to raise.
RUN for t in buildkit crane cosign syft grype; do cp "/src/$t/go.mod" "/tmp/$t.mod" && cp "/src/$t/go.sum" "/tmp/$t.sum"; done \
    && cd /src/buildkit && go get -modfile=/tmp/buildkit.mod \
         google.golang.org/grpc@v1.83.2 github.com/containerd/containerd/v2@v2.3.5 \
         go.opentelemetry.io/otel/sdk@v1.45.0 \
         go.opentelemetry.io/otel/exporters/otlp/otlptrace@v1.45.0 \
         go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc@v1.45.0 \
         go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp@v1.45.0 \
    && cd /src/cosign && go get -modfile=/tmp/cosign.mod \
         google.golang.org/grpc@v1.83.2 golang.org/x/text@v0.41.0 \
    && cd /src/syft && go get -modfile=/tmp/syft.mod go.opentelemetry.io/otel/sdk@v1.45.0 \
    && cd /src/grype && go get -modfile=/tmp/grype.mod go.opentelemetry.io/otel/sdk@v1.45.0

# -trimpath and `-s -w` as upstream strips them, plus each tool's own version
# ldflags so `--version` still reports the real release and commit.
RUN export GOARCH="${TARGETARCH:-amd64}" \
    && cd /src/buildkit && go build -mod=readonly -modfile=/tmp/buildkit.mod -trimpath \
         -ldflags "-s -w \
           -X github.com/moby/buildkit/version.Version=${BUILDKIT_VERSION} \
           -X github.com/moby/buildkit/version.Revision=${BUILDKIT_COMMIT} \
           -X github.com/moby/buildkit/version.Package=github.com/moby/buildkit" \
         -o /usr/local/bin/buildctl ./cmd/buildctl \
    && cd /src/crane && go build -trimpath \
         -ldflags "-s -w \
           -X github.com/google/go-containerregistry/cmd/crane/cmd.Version=${CRANE_VERSION} \
           -X github.com/google/go-containerregistry/pkg/v1/remote/transport.Version=${CRANE_VERSION}" \
         -o /usr/local/bin/crane ./cmd/crane \
    && cd /src/cosign && go build -mod=readonly -modfile=/tmp/cosign.mod -trimpath \
         -ldflags "-s -w -buildid= \
           -X sigs.k8s.io/release-utils/version.gitVersion=${COSIGN_VERSION} \
           -X sigs.k8s.io/release-utils/version.gitCommit=${COSIGN_COMMIT} \
           -X sigs.k8s.io/release-utils/version.gitTreeState=clean" \
         -o /usr/local/bin/cosign ./cmd/cosign \
    && cd /src/syft && go build -mod=readonly -modfile=/tmp/syft.mod -trimpath \
         -ldflags "-s -w -X main.version=${SYFT_VERSION} -X main.gitCommit=${SYFT_COMMIT} -X main.gitDescription=v${SYFT_VERSION}" \
         -o /usr/local/bin/syft ./cmd/syft \
    && cd /src/grype && go build -mod=readonly -modfile=/tmp/grype.mod -trimpath \
         -ldflags "-s -w -X main.version=${GRYPE_VERSION} -X main.gitCommit=${GRYPE_COMMIT} -X main.gitDescription=v${GRYPE_VERSION}" \
         -o /usr/local/bin/grype ./cmd/grype

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