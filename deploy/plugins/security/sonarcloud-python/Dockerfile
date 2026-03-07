# SonarCloud Plugin — Python scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder

ARG SONAR_DEFAULT_VERSION=12.0
ARG SONAR_PREV_VERSION=11.5

FROM sonarsource/sonar-scanner-cli:${SONAR_DEFAULT_VERSION} AS scanner-default
FROM sonarsource/sonar-scanner-cli:${SONAR_PREV_VERSION} AS scanner-prev

FROM public.ecr.aws/docker/library/ubuntu:24.04

ARG SONAR_DEFAULT_VERSION
ARG SONAR_PREV_VERSION

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq ca-certificates build-essential gnupg \
    libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev \
    libncursesw5-dev libxml2-dev libxmlsec1-dev libffi-dev liblzma-dev \
    && rm -rf /var/lib/apt/lists/*

# ─── Node.js (required by sonar-scanner) ───
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ─── Python via pyenv ───
ENV PYENV_ROOT=/opt/pyenv
RUN curl -fsSL https://pyenv.run | bash
RUN /opt/pyenv/bin/pyenv install 3.13 && \
    /opt/pyenv/bin/pyenv install 3.14 && \
    /opt/pyenv/bin/pyenv global 3.14
ENV PATH="/opt/pyenv/shims:/opt/pyenv/bin:${PATH}"

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
