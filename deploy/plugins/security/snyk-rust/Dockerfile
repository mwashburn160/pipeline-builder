# Snyk Security Plugin — Rust scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-rust-base (one pinned Rust toolchain, shared by all
# Rust plugins). Snyk resolves Rust dependencies at scan time, so it needs
# that ecosystem's runtime + package manager present — hence a per-language
# image (the snyk variants stay split by ecosystem).
#
# The Snyk CLI is installed as the pinned standalone Linux binary (no Node.js
# required) and baked at build time: deterministic, no runtime install, no
# network dependency at pipeline time.

FROM pipeline-rust-base:1.0

# Writes under /usr/local need root; dropped to uid 1000 at the end.
USER root

# TODO(confirm): confirm the intended pinned Snyk CLI version at build time.
# Digests are Snyk's published <binary>.sha256 files for this version.
ARG SNYK_VERSION=1.1307.3
ARG SNYK_SHA256_AMD64=36fd42eab22ca275bddd2a67c83b51efc358dc2c29dcf53f7a98d3797c93c621
ARG SNYK_SHA256_ARM64=4f91cfc09204403f2cfa05e9ee5dfa044c24ce78b75220437f86243a32e5317e
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
