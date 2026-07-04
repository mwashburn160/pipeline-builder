# Ruby Plugin — Build/test Ruby applications with Bundler
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-ruby-base (one pinned Ruby, shared by all Ruby
# plugins). Ruby/gem/bundle are on PATH in the base — no rbenv, no runtime
# Ruby install. Bundler is pinned + baked here (deterministic, no network
# dependency at pipeline time); project deps still `bundle install` at runtime.

FROM pipeline-ruby-base:1.0

# TODO(confirm): confirm the intended pinned bundler version at build time.
ARG BUNDLER_VERSION=2.6.9
RUN gem install bundler -v "${BUNDLER_VERSION}" --no-document

WORKDIR /app
CMD ["bash"]
