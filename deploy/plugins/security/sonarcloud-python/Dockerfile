# check=skip=SecretsUsedInArgOrEnv
# SonarCloud Plugin — Python scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Multistage rationale: pyenv compiles Python from source. sonar-scanner
# reads source files via its Python analyzer — never compiles user code.
# See security/bandit/Dockerfile for the full explanation.

ARG SONAR_DEFAULT_VERSION=12.0
ARG SONAR_PREV_VERSION=11.5

# Upstream sonar-scanner images — used as COPY sources only.
FROM sonarsource/sonar-scanner-cli:${SONAR_DEFAULT_VERSION} AS scanner-default
FROM sonarsource/sonar-scanner-cli:${SONAR_PREV_VERSION} AS scanner-prev

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

ARG SONAR_DEFAULT_VERSION
ARG SONAR_PREV_VERSION

# Python runtime libs only (no -dev headers).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl3 zlib1g libbz2-1.0 libreadline8 libsqlite3-0 \
    libncursesw6 libxml2 libxmlsec1 libffi8 liblzma5 \
    && rm -rf /var/lib/apt/lists/*

ENV PYENV_ROOT=/opt/pyenv
COPY --from=python-builder /opt/pyenv /opt/pyenv
ENV PATH="/opt/pyenv/shims:/opt/pyenv/bin:${PATH}"

# ─── Node.js (required by sonar-scanner) ───
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# ─── SonarScanner CLI ───
RUN mkdir -p /opt/sonar-scanner/versions
COPY --from=scanner-default /opt/sonar-scanner /opt/sonar-scanner/versions/scanner-${SONAR_DEFAULT_VERSION}
COPY --from=scanner-prev /opt/sonar-scanner /opt/sonar-scanner/versions/scanner-${SONAR_PREV_VERSION}
RUN ln -sf /opt/sonar-scanner/versions/scanner-${SONAR_DEFAULT_VERSION}/bin/sonar-scanner /usr/local/bin/sonar-scanner

ENV SONAR_SCANNER_VERSION=${SONAR_DEFAULT_VERSION}
ENV SONAR_ORGANIZATION=""
ENV SONAR_PROJECT_KEY=""
ENV PYTHON_VERSION=3.14

WORKDIR /app
CMD ["bash"]
