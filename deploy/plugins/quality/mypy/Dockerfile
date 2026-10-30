# mypy Plugin — Python Static Type Checker
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over plugin-python-base (one pinned Python, shared by all
# Python plugins). mypy is pinned + baked at build time — no runtime
# `pip install` (deterministic, no network dependency at pipeline time).

FROM plugin-python-base:1.0

ARG MYPY_VERSION=2.4.1
RUN pip3 install --no-cache-dir "mypy==${MYPY_VERSION}"

WORKDIR /app
USER 1000:1000
CMD ["bash"]
