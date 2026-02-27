# Coveralls Plugin — Coverage Reporting Service
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Uploads coverage reports to Coveralls for badge tracking and PR status checks
# Auto-detects coverage file formats: lcov.info, coverage.xml, .coverage

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

# ─── Node.js (required by coveralls CLI) ───
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ─── Coveralls CLI ───
RUN npm install -g coveralls@3.1.1

# ─── Runtime configuration defaults ───
# Non-sensitive config only — COVERALLS_REPO_TOKEN must be injected at runtime
# via CodeBuild environment variables or secrets manager
ENV COVERALLS_SERVICE_NAME=codebuild

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
