# Codecov Plugin — Coverage Reporting Service
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Uploads coverage reports to Codecov for PR comments and badge tracking
# Auto-detects coverage file formats: lcov.info, coverage.xml, .coverage, jacoco.xml, coverage.out

FROM pipeline-plugin-base:24.04

# System dependencies. python3 + pip are needed for the Codecov CLI;
# they replace the prior nvm + node install that existed only to run the
# now-deprecated `npm install -g codecov` package.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    gnupg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# ─── Codecov CLI ───
# `npm install -g codecov` was deprecated by Codecov in 2023; the maintained
# replacement is `codecov-cli` from PyPI (smaller image, fewer transitive
# deps, no Node toolchain required). Pin for reproducibility.
RUN pip3 install --break-system-packages --no-cache-dir codecov-cli==11.2.8

# ─── Runtime configuration defaults ───
# Non-sensitive config only — CODECOV_TOKEN must be injected at runtime
# via CodeBuild environment variables or secrets manager
ENV CODECOV_FLAGS=""
ENV CODECOV_FILE=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
