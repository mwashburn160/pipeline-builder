# Gem Publish Plugin — Publish gems to RubyGems
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Publishes Ruby gems to RubyGems.org with dry-run support
# Requires GEM_HOST_API_KEY injected at runtime via CodeBuild secrets

FROM pipeline-plugin-base:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    ruby \
    ruby-dev \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# ─── Runtime configuration defaults ───
# Non-sensitive config only — GEM_HOST_API_KEY injected at runtime via CodeBuild secrets
ENV GEM_DRY_RUN=false

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
