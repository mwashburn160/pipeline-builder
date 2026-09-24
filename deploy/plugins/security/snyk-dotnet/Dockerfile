# Snyk Security Plugin — .NET scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-dotnet-base (one pinned .NET SDK, shared by all
# .NET plugins). Snyk resolves .NET dependencies at scan time, so it needs
# that ecosystem's runtime + package manager present — hence a per-language
# image (the snyk variants stay split by ecosystem).
#
# The Snyk CLI is installed as the pinned standalone Linux binary (no Node.js
# required) and baked at build time: deterministic, no runtime install, no
# network dependency at pipeline time.

FROM pipeline-dotnet-base:1.0

# Writes under /usr/local need root; dropped to uid 1000 at the end.
USER root

# TODO(confirm): confirm the intended pinned Snyk CLI version at build time.
# Digests are Snyk's published <binary>.sha256 files for this version.
ARG SNYK_VERSION=1.1307.4
ARG SNYK_SHA256_AMD64=b0baee4fa4d7d11b7df927a1046cf8137a8a89fafac8101a45c3c0e0777ddc35
ARG SNYK_SHA256_ARM64=694c014c1d0db25b481092fd7df6edf6e01449d5ab7b043843a6fb41c141ba08
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
