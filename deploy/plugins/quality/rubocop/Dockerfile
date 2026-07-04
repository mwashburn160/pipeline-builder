# RuboCop Plugin — Ruby Linter and Formatter
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-ruby-base (one pinned Ruby, shared by all Ruby
# plugins). RuboCop is pinned + baked at build time — no runtime `gem install`
# (deterministic, no network dependency at pipeline time).

FROM pipeline-ruby-base:1.0

# TODO(confirm): confirm the intended pinned rubocop version at build time.
ARG RUBOCOP_VERSION=1.71.0
RUN gem install rubocop -v "${RUBOCOP_VERSION}" --no-document

WORKDIR /app
CMD ["bash"]
