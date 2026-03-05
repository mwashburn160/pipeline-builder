# Codecov Plugin — Coverage Reporting Service
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Uploads coverage reports to Codecov for PR comments and badge tracking
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
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# ─── Node.js (required by Codecov CLI) ───
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ─── Codecov CLI (installed via npm — more stable than binary URL) ───
RUN npm install -g codecov

# ─── Runtime configuration defaults ───
# Non-sensitive config only — CODECOV_TOKEN must be injected at runtime
# via CodeBuild environment variables or secrets manager
ENV CODECOV_FLAGS=""
ENV CODECOV_FILE=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
