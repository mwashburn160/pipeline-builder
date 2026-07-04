# Bandit Plugin — Python Security Linter
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-python-base (one pinned Python, shared by all
# Python plugins). Bandit is pinned + baked at build time — no runtime
# `pip install` (deterministic, no network dependency at pipeline time).

FROM pipeline-python-base:1.0

# TODO(confirm): confirm the intended pinned bandit version at build time.
ARG BANDIT_VERSION=1.8.0
RUN pip3 install --no-cache-dir "bandit==${BANDIT_VERSION}"

WORKDIR /app
CMD ["bash"]
