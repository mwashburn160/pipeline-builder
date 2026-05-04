# Checkmarx Plugin — Enterprise SAST + KICS IaC Scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports Checkmarx One CLI and KICS for infrastructure-as-code
# Requires CX_CLIENT_SECRET at runtime

# ─── Tool versions (override with --build-arg) ───
ARG CX_CLI_VERSION=2.3.46
ARG KICS_VERSION=2.1.3

FROM checkmarx/kics:v${KICS_VERSION} AS kics-src

FROM pipeline-plugin-base:24.04

ARG CX_CLI_VERSION

RUN apt-get update && apt-get install -y --no-install-recommends \
    git zip unzip curl jq ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ─── Checkmarx One CLI ───
# Multi-arch: ast-cli releases ship both _linux_x64 and _linux_arm64 tarballs.
RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
         amd64) CX_ARCH=x64 ;; \
         arm64) CX_ARCH=arm64 ;; \
         *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/Checkmarx/ast-cli/releases/download/${CX_CLI_VERSION}/ast-cli_linux_${CX_ARCH}.tar.gz" \
       | tar -xz -C /usr/local/bin

# ─── KICS (IaC Scanner by Checkmarx — copied from official image) ───
COPY --from=kics-src /app/bin/kics /usr/local/bin/kics
COPY --from=kics-src /app/bin/assets /opt/kics/assets
ENV KICS_QUERIES_PATH=/opt/kics/assets/queries

# Non-sensitive config only
ENV CX_BASE_URI=https://ast.checkmarx.net
ENV CX_TENANT=""
ENV CX_PROJECT_NAME=""
ENV CX_SCAN_TYPE=sast
ENV CX_SEVERITY_THRESHOLD=high

WORKDIR /app
CMD ["bash"]
