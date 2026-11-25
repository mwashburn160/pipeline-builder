# Veracode Plugin — Enterprise SAST/DAST Security Scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Uploads application artifacts for Veracode static/dynamic analysis
# Requires VERACODE_API_ID and VERACODE_API_KEY at runtime

FROM plugin-base:26.10

# Build steps below need root (apt, writes under /usr/local and /opt); the
# image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

# git/zip/unzip/curl/wget/jq/ca-certificates already come from the base.
RUN apt-retry-install openjdk-17-jre-headless

# ─── Veracode CLI ───
# Pinned: the rolling `install | sh` script only resolves LATEST_VERSION and
# unpacks veracode-cli_<version>_linux_x86.tar.gz — we fetch that versioned
# tarball directly and install its single `veracode` binary. Veracode
# publishes no checksum for it; the digest was computed from two independent
# downloads of the ${VERACODE_CLI_VERSION} tarball (identical; 2026-11-25). Linux builds are x86_64 only.
ARG VERACODE_CLI_VERSION=2.57.0
ARG VERACODE_CLI_SHA256_AMD64=02815edc16e240d1c3a3b36810f693c23795c5554cbf0f1f0575c0e1884565ba
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) sum="${VERACODE_CLI_SHA256_AMD64}" ;; \
      *) echo "veracode-cli: no linux build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://tools.veracode.com/veracode-cli/veracode-cli_${VERACODE_CLI_VERSION}_linux_x86.tar.gz" "$sum" /tmp/veracode-cli.tar.gz; \
    mkdir /tmp/veracode-cli; \
    tar -xzf /tmp/veracode-cli.tar.gz -C /tmp/veracode-cli --strip-components=1; \
    install -m 0755 /tmp/veracode-cli/veracode /usr/local/bin/veracode; \
    rm -rf /tmp/veracode-cli.tar.gz /tmp/veracode-cli; \
    veracode --version

# ─── Veracode Pipeline Scanner (lightweight static analysis) ───
# Pinned to a versioned zip (was the rolling pipeline-scan-LATEST.zip); digest
# computed from two independent downloads of that zip (Veracode publishes none;
# 26.11.0 is the version LATEST resolved to on 2026-11-18 — jar manifest
# Implementation-Version 26.11.0-0).
ARG VERACODE_PIPELINE_SCAN_VERSION=26.11.0
ARG VERACODE_PIPELINE_SCAN_SHA256=c579f60e1099a3b15b0b145da2896961e527dac5cbcc0a4109411e0f63cc3399
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
