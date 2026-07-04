# Brakeman Plugin — Rails Security Scanner
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-ruby-base (one pinned Ruby, shared by all Ruby
# plugins). Brakeman is pinned + baked at build time — no runtime `gem install`
# (deterministic, no network dependency at pipeline time).

FROM pipeline-ruby-base:1.0

# TODO(confirm): confirm the intended pinned brakeman version at build time.
ARG BRAKEMAN_VERSION=6.2.2
RUN gem install brakeman -v "${BRAKEMAN_VERSION}" --no-document

WORKDIR /app
CMD ["bash"]
