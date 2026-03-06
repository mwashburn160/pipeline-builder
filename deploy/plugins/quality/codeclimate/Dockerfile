# Code Climate Plugin — Code Quality and Coverage Reporting
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Uploads coverage reports to Code Climate for quality tracking and PR analysis
# Auto-detects coverage file formats: lcov.info, coverage.xml, .coverage, jacoco.xml, coverage.out

# ─── Tool versions (override with --build-arg) ───
ARG CC_REPORTER_VERSION=0.11.1

FROM public.ecr.aws/docker/library/ubuntu:24.04

ARG CC_REPORTER_VERSION

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ─── Code Climate Test Reporter ───
RUN curl -fsSL https://codeclimate.com/downloads/test-reporter/test-reporter-${CC_REPORTER_VERSION}-linux-amd64 \
    -o /usr/local/bin/cc-test-reporter \
    && chmod +x /usr/local/bin/cc-test-reporter

# ─── Runtime configuration defaults ───
# Non-sensitive config only — CC_TEST_REPORTER_ID must be injected at runtime
# via CodeBuild environment variables or secrets manager
ENV CC_COVERAGE_FILE=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
