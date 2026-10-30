# Base image pinned BY DIGEST (tag kept for readers): a re-pushed or
# compromised tag cannot change what a release image is built from. Bump both
# together (docker buildx imagetools inspect node:<ver>-slim).
ARG NODE_IMAGE=node:26.13.0-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39
# Go toolchain that BUILDS every tool below, pinned by digest like the runtime
# base (docker buildx imagetools inspect golang:<ver>-alpine). Upstream release
# binaries lag the Go security train badly — the prebuilt cosign v2.6.5 carried 3
# Critical / 19 High and crane v0.20.2 (Go 1.21.12) 2 Critical — so every Go
# binary this image ships is compiled here from verified source instead.
ARG GO_IMAGE=golang:1.27.3-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb
# Every tool is pinned by BOTH its upstream release tag and the commit that tag
# must resolve to: the clone is checked against <TOOL>_COMMIT and the build fails
# on a mismatch, so a retagged release cannot change what gets the plugin-signing
# key or the registry push credential. Module integrity comes from each repo's own
# go.sum — nothing here relaxes GOFLAGS/GONOSUMDB.
#
# buildctl matches the buildkitd sidecar (moby/buildkit:v0.34.1-rootless in
# deploy/*/k8s/plugin.yaml) — attestation + --metadata-file support lives in
# both halves, so the client must not lag the daemon.
ARG BUILDKIT_VERSION=v0.34.1
ARG BUILDKIT_COMMIT=f5b59a1f2fb25a0cb7072c398cab9aed7835da4e
ARG CRANE_VERSION=v0.22.1
ARG CRANE_COMMIT=8a72a424fdecb4caa14f2d525e5d2503331442b5
# cosign v3: it keeps the `sha256-<digest>.sig/.att` tag layout the in-cluster
# registry:3 serves, but ONLY with the pinned flags in
# api/image-registry/src/services/plugin-signing.ts and src/helpers/supply-chain.ts
# (--new-bundle-format=false --use-signing-config=false --tlog-upload=false);
# v3's defaults would switch to Sigstore bundles over the OCI referrers API.
ARG COSIGN_VERSION=v3.1.4
ARG COSIGN_COMMIT=0e48502cf5ef34e2e60bbd3617aa19945712f705
ARG SYFT_VERSION=1.55.0
ARG SYFT_COMMIT=f15c3343e29dfb20cf6d82c820e7090b49808c96
# grype matches syft 1.55 (same release train).
ARG GRYPE_VERSION=0.121.0
ARG GRYPE_COMMIT=afe2742527d98d822da06c9f32eed86fe3d193e0

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
# version (v3.1.4, v1.55.0 …) instead of a v0.0.0-<pseudo> that grype would match
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
#   RE-DERIVED against the current tags (buildkit v0.34.1, cosign v3.1.4, syft
#   1.55.0, grype 0.121.0) from each repo's go.mod plus OSV. The bump made
#   almost the whole previous list obsolete, and left the rest ACTIVELY HARMFUL
#   — `go get pkg@vX` sets that EXACT version, so a pin the tools have since
#   passed is a DOWNGRADE (trap 1, in the direction the old note did not
#   anticipate). Measured, with what each tool ships now:
#
#     grpc        1.84.0  clean  (was pinned 1.83.2)  -> pin REMOVED
#     x/text      0.42/0.43 clean (was pinned 0.42.0) -> kept only as a
#                 COMPANION, see below
#     otel/sdk    1.46.0  clean  (was pinned 1.45.0)  -> pin REMOVED
#     compress    1.20.1  clean  (was pinned 1.18.7)  -> pin REMOVED
#     containerd  2.4.1   clean  (was pinned 2.3.5, which carries
#                 GHSA-pg57-6jwg-q645 and GO-2026-6597) -> pin REMOVED. This
#                 one was not merely redundant: it REINTRODUCED two advisories
#                 that buildkit v0.34.1 had already moved past.
#
#   WHAT REMAINS IS ONE RAISE: x/net. All four tools ship 0.59.0 or 0.61.0, and
#   both carry GO-2026-6860 and GO-2026-6866, fixed in 0.62.0. The previous pin
#   was 0.60.0 — the raise existed but never reached the fix.
#
#   x/crypto, x/text and x/mod ride along on buildkit and cosign as COMPANIONS,
#   not remediations: x/net@v0.62.0 requires crypto v0.58.0 and text v0.43.0,
#   and text v0.43.0 requires mod v0.41.0. syft and grype take x/net ALONE
#   because their graphs already resolve those. x/crypto's own GO-2026-5932
#   (x/crypto/openpgp is unmaintained) has NO fixed version in OSV at any
#   release, so it is carried, not fixable.
#
#   DOWNGRADES BREAK THE BUILD, NOT JUST THE SCAN. Leaving the containerd and
#   otel pins in place while the tools wanted 2.4.1 and 1.46.0 failed at
#   `go build` with
#     go: updates to go.mod needed, disabled by -mod=readonly
#   which names go.mod but is really the module graph: `go get` cannot express
#   a consistent graph when a pin drags a module below what other requirements
#   need. Verified by reproducing it in a throwaway golang container, where the
#   same build succeeds once the downgrades are gone.
#
#   2026-10-10, x/net GO-2026-6612 (Critical). Two traps here, both of which
#   cost a failed build, so READ THIS BEFORE EDITING THE LIST.
#
#   1. RAISE ONLY WHAT IS BELOW THE FLOOR, PER TOOL. `go get pkg@vX` sets that
#      EXACT version and DOWNGRADES anything that wanted newer. Pinning
#      klauspost/compress@v1.18.7 on syft and grype — whose graphs already had
#      v1.20.0 — dragged syft itself from v1.52.0 down to v1.46.0, and grype
#      then failed to compile against the older syft API:
#        grype/pkg/package.go:416: value.Symbols undefined
#        (syft/pkg.GolangBinaryBuildinfoEntry has no field or method Symbols)
#      The scan reports the version IN ONE BINARY; it is not the version this
#      tool's module graph resolves. Check with
#        go list -m -modfile=/tmp/<tool>.mod <dep>
#      before adding a pin, and leave out anything already at or above the fix.
#      Measured here: buildkit compress 1.19.1, syft/grype compress 1.20.0 and
#      mod 0.41.0 — all already fixed, so none of them is pinned.
#
#   2. THE RAISES MUST BE MUTUALLY CONSISTENT. x/net@v0.60.0 requires
#      crypto@v0.57.0 and text@v0.42.0, and text@v0.42.0 requires mod@v0.41.0,
#      so pinning each at its own minimum fixed release makes `go get` refuse:
#        go: golang.org/x/net@v0.60.0 requires golang.org/x/crypto@v0.57.0,
#            not golang.org/x/crypto@v0.56.0
#      Where a tool needs only x/net (syft, grype), pinning x/net ALONE is
#      enough — MVS lifts crypto and text with it, which is why those two lines
#      are short. Verified by building each tool against these exact pins.
#
#   The two `stdlib go1.27.1` criticals (GO-2026-6612, GO-2026-6604) are not in
#   this list at all — those come from the toolchain, fixed by GO_IMAGE 1.27.3.
RUN for t in buildkit crane cosign syft grype; do cp "/src/$t/go.mod" "/tmp/$t.mod" && cp "/src/$t/go.sum" "/tmp/$t.sum"; done \
    && cd /src/buildkit && go get -modfile=/tmp/buildkit.mod \
         golang.org/x/net@v0.62.0 golang.org/x/crypto@v0.58.0 \
         golang.org/x/mod@v0.41.0 golang.org/x/text@v0.43.0 \
    && cd /src/cosign && go get -modfile=/tmp/cosign.mod \
         golang.org/x/net@v0.62.0 golang.org/x/crypto@v0.58.0 \
         golang.org/x/mod@v0.41.0 golang.org/x/text@v0.43.0 \
    && cd /src/syft && go get -modfile=/tmp/syft.mod golang.org/x/net@v0.62.0 \
    && cd /src/grype && go get -modfile=/tmp/grype.mod golang.org/x/net@v0.62.0

