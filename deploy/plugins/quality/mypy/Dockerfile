# mypy Plugin — Python Static Type Checker
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-python-base (one pinned Python, shared by all
# Python plugins). mypy is pinned + baked at build time — no runtime
# `pip install` (deterministic, no network dependency at pipeline time).

FROM pipeline-python-base:1.0

# TODO(confirm): confirm the intended pinned mypy version at build time.
ARG MYPY_VERSION=1.14.1
RUN pip3 install --no-cache-dir "mypy==${MYPY_VERSION}"

WORKDIR /app
CMD ["bash"]
