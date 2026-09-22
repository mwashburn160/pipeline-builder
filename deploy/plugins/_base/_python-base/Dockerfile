# Pipeline Builder — Shared Python Base Image
#
# Build target tag: pipeline-python-base:1.0
#
# One pinned Python, baked once, shared by every Python plugin (ruff, mypy,
# bandit, python-pytest, coverage-py, and the snyk/trivy/sonarcloud Python
# scanners). Replaces the per-plugin pyenv multistage builds that each
# re-installed Python — several of which ran `pyenv install`, compiling
# CPython from source on the CPU-constrained buildkit (the dominant build
# cost / timeout risk).
#
# SINGLE-VERSION MODEL: exactly one Python is present. To change the version,
# bump PYTHON_BUILD/PYTHON_VERSION here and rebuild the base — the running
# image is always deterministic, with no runtime `pyenv install` (no source
# compile, no network dependency at pipeline time).
#
# Build orchestration: build-plugin-images.sh builds `_`-prefixed base dirs
# first (alphabetically _plugin-base before _python-base, which FROMs it),
# tags them locally, and excludes them from the plugin catalog/upload flow.

FROM pipeline-plugin-base:24.04

USER root

# Native-extension toolchain + headers. CPython itself is NOT compiled here
# (precompiled build below), but user pipelines pip-install packages with C
# extensions (lxml, cryptography, psycopg, …) that compile at runtime.
RUN apt-retry-install build-essential libssl-dev zlib1g-dev libbz2-dev \
    libreadline-dev libsqlite3-dev libncurses-dev libxml2-dev libxmlsec1-dev \
    libffi-dev liblzma-dev

# Single pinned CPython from astral-sh/python-build-standalone (precompiled,
# relocatable — the same builds uv/rye use), verified against the release's
# SHA256SUMS. PYTHON_HOME is owned by the plugin user so `pip install` into
# site-packages works non-root.
ARG PYTHON_VERSION=3.12
ARG PYTHON_BUILD=3.12.13
ARG PBS_RELEASE=20260510
ARG PBS_SHA256_AMD64=e7332b4b4bb85006deb48d251c786a04c14de104c9b3a006b33457a4a604b8bc
ARG PBS_SHA256_ARM64=87097de12bc212e41ea8409efd0083fe06465d725e35d130e4007a4bf7e4f1c8
ARG PBS_BASE=https://github.com/astral-sh/python-build-standalone/releases/download
ENV PYTHON_HOME=/opt/python
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) triple=x86_64-unknown-linux-gnu;  sum="${PBS_SHA256_AMD64}" ;; \
      arm64) triple=aarch64-unknown-linux-gnu; sum="${PBS_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "${PBS_BASE}/${PBS_RELEASE}/cpython-${PYTHON_BUILD}%2B${PBS_RELEASE}-${triple}-install_only.tar.gz" "$sum" /tmp/py.tar.gz; \
    mkdir -p "${PYTHON_HOME}"; \
    tar -xzf /tmp/py.tar.gz -C "${PYTHON_HOME}" --strip-components=1; \
    rm -f /tmp/py.tar.gz; \
    test -x "${PYTHON_HOME}/bin/python3"; \
    chown -R 1000:1000 "${PYTHON_HOME}"

ENV PATH="${PYTHON_HOME}/bin:${PATH}"
# Runtime-visible version knob; matches what's baked (rebuild the base to change).
ENV PYTHON_VERSION=${PYTHON_VERSION}

RUN python3 --version && pip3 --version

WORKDIR /app
USER 1000:1000
CMD ["bash"]
