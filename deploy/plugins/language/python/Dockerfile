# Python Plugin — build + test Python applications (pip / Poetry / Pipenv)
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-python-base (one pinned Python + native-extension
# toolchain, shared by all Python plugins). The package managers + test runner
# this plugin drives (Poetry, Pipenv, pytest) are pinned + baked at build time
# — no runtime `pip install` of tooling (deterministic, no network dependency
# for the tools at pipeline time). User PROJECT deps are still installed at
# runtime by the spec (from requirements.txt / poetry.lock / Pipfile).
#
# Package manager is auto-detected at runtime (pip/poetry/pipenv) or set via
# the PACKAGE_MANAGER env var.

FROM pipeline-python-base:1.0

# TODO(confirm): confirm the intended pinned tool versions at build time.
ARG POETRY_VERSION=1.8.5
ARG PIPENV_VERSION=2024.4.0
ARG PYTEST_VERSION=8.3.4
ARG PYTEST_COV_VERSION=6.0.0
RUN pip3 install --no-cache-dir \
    "poetry==${POETRY_VERSION}" \
    "pipenv==${PIPENV_VERSION}" \
    "pytest==${PYTEST_VERSION}" \
    "pytest-cov==${PYTEST_COV_VERSION}"

# Package manager selection (auto = detect from project files)
ENV PACKAGE_MANAGER=auto

WORKDIR /app
CMD ["bash"]
