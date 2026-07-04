# Minitest Coverage Plugin — Ruby Code Coverage
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-ruby-base (one pinned Ruby, shared by all Ruby
# plugins). SimpleCov is pinned + baked at build time — no runtime `gem install`
# (deterministic, no network dependency at pipeline time). The test suite comes
# from the project's Gemfile via `bundle install` at runtime.

FROM pipeline-ruby-base:1.0

# TODO(confirm): confirm the intended pinned simplecov version at build time.
ARG SIMPLECOV_VERSION=0.22.0
RUN gem install simplecov -v "${SIMPLECOV_VERSION}" --no-document

WORKDIR /app
CMD ["bash"]
