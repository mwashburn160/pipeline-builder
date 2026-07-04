# Gem Publish Plugin — Publish gems to RubyGems
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Publishes Ruby gems to RubyGems.org with dry-run support
# Requires GEM_HOST_API_KEY injected at runtime via CodeBuild secrets
#
# Thin layer over pipeline-ruby-base (one pinned Ruby, shared by all Ruby
# plugins). Ruby/gem/bundle are on PATH in the base — no runtime Ruby install.
# `gem build` / `gem push` use the baked gem toolchain.

FROM pipeline-ruby-base:1.0

# ─── Runtime configuration defaults ───
# Non-sensitive config only — GEM_HOST_API_KEY injected at runtime via CodeBuild secrets
ENV GEM_DRY_RUN=false

WORKDIR /app
CMD ["bash"]
