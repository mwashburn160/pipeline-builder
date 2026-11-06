# Snyk Security Plugin — Java/Kotlin scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over plugin-jvm-base (one pinned Corretto JDK + Maven/Gradle,
# shared by all JVM plugins). Snyk resolves Java/Kotlin dependencies at scan
# time, so it needs that ecosystem's runtime + build tools present — hence a
# per-language image (the snyk variants stay split by ecosystem).
#
# The Snyk CLI is installed as the pinned standalone Linux binary (no Node.js
# required) and baked at build time: deterministic, no runtime install, no
# network dependency at pipeline time.

FROM plugin-jvm-base:1.0

# Writes under /usr/local need root; dropped to uid 1000 at the end.
USER root

# Digests are Snyk's published <binary>.sha256 files for this version.
ARG SNYK_VERSION=1.1308.4
ARG SNYK_SHA256_AMD64=979172ee128903f50e43fff221f22a0689579f22c086dabaa0d1a5416485b9ba
ARG SNYK_SHA256_ARM64=9cf3e55e4bd216138a86a08f6d4235d5a014459cf0df7150818421fd8e044d48
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
