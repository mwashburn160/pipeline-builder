# pytest Plugin — Python Test Runner
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-python-base (one pinned Python + native-extension
# toolchain, shared by all Python plugins). pytest is pinned + baked at build
# time — no runtime `pip install` (deterministic, no network dependency at
# pipeline time). User project deps are still installed at runtime by the spec.

FROM pipeline-python-base:1.0

# TODO(confirm): confirm the intended pinned pytest / pytest-cov versions.
ARG PYTEST_VERSION=8.3.4
ARG PYTEST_COV_VERSION=6.0.0
RUN pip3 install --no-cache-dir "pytest==${PYTEST_VERSION}" "pytest-cov==${PYTEST_COV_VERSION}"

WORKDIR /app
CMD ["bash"]
