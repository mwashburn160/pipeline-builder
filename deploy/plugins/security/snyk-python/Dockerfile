# Snyk Security Plugin — Python scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Multistage rationale: pyenv compiles Python from source. Snyk parses
# requirements.txt and lockfiles — never compiles user code. The Node
# toolchain (for snyk CLI) is installed in the runtime stage since it
# needs no build chain. See security/bandit/Dockerfile for the full
# explanation.

FROM pipeline-plugin-base:24.04 AS python-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev \
    libncurses-dev libxml2-dev libxmlsec1-dev libffi-dev liblzma-dev \
    && rm -rf /var/lib/apt/lists/*

ENV PYENV_ROOT=/opt/pyenv
RUN curl -fsSL https://pyenv.run | bash \
    && /opt/pyenv/bin/pyenv install 3.13 \
    && /opt/pyenv/bin/pyenv install 3.14 \
    && /opt/pyenv/bin/pyenv global 3.14 \
    && rm -rf /opt/pyenv/cache /tmp/python-build*

# ───────────────────────────────────────────────────────────
FROM pipeline-plugin-base:24.04

# Python runtime libs (no -dev headers).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl3 zlib1g libbz2-1.0 libreadline8 libsqlite3-0 \
    libncursesw6 libxml2 libxmlsec1 libffi8 liblzma5 \
    && rm -rf /var/lib/apt/lists/*

ENV PYENV_ROOT=/opt/pyenv
COPY --from=python-builder /opt/pyenv /opt/pyenv
ENV PATH="/opt/pyenv/shims:/opt/pyenv/bin:${PATH}"

# ─── Node.js (required by Snyk CLI) ───
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# ─── Snyk CLI ───
RUN npm install -g snyk

# ─── Runtime configuration defaults ───
ENV SNYK_SEVERITY_THRESHOLD=high
ENV PYTHON_VERSION=3.14

WORKDIR /app
CMD ["bash"]
