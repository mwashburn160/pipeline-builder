# tfsec Plugin — IaC Security Scanner
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Scans Terraform, CloudFormation, and Kubernetes manifests for misconfigurations

FROM aquasec/tfsec:latest AS tfsec-bin

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
    && rm -rf /var/lib/apt/lists/*

# ─── tfsec binary ───
COPY --from=tfsec-bin /usr/bin/tfsec /usr/local/bin/tfsec

# ─── Runtime configuration defaults ───
ENV TFSEC_FORMAT=json
ENV TFSEC_SEVERITY="HIGH,CRITICAL"
ENV TFSEC_WORKING_DIR=.

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
