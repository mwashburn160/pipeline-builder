# Rails Test Plugin — Rails Test Runner
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-ruby-base (one pinned Ruby, shared by all Ruby
# plugins). Ruby/gem/bundle are on PATH in the base — no rbenv, no runtime
# Ruby install. The test framework (Minitest/RSpec/Rails) comes from the
# project's Gemfile via `bundle install` at runtime.

FROM pipeline-ruby-base:1.0

WORKDIR /app
CMD ["bash"]
