# Bundler Audit Plugin — Dependency Vulnerability Scanner
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-ruby-base (one pinned Ruby, shared by all Ruby
# plugins). bundler-audit is pinned + baked at build time — no runtime
# `gem install` (deterministic, no network dependency at pipeline time).

FROM pipeline-ruby-base:1.0

# TODO(confirm): confirm the intended pinned bundler-audit version at build time.
ARG BUNDLER_AUDIT_VERSION=0.9.2
RUN gem install bundler-audit -v "${BUNDLER_AUDIT_VERSION}" --no-document

WORKDIR /app
CMD ["bash"]
