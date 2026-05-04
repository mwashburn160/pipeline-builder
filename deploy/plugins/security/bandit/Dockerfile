# Bandit Plugin — Python Security Linter
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Multistage rationale:
#   pyenv compiles Python from source, requiring the full build chain
#   (build-essential + ~10 *-dev libraries, ~200 MB). Bandit itself just
#   AST-walks Python source — it never needs a C compiler at runtime.
#   So we install Python in a builder stage with the full toolchain, then
#   COPY only the compiled /opt/pyenv tree to a runtime stage that has
#   only the matching runtime libraries (-dev → no -dev).
#
#   This is SAFE for static-analysis tools (bandit, ruff, mypy, snyk-python,
#   trivy-python, sonarcloud-python) that don't compile user code.
#   It is NOT safe for language/python, testing/coverage-py, testing/
#   python-pytest — those run user code that may pip-install C-extension
#   packages, requiring the build chain at runtime. Those plugins keep the
#   single-stage form.
#
#   Net savings: ~200 MB per image.

FROM pipeline-plugin-base:24.04 AS builder

# Full build chain — needed only inside the builder to compile Python.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev \
    libncursesw5-dev libxml2-dev libxmlsec1-dev libffi-dev liblzma-dev \
    && rm -rf /var/lib/apt/lists/*

ENV PYENV_ROOT=/opt/pyenv
RUN curl -fsSL https://pyenv.run | bash \
    && /opt/pyenv/bin/pyenv install 3.13 \
    && /opt/pyenv/bin/pyenv install 3.14 \
    && /opt/pyenv/bin/pyenv global 3.14 \
    # Drop pyenv build/source caches — saves ~150 MB of Python source tarballs
    && rm -rf /opt/pyenv/cache /tmp/python-build*

# ───────────────────────────────────────────────────────────
FROM pipeline-plugin-base:24.04

# Runtime libraries only (no -dev headers). These are the .so files that
# the Python interpreters compiled in the builder are dynamically linked to.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl3 zlib1g libbz2-1.0 libreadline8 libsqlite3-0 \
    libncursesw6 libxml2 libxmlsec1 libffi8 liblzma5 \
    && rm -rf /var/lib/apt/lists/*

ENV PYENV_ROOT=/opt/pyenv
COPY --from=builder /opt/pyenv /opt/pyenv

ENV PATH="/opt/pyenv/shims:/opt/pyenv/bin:${PATH}"
ENV PYTHON_VERSION=3.14

WORKDIR /app
CMD ["bash"]
