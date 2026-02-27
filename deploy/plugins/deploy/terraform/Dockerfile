# Terraform Plugin — Infrastructure Provisioning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Multi-version support via tfenv
# Runs terraform init, plan, and apply for infrastructure deployment

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    wget \
    jq \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# ─── AWS CLI ───
RUN curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscli.zip \
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

# ─── TFLint for Terraform linting ───
RUN curl -fsSL https://github.com/terraform-linters/tflint/releases/download/v0.54.0/tflint_linux_amd64.zip \
    -o /tmp/tflint.zip && unzip -q /tmp/tflint.zip -d /usr/local/bin && rm /tmp/tflint.zip

# ─── tfsec for Terraform security scanning ───
RUN curl -fsSL https://github.com/aquasecurity/tfsec/releases/download/v1.28.11/tfsec-linux-amd64 \
    -o /usr/local/bin/tfsec && chmod +x /usr/local/bin/tfsec

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
