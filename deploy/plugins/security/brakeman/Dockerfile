# Brakeman Plugin — Rails Security Scanner
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over plugin-ruby-base (one pinned Ruby, shared by all Ruby
# plugins). Brakeman is pinned + baked at build time — no runtime `gem install`
# (deterministic, no network dependency at pipeline time).

FROM plugin-ruby-base:1.0

ARG BRAKEMAN_VERSION=8.1.0
RUN gem install brakeman -v "${BRAKEMAN_VERSION}" --no-document

WORKDIR /app
USER 1000:1000
CMD ["bash"]