# Warm the module cache, WITH RETRIES, before building.
#
# proxy.golang.org intermittently aborts a module download mid-stream:
#   .../tea-utils@v1.4.5.zip": stream error: stream ID 309; INTERNAL_ERROR;
#   received from peer
# That kills the whole build layer even though every pin above is correct, and
# it is not reproducible — it is the proxy, not this Dockerfile.
#
# GOPROXY's `,direct` fallback does NOT cover it: Go advances to the next entry
# only on 404/410, not on a transport error, so a stream abort is terminal.
# Retrying the download is the only thing that helps.
#
# Doing it here rather than wrapping the build below means the build step needs
# no network at all, so a flake can only ever happen in this one place — and a
# retry costs seconds, because anything already fetched is cached.
RUN set -eux; \
    for t in buildkit crane cosign syft grype; do \
      mod=""; \
      [ -f "/tmp/$t.mod" ] && mod="-modfile=/tmp/$t.mod"; \
      ok=0; \
      for attempt in 1 2 3 4 5; do \
        if (cd "/src/$t" && go mod download $mod all); then ok=1; break; fi; \
        echo "go mod download $t failed (attempt $attempt/5); retrying" >&2; \
        sleep $((attempt * 5)); \
      done; \
      [ "$ok" = 1 ] || { echo "go mod download $t failed after 5 attempts" >&2; exit 1; }; \
    done

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