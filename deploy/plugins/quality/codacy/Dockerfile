# Codacy Plugin — Code Quality and Coverage Reporting
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Uploads coverage reports to Codacy for quality tracking and PR analysis
# Auto-detects coverage file formats: lcov.info, coverage.xml, .coverage, jacoco.xml, coverage.out

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ─── Codacy Coverage Reporter ───
RUN curl -fsSL https://github.com/codacy/codacy-coverage-reporter/releases/download/16.3.0/codacy-coverage-reporter-linux \
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
