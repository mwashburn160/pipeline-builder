# Snyk Security Plugin — Ruby scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-ruby-base (one pinned Ruby + bundler, shared by all
# Ruby plugins). Snyk resolves Ruby dependencies at scan time, so it needs
# that ecosystem's runtime + package manager present — hence a per-language
# image (the snyk variants stay split by ecosystem).
#
# The Snyk CLI is installed as the pinned standalone Linux binary (no Node.js
# required) and baked at build time: deterministic, no runtime install, no
# network dependency at pipeline time.

FROM pipeline-ruby-base:1.0

# TODO(confirm): confirm the intended pinned Snyk CLI version at build time.
ARG SNYK_VERSION=1.1298.0
RUN set -eux; \
    case "$(uname -m)" in \
      x86_64)  snyk_bin=snyk-linux ;; \
      aarch64) snyk_bin=snyk-linux-arm64 ;; \
      *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://static.snyk.io/cli/v${SNYK_VERSION}/${snyk_bin}" -o /usr/local/bin/snyk; \
    chmod +x /usr/local/bin/snyk; \
    snyk --version

WORKDIR /app
CMD ["bash"]
