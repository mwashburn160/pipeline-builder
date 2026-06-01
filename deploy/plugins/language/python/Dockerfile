# Python Plugin — Multi-version build environment using pyenv
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Python version is selected at runtime via PYTHON_VERSION env var
# Package manager auto-detected (pip/poetry/pipenv) or set via PACKAGE_MANAGER env var

FROM pipeline-plugin-base:24.04

# System dependencies. CPython itself is no longer compiled here (it's a
# precompiled build — see below), but the toolchain + headers are kept
# because user pipelines pip-install packages with native C extensions
# (lxml, cryptography, psycopg, …) that compile at runtime.
RUN apt-retry-install build-essential libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev libncurses-dev libxml2-dev libxmlsec1-dev libffi-dev liblzma-dev

# Install pyenv (provides the shims + PYTHON_VERSION selection; we do NOT use
# `pyenv install`, which compiles CPython from source and was the dominant
# build cost / timeout risk on the CPU-constrained buildkit).
ENV PYENV_ROOT=/opt/pyenv
RUN curl -fsSL https://pyenv.run | bash

# Pre-install current + previous Python versions as PRECOMPILED, relocatable
# builds from astral-sh/python-build-standalone (the same builds uv/rye use),
# unpacked into pyenv's versions/ dir. Each version dir is named by its MINOR
# label (3.13, 3.14) — not the exact patch — so the runtime PYTHON_VERSION /
# `pyenv global` interface is unchanged. The `install_only` tarball has a
# single top-level `python/` dir, so --strip-components=1 lands bin/ + lib/ in
# place; the final `python3 --version` guard fails the build if a relocated
# build can't run on this base.
#
# Format: "<minor-label>:<exact-build-version>" pairs.
ARG PYTHON_VERSIONS="3.13:3.13.13 3.14:3.14.5"
ARG PBS_RELEASE="20260510"
ARG PBS_BASE="https://github.com/astral-sh/python-build-standalone/releases/download"
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) triple=x86_64-unknown-linux-gnu ;; \
      arm64) triple=aarch64-unknown-linux-gnu ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    for pair in ${PYTHON_VERSIONS}; do \
      label="${pair%%:*}"; full="${pair##*:}"; \
      dest="${PYENV_ROOT}/versions/${label}"; \
      mkdir -p "${dest}"; \
      curl -fsSL "${PBS_BASE}/${PBS_RELEASE}/cpython-${full}%2B${PBS_RELEASE}-${triple}-install_only.tar.gz" -o /tmp/py.tar.gz; \
      tar -xzf /tmp/py.tar.gz -C "${dest}" --strip-components=1; \
      rm -f /tmp/py.tar.gz; \
      test -x "${dest}/bin/python3"; \
    done; \
    "${PYENV_ROOT}/bin/pyenv" rehash; \
    "${PYENV_ROOT}/bin/pyenv" global 3.14

# Add pyenv to PATH
ENV PATH="/opt/pyenv/shims:/opt/pyenv/bin:${PATH}"

# Validate the precompiled runtimes resolve through the shims.
RUN python3 --version && pyenv versions

# Default Python version (overridden by PYTHON_VERSION env var at runtime)
ENV PYTHON_VERSION=3.14

# Package manager selection (auto = detect from project files)
ENV PACKAGE_MANAGER=auto

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
