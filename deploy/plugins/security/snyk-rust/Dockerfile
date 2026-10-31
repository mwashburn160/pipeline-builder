# Snyk Security Plugin — Rust scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over plugin-rust-base (one pinned Rust toolchain, shared by all
# Rust plugins). Snyk resolves Rust dependencies at scan time, so it needs
# that ecosystem's runtime + package manager present — hence a per-language
# image (the snyk variants stay split by ecosystem).
#
# The Snyk CLI is installed as the pinned standalone Linux binary (no Node.js
# required) and baked at build time: deterministic, no runtime install, no
# network dependency at pipeline time.

FROM plugin-rust-base:1.0

# Writes under /usr/local need root; dropped to uid 1000 at the end.
USER root

# Digests are Snyk's published <binary>.sha256 files for this version.
ARG SNYK_VERSION=1.1308.3
ARG SNYK_SHA256_AMD64=5f323f45885341ea1473639859271925912ece82a2f77bc146bb4468f9838840
ARG SNYK_SHA256_ARM64=3686e7c29344dda49f9c86be6d48e9bc43f83b74b8c6f331dcc5d6d43f4a6faf
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) snyk_bin=snyk-linux;       sum="${SNYK_SHA256_AMD64}" ;; \
      arm64) snyk_bin=snyk-linux-arm64; sum="${SNYK_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://static.snyk.io/cli/v${SNYK_VERSION}/${snyk_bin}" "$sum" /usr/local/bin/snyk; \
    chmod 0755 /usr/local/bin/snyk; \
    snyk --version

WORKDIR /app
USER 1000:1000
CMD ["bash"]
