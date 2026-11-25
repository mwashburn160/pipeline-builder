# Pipeline Builder — Trivy Family Base Image
#
# Built tag: plugin-trivy-base:1.0
#
# Used as the FROM by the single language-agnostic `trivy` plugin.
# `trivy fs`/`trivy config` scan lockfiles and IaC/config statically, so no
# language runtime is layered on top — the plugin's Dockerfile is just
# `FROM plugin-trivy-base:1.0` + WORKDIR/CMD.
# ONE pinned trivy. It bundled two for runtime selection until the image and the
# plugin spec drifted onto different versions and the switch failed closed.
#
# VULN SCAN (OSV, 2026-09-27): GO-2026-4919 / CVE-2026-33634 matches both pins and is a
# FALSE POSITIVE for them. It records ONE malicious release — a threat actor published a
# compromised trivy v0.69.4 on 2026-03-19 — but its affected range is `introduced: 0.69.4`
# with NO `fixed` event, so OSV's semver matcher flags every later version too. The pin
# below is a legitimate release well after it, so bumping cannot clear the match. If a
# future scan flags this: check whether the advisory has gained a `fixed` event before
# treating it as actionable.
#
# The real exposure in that threat class is a re-pushed TAG, not a version number. This
# base no longer pulls aquasec/trivy at all: trivy is compiled from the v${TRIVY_VERSION}
# tag, which must resolve to TRIVY_COMMIT or the build fails.
#
# WHY FROM SOURCE (2026-11-25). The published v0.76.2 binary (the newest release) links
# github.com/klauspost/compress v1.20.1 — GO-2026-6865, High, fixed in 1.20.2 — so every
# trivy plugin image inherited it and no version pin could clear it. Same route as k6,
# rain, dockle and gitleaks: build the tagged source on the shared Go builder image with
# the module raised through a side modfile, then assert the raise took. Flags follow
# upstream's goreleaser.yml (CGO off, -s -w, app.ver stamped). GO_IMAGE is held equal to
# api/plugin's and the other source-built plugins' (toolchain-drift-contract).
ARG TRIVY_VERSION=0.76.2
ARG TRIVY_COMMIT=3f6334d223b52188324af3b9923b4249cd206652
ARG GO_IMAGE=golang:1.27.4-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280

FROM ${GO_IMAGE} AS trivy-build
ARG TRIVY_VERSION
ARG TRIVY_COMMIT
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
RUN apk add --no-cache git
# Clone retried (github.com flaps); the commit check is outside the retry — a
# tag that resolves to the wrong commit is not transient.
RUN set -eux; \
    for attempt in 1 2 3 4 5; do \
      rm -rf /src/trivy; \
      if git clone --depth 1 --branch "v${TRIVY_VERSION}" https://github.com/aquasecurity/trivy.git /src/trivy; then break; fi; \
      echo "trivy clone failed (attempt $attempt/5); retrying" >&2; \
      sleep $((attempt * 5)); \
    done; \
    test -d /src/trivy/.git; \
    got="$(git -C /src/trivy rev-parse HEAD)"; \
    [ "$got" = "${TRIVY_COMMIT}" ] || { echo "trivy v${TRIVY_VERSION} resolved to $got, expected ${TRIVY_COMMIT}" >&2; exit 1; }
WORKDIR /src/trivy
RUN set -eux; \
    cp go.mod /tmp/trivy.mod; cp go.sum /tmp/trivy.sum; \
    for attempt in 1 2 3 4 5; do \
      go get -modfile=/tmp/trivy.mod github.com/klauspost/compress@v1.20.5 \
        && go mod download -modfile=/tmp/trivy.mod all && break; \
      echo "go get/mod download failed (attempt $attempt/5)" >&2; sleep $((attempt * 5)); \
    done; \
    go build -mod=readonly -modfile=/tmp/trivy.mod -trimpath \
      -ldflags "-s -w -X github.com/aquasecurity/trivy/pkg/version/app.ver=${TRIVY_VERSION}" \
      -o /out/trivy ./cmd/trivy; \
    /out/trivy --version
# Fail the BUILD if the raise did not take (asserted as >= the pin: MVS may
# resolve higher than asked).
RUN set -eux; \
    _want=v1.20.5; \
    _got="$(go version -m /out/trivy | awk '$1 == "dep" && $2 == "github.com/klauspost/compress" { print $3 }')"; \
    [ -n "$_got" ] || { echo "klauspost/compress is not linked into trivy" >&2; exit 1; }; \
    [ "$(printf '%s\n%s\n' "$_want" "$_got" | sort -V | head -1)" = "$_want" ] \
      || { echo "klauspost/compress is $_got, expected >= $_want" >&2; exit 1; }; \
    echo "ok: klauspost/compress $_got"

FROM plugin-base:26.10
ARG TRIVY_VERSION

# ONE trivy, installed straight onto PATH. This used to bake two versions into
# /opt/trivy/versions with a symlink the plugin re-pointed at runtime, which is
# what let the image and the plugin spec drift apart: the spec asked for a
# version the image no longer carried, and the switch failed CLOSED with
# "not in this image" — a broken plugin that only showed up at run time.
USER root
COPY --from=trivy-build /out/trivy /usr/local/bin/trivy
RUN chmod 0755 /usr/local/bin/trivy && trivy --version

ENV TRIVY_VERSION=${TRIVY_VERSION}
ENV TRIVY_SEVERITY=HIGH,CRITICAL
ENV TRIVY_FORMAT=json

WORKDIR /app
USER 1000:1000
CMD ["bash"]
