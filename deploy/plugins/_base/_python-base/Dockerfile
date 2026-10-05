# Pipeline Builder — Shared Python Base Image
#
# Build target tag: plugin-python-base:1.0
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

FROM plugin-base:24.04

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
# VULN FIX (2026-10-02): 3.12.14 is missing 3.12.15's 9 CVE fixes, incl. a
# use-after-free in ssl.SSLContext (CVE-2026-19445) and several tarfile
# extraction-filter bypasses (CVE-2026-82049/19672/87910). Bumped to the
# latest python-build-standalone release carrying 3.12.15.
ARG PYTHON_BUILD=3.12.15
ARG PBS_RELEASE=20261001
ARG PBS_SHA256_AMD64=0e56475e23f61a9c7d254fe16bc4931544026d591fc1cb8b770712ee94fa6260
ARG PBS_SHA256_ARM64=6a1b2e68c6fe749b78bbacb8fa42ff9bc844a72de7ed3ee52428f09a42f2ffc1
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
