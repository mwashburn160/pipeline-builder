# Bandit Plugin — Python Security Linter
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder

FROM public.ecr.aws/docker/library/ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    git zip unzip curl jq ca-certificates build-essential \
    libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev \
    libncursesw5-dev libxml2-dev libxmlsec1-dev libffi-dev liblzma-dev \
    && rm -rf /var/lib/apt/lists/*

ENV PYENV_ROOT=/opt/pyenv
RUN curl -fsSL https://pyenv.run | bash

RUN /opt/pyenv/bin/pyenv install 3.13 && \
    /opt/pyenv/bin/pyenv install 3.14 && \
    /opt/pyenv/bin/pyenv global 3.14

ENV PATH="/opt/pyenv/shims:/opt/pyenv/bin:${PATH}"
ENV PYTHON_VERSION=3.14

WORKDIR /app
CMD ["bash"]
