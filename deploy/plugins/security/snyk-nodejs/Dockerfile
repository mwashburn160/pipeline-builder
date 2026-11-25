# Snyk Security Plugin — Node.js scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over plugin-node-base (one pinned Node, shared by all Node
# plugins). Snyk resolves Node.js dependencies at scan time, so it needs that
# ecosystem's runtime + package manager present — hence a per-language image
# (the snyk variants stay split by ecosystem).
#
# The Snyk CLI is installed as the pinned standalone Linux binary and baked at
# build time: deterministic, no runtime install, no network dependency at
# pipeline time.

FROM plugin-node-base:1.0

# Writes under /usr/local need root; dropped to uid 1000 at the end.
USER root

# Digests are Snyk's published <binary>.sha256 files for this version.
ARG SNYK_VERSION=1.1309.0
ARG SNYK_SHA256_AMD64=4802579c2818938a2f4849d270df1139f310104286a8a5c6305328a3c2eb9e1c
ARG SNYK_SHA256_ARM64=97d6c5d0aed21d0f8ae0b0b7764acab3c67f5ccd211b1069a6a74fd953e5c600
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
