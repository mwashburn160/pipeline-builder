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
ARG PYTHON_VERSION=3.15
# 3.12 -> 3.15 (2026-10-29). This is a MINOR-LINE jump, not a patch, and it is
# the interpreter that runs CUSTOMER code: the `language/python` plugin builds
# and tests user projects on it, so a project written against 3.12 semantics
# gets 3.15 semantics with no warning. Taken deliberately, not for a CVE —
# 3.12 is supported until 2028-10-31 and carried no open finding.
#
# Checked before taking it: every tool layered on this base installs on 3.15.
# `requires_python` is open-ended for all of them (poetry/pipenv/bandit/meson
# >=3.10, ruff >=3.7, conan >=3.8), and coverage and mypy ship cp315 wheels.
# The one gap is `conan`, which declares no 3.14/3.15 classifier — it installs,
# but its maintainers do not claim to test there. If a conan plugin misbehaves
# on this base, that is the first thing to suspect.
#
# PBS_RELEASE moves with it: 3.15.2 was published 2026-10-09, AFTER the 20261001
# release, so the old pin cannot carry it. Both digests below were computed by
# downloading the real artifacts, not copied from a sidecar (PBS publishes no
# .sha256 asset for these).
ARG PYTHON_BUILD=3.15.2
ARG PBS_RELEASE=20261026
ARG PBS_SHA256_AMD64=08d4ae9024a7cfbd3b70e559241afa2571cd3208d7bd5f96f88e0080dd4092aa
ARG PBS_SHA256_ARM64=6fc73e8a4c80a65d2a0ed21535c65383f7b9f96bb58a5f40ed035bd7ee318616
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
