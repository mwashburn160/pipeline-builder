# Veracode Plugin — Enterprise SAST/DAST Security Scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Uploads application artifacts for Veracode static/dynamic analysis
# Requires VERACODE_API_ID and VERACODE_API_KEY at runtime

FROM pipeline-plugin-base:24.04

# Build steps below need root (apt, writes under /usr/local and /opt); the
# image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

# git/zip/unzip/curl/wget/jq/ca-certificates already come from the base.
RUN apt-retry-install openjdk-17-jre-headless

# ─── Veracode CLI ───
# Pinned: the rolling `install | sh` script only resolves LATEST_VERSION and
# unpacks veracode-cli_<version>_linux_x86.tar.gz — we fetch that versioned
# tarball directly and install its single `veracode` binary. Veracode
# publishes no checksum for it; the digest was computed from the ${VERACODE_CLI_VERSION}
# tarball. Linux builds are x86_64 only.
ARG VERACODE_CLI_VERSION=2.52.2
ARG VERACODE_CLI_SHA256_AMD64=bfe2b6f57ca08b80a107f98b36084d63295c700bb3266566a70ad1e854aee019
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) sum="${VERACODE_CLI_SHA256_AMD64}" ;; \
      *) echo "veracode-cli: no linux build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://tools.veracode.com/veracode-cli/veracode-cli_${VERACODE_CLI_VERSION}_linux_x86.tar.gz" "$sum" /tmp/veracode-cli.tar.gz; \
    tar -xzf /tmp/veracode-cli.tar.gz -C /tmp; \
    install -m 0755 "/tmp/veracode-cli_${VERACODE_CLI_VERSION}_linux_x86/veracode" /usr/local/bin/veracode; \
    rm -rf /tmp/veracode-cli.tar.gz "/tmp/veracode-cli_${VERACODE_CLI_VERSION}_linux_x86"

# ─── Veracode Pipeline Scanner (lightweight static analysis) ───
# Pinned to a versioned zip (was the rolling pipeline-scan-LATEST.zip); digest
# computed from that zip (Veracode publishes none).
ARG VERACODE_PIPELINE_SCAN_VERSION=26.9.0
ARG VERACODE_PIPELINE_SCAN_SHA256=ce7027f4edd8bef3e960cf2fc942518daab593740dc501744076885fc6ecd60b
RUN set -eux; \
    fetch-verified "https://downloads.veracode.com/securityscan/pipeline-scan-${VERACODE_PIPELINE_SCAN_VERSION}.zip" \
       "${VERACODE_PIPELINE_SCAN_SHA256}" /tmp/pipeline-scan.zip; \
    mkdir -p /opt/veracode; \
    unzip -q /tmp/pipeline-scan.zip -d /opt/veracode; \
    rm /tmp/pipeline-scan.zip; \
    chmod -R a+rX /opt/veracode

# Non-sensitive config only — API credentials injected at runtime
ENV VERACODE_SCAN_TYPE=pipeline
ENV VERACODE_APP_NAME=""
ENV VERACODE_SEVERITY_THRESHOLD=Medium
ENV VERACODE_ARTIFACT=""

WORKDIR /app
USER 1000:1000
CMD ["bash"]
