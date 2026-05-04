# Codacy Plugin — Code Quality and Coverage Reporting
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Uploads coverage reports to Codacy for quality tracking and PR analysis
# Auto-detects coverage file formats: lcov.info, coverage.xml, .coverage, jacoco.xml, coverage.out

# ─── Tool versions (override with --build-arg) ───
ARG CODACY_VERSION=14.1.2

FROM pipeline-plugin-base:24.04

ARG CODACY_VERSION

# ─── Codacy Coverage Reporter ───
# Multi-arch: codacy ships codacy-coverage-reporter-linux (x64) and
# codacy-coverage-reporter-linux-arm64. The reporter is a self-contained
# native binary; no extra deps needed.
RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
         amd64) CODACY_BIN=codacy-coverage-reporter-linux ;; \
         arm64) CODACY_BIN=codacy-coverage-reporter-linux-arm64 ;; \
         *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/codacy/codacy-coverage-reporter/releases/download/${CODACY_VERSION}/${CODACY_BIN}" \
       -o /usr/local/bin/codacy-coverage-reporter \
    && chmod +x /usr/local/bin/codacy-coverage-reporter

# ─── Runtime configuration defaults ───
# Non-sensitive config only — CODACY_PROJECT_TOKEN must be injected at runtime
# via CodeBuild environment variables or secrets manager
ENV CODACY_LANGUAGE=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
