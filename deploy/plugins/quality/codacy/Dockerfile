# Codacy Plugin — Code Quality and Coverage Reporting
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Uploads coverage reports to Codacy for quality tracking and PR analysis
# Auto-detects coverage file formats: lcov.info, coverage.xml, .coverage, jacoco.xml, coverage.out

# ─── Tool versions (override with --build-arg) ───
ARG CODACY_VERSION=14.1.3

FROM pipeline-plugin-base:24.04

ARG CODACY_VERSION

# Writes under /usr/local need root; dropped to uid 1000 at the end.
USER root

# ─── Codacy Coverage Reporter ───
# Multi-arch: codacy ships codacy-coverage-reporter-linux (x64) and
# codacy-coverage-reporter-linux-arm (an aarch64 build, despite the name — the
# `-linux-arm64` asset this used to fetch does not exist). The reporter is a
# self-contained native binary; no extra deps needed. Digests are the GitHub
# release-asset SHA-256s for ${CODACY_VERSION}.
ARG CODACY_SHA256_AMD64=15c5f052207d27b8501ab5d5910c68c206ea70b0157ee1725132780530580875
ARG CODACY_SHA256_ARM64=d69181ac2dbdebb35efe37ab668bf1f00941e4e749d36e817c7786a878471d13
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) CODACY_BIN=codacy-coverage-reporter-linux;     sum="${CODACY_SHA256_AMD64}" ;; \
      arm64) CODACY_BIN=codacy-coverage-reporter-linux-arm; sum="${CODACY_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://github.com/codacy/codacy-coverage-reporter/releases/download/${CODACY_VERSION}/${CODACY_BIN}" \
       "$sum" /usr/local/bin/codacy-coverage-reporter; \
    chmod 0755 /usr/local/bin/codacy-coverage-reporter

# ─── Runtime configuration defaults ───
# Non-sensitive config only — CODACY_PROJECT_TOKEN must be injected at runtime
# via CodeBuild environment variables or secrets manager
ENV CODACY_LANGUAGE=""

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
