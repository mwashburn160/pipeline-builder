# Terraform Plugin — Infrastructure Provisioning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Multi-version support via tfenv
# Runs terraform init, plan, and apply for infrastructure deployment

# ─── Tool versions (override with --build-arg) ───
ARG TFLINT_VERSION=0.64.0
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
# 2026-10-10. v0.64.0 is still the newest tflint release, so there is nothing
# to pin forward to — the same dead end tfsec hit. If a rescan starts failing
# PLUGIN_VULN_GATE here, that is the cause, and the options are an upstream
# release, a waiver, or dropping tflint the way tfsec was dropped.
#
# `trivy config` is the replacement Aqua themselves point at, and it reads the
# same Terraform/HCL misconfiguration rules. Output format and check IDs differ,
# so anything parsing tfsec-results.json must be re-pointed.
ARG TRIVY_VERSION=0.75.0

FROM ghcr.io/terraform-linters/tflint:v${TFLINT_VERSION} AS tflint-src
FROM aquasec/trivy:${TRIVY_VERSION} AS trivy-src

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

# Pre-install common Terraform versions. Seeded straight into tfenv's layout
# (${TFENV_ROOT}/versions/<ver>/terraform) from pinned zips + HashiCorp's
# published SHA256SUMS digests, so the build does no unverified download;
# `tfenv use` then just selects the baked default.
ARG TF_DEFAULT_VERSION=1.16.4
ARG TF_DEFAULT_SHA256_AMD64=dc94af0eef1147718ad7c8daea792ed199e3e0492eec180d0adafa2a65a879df
ARG TF_DEFAULT_SHA256_ARM64=8263f301cb1a24489a4adeed147bf28504053f77237b3ea97a0ef2972659de30
ARG TF_PREV_VERSION=1.15.9
ARG TF_PREV_SHA256_AMD64=76edd0b22d2f27d3d2e097cd793209646f719cf60f02ff3af626b07361137da1
ARG TF_PREV_SHA256_ARM64=0afa6c29f61ca5ea270e950e43e50ecf2418b598507bf580e8ae76e1e6699b19
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=amd64; sum_default="${TF_DEFAULT_SHA256_AMD64}"; sum_prev="${TF_PREV_SHA256_AMD64}" ;; \
      arm64) arch=arm64; sum_default="${TF_DEFAULT_SHA256_ARM64}"; sum_prev="${TF_PREV_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    for pair in "${TF_PREV_VERSION}:${sum_prev}" "${TF_DEFAULT_VERSION}:${sum_default}"; do \
      v="${pair%%:*}"; sum="${pair#*:}"; \
      fetch-verified "https://releases.hashicorp.com/terraform/${v}/terraform_${v}_linux_${arch}.zip" "$sum" /tmp/terraform.zip; \
      mkdir -p "${TFENV_ROOT}/versions/${v}"; \
      unzip -q /tmp/terraform.zip terraform -d "${TFENV_ROOT}/versions/${v}"; \
      rm -f /tmp/terraform.zip; \
    done; \
    tfenv use "${TF_DEFAULT_VERSION}"; \
    terraform version; \
    chown -R 1000:1000 "${TFENV_ROOT}"

# ─── TFLint for Terraform linting (copied from official image) ───
COPY --from=tflint-src /usr/local/bin/tflint /usr/local/bin/tflint

# ─── trivy for Terraform misconfiguration scanning (copied from official image) ───
COPY --from=trivy-src /usr/local/bin/trivy /usr/local/bin/trivy

# ─── Runtime configuration defaults ───
ENV TF_VERSION=${TF_DEFAULT_VERSION}
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
