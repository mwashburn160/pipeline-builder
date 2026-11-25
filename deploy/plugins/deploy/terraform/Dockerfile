# Terraform Plugin — Infrastructure Provisioning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Terraform via tfenv (one baked version)
# Runs terraform init, plan, and apply for infrastructure deployment

# ─── Tool versions (override with --build-arg) ───
ARG TFLINT_VERSION=0.66.0
# tfsec USED to provide the security scan here. It is gone, not downgraded:
# v1.28.14 (May 2025) is its final release, the project's own description now
# reads "Tfsec is now part of Trivy", and that last build carries ten fixable
# Critical findings — go1.24.1 with x/crypto v0.37.0 and grpc v1.66.0 — which
# no pin can clear because there is nothing newer to pin to. Verified by
# reading the binary's Go build metadata, with tflint checked alongside and
# clean at the time (go1.26.4, x/crypto v0.53.0), so tfsec was the sole source.
#
# THAT "clean" HAS AN EXPIRY, and it has probably passed: go1.26.4 is below the
# 1.26.9 line that fixes GO-2026-6604 and GO-2026-6612, so tflint's stdlib now
# carries what were Critical findings when the service images were scanned on
# 2026-10-10. v0.66.0 (pinned above, 2026-11) is the newest tflint release, so there is
# nothing newer to pin forward to — the same dead end tfsec hit. If a rescan
# starts failing PLUGIN_VULN_GATE here, that is the cause, and the options are
# an upstream release, a waiver, or dropping tflint the way tfsec was dropped.
#
# `trivy config` is the replacement Aqua themselves point at, and it reads the
# same Terraform/HCL misconfiguration rules. Output format and check IDs differ,
# so anything parsing tfsec-results.json must be re-pointed.
ARG TRIVY_VERSION=0.76.2
#
# trivy is built from source (stage below), the same way _trivy-base builds it,
# not copied from aquasec/trivy: the published v0.76.2 binary (the newest
# release) links github.com/klauspost/compress v1.20.1 — GO-2026-6865, High,
# fixed in 1.20.2 — which no image tag can clear. The tagged source is built on
# the shared Go builder image with compress raised through a side modfile, and
# the build fails unless the raise took. Source integrity: the tag must resolve
# to TRIVY_COMMIT. Flags follow upstream's goreleaser.yml (CGO off, -s -w,
# app.ver stamped).
ARG TRIVY_COMMIT=3f6334d223b52188324af3b9923b4249cd206652
ARG TRIVY_COMPRESS_VERSION=1.20.5
# Same pinned toolchain as api/plugin's tools stage (toolchain-drift-contract).
ARG GO_IMAGE=golang:1.27.4-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280

FROM ghcr.io/terraform-linters/tflint:v${TFLINT_VERSION} AS tflint-src

FROM ${GO_IMAGE} AS trivy-build
ARG TRIVY_VERSION
ARG TRIVY_COMMIT
ARG TRIVY_COMPRESS_VERSION
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
      go get -modfile=/tmp/trivy.mod "github.com/klauspost/compress@v${TRIVY_COMPRESS_VERSION}" \
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
    _want="v${TRIVY_COMPRESS_VERSION}"; \
    _got="$(go version -m /out/trivy | awk '$1 == "dep" && $2 == "github.com/klauspost/compress" { print $3 }')"; \
    [ -n "$_got" ] || { echo "klauspost/compress is not linked into trivy" >&2; exit 1; }; \
    [ "$(printf '%s\n%s\n' "$_want" "$_got" | sort -V | head -1)" = "$_want" ] \
      || { echo "klauspost/compress is $_got, expected >= $_want" >&2; exit 1; }; \
    echo "ok: klauspost/compress $_got"

FROM plugin-aws-cli-base:1.0

# Build steps below need root (writes under /opt); the image drops back to the
# unprivileged `plugin` user (uid 1000) at the end.
USER root

# ─── tfenv for Terraform version management ───
# Pinned release tarball + pinned digest (the v${TFENV_VERSION} tag archive),
# instead of `git clone` of the default branch. TFENV_ROOT is owned by uid 1000
# so the spec's runtime `tfenv install/use ${TF_VERSION}` works as the runtime
# user.
ARG TFENV_VERSION=3.2.2
ARG TFENV_SHA256=c9c8b2e2588cf026aafa9803dfdefdfc7aa258577c24ea9624fe53f764edea47
ENV TFENV_ROOT=/opt/tfenv
RUN set -eux; \
    fetch-verified "https://github.com/tfutils/tfenv/archive/refs/tags/v${TFENV_VERSION}.tar.gz" "${TFENV_SHA256}" /tmp/tfenv.tar.gz; \
    mkdir -p "${TFENV_ROOT}"; \
    tar -xzf /tmp/tfenv.tar.gz -C "${TFENV_ROOT}" --strip-components=1; \
    rm -f /tmp/tfenv.tar.gz
ENV PATH="${TFENV_ROOT}/bin:${PATH}"

# ONE Terraform, seeded straight into tfenv's layout
# (${TFENV_ROOT}/versions/<ver>/terraform) from a pinned zip + HashiCorp's
# published SHA256SUMS digest, so the build does no unverified download.
#
# tfenv stays because the spec drives it (`tfenv use ${TF_VERSION}`) and it is
# how a pipeline asks for another version — but only this one is BAKED, so
# anything else is a runtime download the plugin may not be permitted to make.
ARG TF_VERSION=1.17.2
ARG TF_SHA256_AMD64=e6f16b2f0b137ee5729caa8c4e79a3bae4ee261acd198a1fcfa8584a6296605b
ARG TF_SHA256_ARM64=858e08c181a76b6b223e8c767a8e983922eebe2d062db949a2de66ce040c368c
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=amd64; sum="${TF_SHA256_AMD64}" ;; \
      arm64) arch=arm64; sum="${TF_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://releases.hashicorp.com/terraform/${TF_VERSION}/terraform_${TF_VERSION}_linux_${arch}.zip" "$sum" /tmp/terraform.zip; \
    mkdir -p "${TFENV_ROOT}/versions/${TF_VERSION}"; \
    unzip -q /tmp/terraform.zip terraform -d "${TFENV_ROOT}/versions/${TF_VERSION}"; \
    rm -f /tmp/terraform.zip; \
    tfenv use "${TF_VERSION}"; \
    terraform version; \
    chown -R 1000:1000 "${TFENV_ROOT}"

# ─── TFLint for Terraform linting (copied from official image) ───
COPY --from=tflint-src /usr/local/bin/tflint /usr/local/bin/tflint

# ─── trivy for Terraform misconfiguration scanning (built from source in the trivy-build stage above) ───
COPY --from=trivy-build /out/trivy /usr/local/bin/trivy

# ─── Runtime configuration defaults ───
ENV TF_VERSION=${TF_VERSION}
ENV TF_WORKING_DIR=.
ENV TF_ACTION=plan
ENV TF_VAR_FILE=""
ENV TF_BACKEND_CONFIG=""
ENV TF_AUTO_APPROVE=false

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
