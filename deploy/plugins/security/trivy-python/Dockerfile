# Trivy Security Plugin — Python scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Multistage rationale: pyenv compiles Python from source. Trivy reads
# requirements.txt + Pipfile.lock — never compiles user code. See
# security/bandit/Dockerfile for the full explanation.

ARG TRIVY_VERSION=0.69.3
ARG TRIVY_PREV_VERSION=0.68.2

# Upstream tool images — used as COPY sources only.
FROM aquasec/trivy:${TRIVY_VERSION} AS trivy-default
FROM aquasec/trivy:${TRIVY_PREV_VERSION} AS trivy-prev

# Python builder — needs the full build chain to compile pyenv interpreters.
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
ARG TRIVY_VERSION
ARG TRIVY_PREV_VERSION

# Python runtime libs only (no -dev headers).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl3 zlib1g libbz2-1.0 libreadline8 libsqlite3-0 \
    libncursesw6 libxml2 libxmlsec1 libffi8 liblzma5 \
    && rm -rf /var/lib/apt/lists/*

ENV PYENV_ROOT=/opt/pyenv
COPY --from=python-builder /opt/pyenv /opt/pyenv
ENV PATH="/opt/pyenv/shims:/opt/pyenv/bin:${PATH}"

# Node.js (some snyk/trivy workflows expect npm available).
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# ─── Trivy ───
RUN mkdir -p /opt/trivy/versions
COPY --from=trivy-prev /usr/local/bin/trivy /opt/trivy/versions/trivy-${TRIVY_PREV_VERSION}
COPY --from=trivy-default /usr/local/bin/trivy /opt/trivy/versions/trivy-${TRIVY_VERSION}
RUN ln -sf /opt/trivy/versions/trivy-${TRIVY_VERSION} /usr/local/bin/trivy

ENV TRIVY_VERSION=${TRIVY_VERSION}
ENV TRIVY_SEVERITY=HIGH,CRITICAL
ENV TRIVY_FORMAT=json
ENV PYTHON_VERSION=3.14

WORKDIR /app
CMD ["bash"]
