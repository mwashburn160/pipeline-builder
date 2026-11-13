# k6 Plugin — Performance and Load Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs k6 load tests with configurable VUs, duration, and thresholds
# Multi-version support

# ─── Tool versions (override with --build-arg) ───
ARG K6_VERSION=2.4.0
# The commit the v${K6_VERSION} tag must resolve to (checked after clone).
ARG K6_COMMIT=dd9395906d48437a8d7ab53e309afa47ad8d67e0
# Same pinned toolchain as api/plugin's tools stage.
ARG GO_IMAGE=golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf

# ─── k6, built from source ───
# The v${K6_VERSION} release (latest 2.x) carries Critical, fixable findings the
# release gate refuses: github.com/andybalholm/brotli v1.2.3 (GO-2026-6888, on
# CISA KEV; fixed in 1.2.7), golang.org/x/net v0.58.0 (GO-2026-6612; fixed in
# 0.60.0) and a go1.27.1 stdlib. Build the same tagged source with a current
# toolchain and the two modules raised through a side modfile, as api/plugin
# does for syft and grype (brotli v1.3.0 and x/net v0.62.0; api/plugin is still on
# brotli v1.2.8, which also clears GO-2026-6888).
# Build flags follow upstream's own Dockerfile. Source integrity: the tag must
# resolve to the pinned commit, or the build fails.
FROM ${GO_IMAGE} AS k6-build
ARG K6_VERSION
ARG K6_COMMIT
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
RUN apk add --no-cache git
# RETRIED like the other source-built plugins: the clone goes through
# github.com, which fails intermittently, and a cold catalogue load does this a
# hundred times over. The COMMIT check is outside the retry — a tag that
# resolves to the wrong commit is not a transient failure and must not be
# retried into success.
RUN set -eux; \
    for attempt in 1 2 3 4 5; do \
      rm -rf /src/k6; \
      if git clone --depth 1 --branch "v${K6_VERSION}" https://github.com/grafana/k6.git /src/k6; then break; fi; \
      echo "k6 clone failed (attempt $attempt/5); retrying" >&2; \
      sleep $((attempt * 5)); \
    done; \
    test -d /src/k6/.git; \
    got="$(git -C /src/k6 rev-parse HEAD)"; \
    [ "$got" = "${K6_COMMIT}" ] || { echo "k6 v${K6_VERSION} resolved to $got, expected ${K6_COMMIT}" >&2; exit 1; }
WORKDIR /src/k6
RUN set -eux; \
    cp go.mod /tmp/k6.mod; cp go.sum /tmp/k6.sum; \
    for attempt in 1 2 3 4 5; do \
      go get -modfile=/tmp/k6.mod golang.org/x/net@v0.62.0 github.com/andybalholm/brotli@v1.3.0 \
        && go mod download -modfile=/tmp/k6.mod all && break; \
      echo "go get/mod download failed (attempt $attempt/5)" >&2; sleep $((attempt * 5)); \
    done; \
    go build -mod=readonly -modfile=/tmp/k6.mod -trimpath \
      -ldflags "-s -w -X go.k6.io/k6/v2/internal/build.BuildOrigin=release" \
      -o /out/k6 .; \
    /out/k6 version; \
    go version -m /out/k6
# Fail the BUILD if a raise did not take. Printing `go version -m` above leaves
# that to whoever reads the log, and the whole point of the side modfile is the
# module versions baked into the binary — `go get` can be overridden by a
# transitive requirement.
#
# Asserted as ">= the pin", NOT as equality: MVS is allowed to resolve HIGHER
# than asked, so an equality check fails a build whose patch actually succeeded.
# (That is a live suspicion for the git-secrets build failure, whose assertion is
# `$`-anchored to one exact version.) `sort -V` orders the pair; the wanted
# version sorting first means baked >= wanted.
RUN set -eux; \
    baked() { go version -m /out/k6 | awk -v m="$1" '$1 == "dep" && $2 == m { print $3 }'; }; \
    atleast() { \
      _m="$1"; _want="v$2"; _got="$(baked "$_m")"; \
      if [ -z "$_got" ]; then echo "$_m is not linked into the binary" >&2; return 1; fi; \
      if [ "$(printf '%s\n%s\n' "$_want" "$_got" | sort -V | head -1)" != "$_want" ]; then \
        echo "$_m is $_got, expected >= $_want" >&2; return 1; \
      fi; \
      echo "ok: $_m $_got (>= $_want)"; \
    }; \
    atleast github.com/andybalholm/brotli 1.3.0; \
    atleast golang.org/x/net 0.62.0

FROM plugin-base:26.10

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

ARG K6_VERSION

# ─── k6 (built from source above) ───
COPY --from=k6-build /out/k6 /usr/local/bin/k6
RUN chmod 0755 /usr/local/bin/k6

# ─── Runtime configuration defaults ───
ENV K6_VERSION=${K6_VERSION}
ENV K6_SCRIPT=""
ENV K6_VUS=10
ENV K6_DURATION=30s
ENV K6_THRESHOLDS=""

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
