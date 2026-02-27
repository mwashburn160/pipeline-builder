# Checkmarx Plugin — Enterprise SAST + KICS IaC Scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports Checkmarx One CLI and KICS for infrastructure-as-code
# Requires CX_CLIENT_SECRET at runtime

FROM public.ecr.aws/docker/library/ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    git zip unzip curl wget jq ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ─── Checkmarx One CLI ───
RUN curl -fsSL https://github.com/Checkmarx/ast-cli/releases/download/2.4.3/ast-cli_linux_x64.tar.gz \
    | tar -xz -C /usr/local/bin

# ─── KICS (IaC Scanner by Checkmarx) ───
RUN curl -fsSL https://github.com/Checkmarx/kics/releases/download/v2.1.3/kics_2.1.3_linux_x64.tar.gz \
    | tar -xz -C /usr/local/bin

# Non-sensitive config only
ENV CX_BASE_URI=https://ast.checkmarx.net
ENV CX_TENANT=""
ENV CX_PROJECT_NAME=""
ENV CX_SCAN_TYPE=sast
ENV CX_SEVERITY_THRESHOLD=high

WORKDIR /app
CMD ["bash"]
