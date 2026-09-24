# Checkmarx Plugin — Enterprise SAST + KICS IaC Scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports Checkmarx One CLI and KICS for infrastructure-as-code
# Requires CX_CLIENT_SECRET at runtime

# ─── Tool versions (override with --build-arg) ───
ARG CX_CLI_VERSION=2.3.66
ARG KICS_VERSION=2.1.20

FROM checkmarx/kics:v${KICS_VERSION} AS kics-src

FROM pipeline-plugin-base:24.04

ARG CX_CLI_VERSION

# Writes under /usr/local need root; dropped to uid 1000 at the end.
USER root

# ─── Checkmarx One CLI ───
# Multi-arch: ast-cli releases ship both _linux_x64 and _linux_arm64 tarballs.
# Digests from the release's ast-cli_${CX_CLI_VERSION}_checksums.txt.
ARG CX_CLI_SHA256_AMD64=76e0d6c01e6b9c5aa46f7fe7ed4262db93a239cd7e2ebf437fd930842fe0de30
ARG CX_CLI_SHA256_ARM64=3ab1137713d6542cb30272c4d708c6367802478a269521b2988fbf1b3ab073b3
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) CX_ARCH=x64;   sum="${CX_CLI_SHA256_AMD64}" ;; \
      arm64) CX_ARCH=arm64; sum="${CX_CLI_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://github.com/Checkmarx/ast-cli/releases/download/${CX_CLI_VERSION}/ast-cli_${CX_CLI_VERSION}_linux_${CX_ARCH}.tar.gz" \
       "$sum" /tmp/ast-cli.tar.gz; \
    tar -xzf /tmp/ast-cli.tar.gz -C /usr/local/bin cx; \
    rm -f /tmp/ast-cli.tar.gz; \
    cx version

# ─── KICS (IaC Scanner by Checkmarx — copied from official image) ───
COPY --from=kics-src /app/bin/kics /usr/local/bin/kics
COPY --from=kics-src /app/bin/assets /opt/kics/assets
ENV KICS_QUERIES_PATH=/opt/kics/assets/queries

# Non-sensitive config only
ENV CX_BASE_URI=https://ast.checkmarx.net
ENV CX_TENANT=""
ENV CX_PROJECT_NAME=""
ENV CX_CLIENT_ID=""
ENV CX_SCAN_TYPE=sast
ENV CX_SEVERITY_THRESHOLD=high

WORKDIR /app
USER 1000:1000
CMD ["bash"]
