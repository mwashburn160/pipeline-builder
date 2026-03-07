# Terraform Plugin — Infrastructure Provisioning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Multi-version support via tfenv
# Runs terraform init, plan, and apply for infrastructure deployment

# ─── Tool versions (override with --build-arg) ───
ARG TFLINT_VERSION=0.54.0
ARG TFSEC_VERSION=1.28.11

FROM ghcr.io/terraform-linters/tflint:v${TFLINT_VERSION} AS tflint-src
FROM aquasec/tfsec:v${TFSEC_VERSION} AS tfsec-src

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    jq \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# ─── AWS CLI ───
RUN ARCH=$(uname -m) && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscli.zip

# ─── tfenv for Terraform version management ───
ENV TFENV_ROOT=/opt/tfenv
RUN git clone --depth 1 https://github.com/tfutils/tfenv.git ${TFENV_ROOT}
ENV PATH="${TFENV_ROOT}/bin:${PATH}"

# Pre-install common Terraform versions
RUN tfenv install 1.9.8 && \
    tfenv install 1.10.3 && \
    tfenv use 1.10.3

# ─── TFLint for Terraform linting (copied from official image) ───
COPY --from=tflint-src /usr/local/bin/tflint /usr/local/bin/tflint

# ─── tfsec for Terraform security scanning (copied from official image) ───
COPY --from=tfsec-src /usr/bin/tfsec /usr/local/bin/tfsec

# ─── Runtime configuration defaults ───
ENV TF_VERSION=1.10.3
ENV TF_WORKING_DIR=.
ENV TF_ACTION=plan
ENV TF_VAR_FILE=""
ENV TF_BACKEND_CONFIG=""
ENV TF_AUTO_APPROVE=false

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
