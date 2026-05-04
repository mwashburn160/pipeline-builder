# Ruff Plugin — Python Linter and Formatter
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Multistage rationale (see security/bandit/Dockerfile for the canonical
# explanation): pyenv compiles Python from source — needs build-essential
# + ~10 *-dev libs (~200 MB). Ruff is a Rust-based linter that doesn't
# compile user code, so the build chain is not needed at runtime.

FROM pipeline-plugin-base:24.04 AS builder

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
    && rm -rf /opt/pyenv/cache /tmp/python-build*

# ───────────────────────────────────────────────────────────
FROM pipeline-plugin-base:24.04

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
