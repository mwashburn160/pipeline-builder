# coverage.py Plugin — Python Code Coverage
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-python-base (one pinned Python + native-extension
# toolchain, shared by all Python plugins). coverage + pytest are pinned +
# baked at build time — no runtime `pip install` (deterministic, no network
# dependency at pipeline time). User project deps are still installed at
# runtime by the spec.

FROM pipeline-python-base:1.0

# TODO(confirm): confirm the intended pinned coverage / pytest versions.
ARG COVERAGE_VERSION=7.6.10
ARG PYTEST_VERSION=8.3.4
RUN pip3 install --no-cache-dir "coverage==${COVERAGE_VERSION}" "pytest==${PYTEST_VERSION}"

WORKDIR /app
CMD ["bash"]
