# Terraform Plugin — Infrastructure Provisioning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Multi-version support via tfenv
# Runs terraform init, plan, and apply for infrastructure deployment

# ─── Tool versions (override with --build-arg) ───
ARG TFLINT_VERSION=0.64.0
ARG TFSEC_VERSION=1.28.14

FROM ghcr.io/terraform-linters/tflint:v${TFLINT_VERSION} AS tflint-src
FROM aquasec/tfsec:v${TFSEC_VERSION} AS tfsec-src

FROM pipeline-aws-cli-base:1.0

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
ARG TF_DEFAULT_VERSION=1.16.3
ARG TF_DEFAULT_SHA256_AMD64=093b6ae9a2228af5029c41606bc96eb583553528aad1bfe7e0b4d62fc91e25d8
ARG TF_DEFAULT_SHA256_ARM64=b6b293550af7a6a7ffd867a04900ce161db86ec9407b234a636c2adbae2ca9f0
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

# ─── tfsec for Terraform security scanning (copied from official image) ───
COPY --from=tfsec-src /usr/bin/tfsec /usr/local/bin/tfsec

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
