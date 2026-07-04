# Ruff Plugin — Python Linter and Formatter
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-python-base (one pinned Python, shared by all
# Python plugins). Ruff is pinned + baked at build time — no runtime
# `pip install` (deterministic, no network dependency at pipeline time).

FROM pipeline-python-base:1.0

# TODO(prototype): confirm the intended pinned ruff version at build time.
ARG RUFF_VERSION=0.14.3
RUN pip3 install --no-cache-dir "ruff==${RUFF_VERSION}"

WORKDIR /app
CMD ["bash"]
