# Brakeman Plugin — Rails Security Scanner
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder

FROM pipeline-plugin-base:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    git zip unzip curl jq ca-certificates build-essential \
    libssl-dev zlib1g-dev libreadline-dev libyaml-dev libffi-dev \
    libsqlite3-dev libpq-dev libmysqlclient-dev \
    && rm -rf /var/lib/apt/lists/*

ENV RBENV_ROOT=/opt/rbenv
RUN git clone https://github.com/rbenv/rbenv.git ${RBENV_ROOT} \
    && git clone https://github.com/rbenv/ruby-build.git ${RBENV_ROOT}/plugins/ruby-build

RUN ${RBENV_ROOT}/bin/rbenv install 3.4.8 && \
    ${RBENV_ROOT}/bin/rbenv install 4.0.1 && \
    ${RBENV_ROOT}/bin/rbenv global 4.0.1

ENV PATH="${RBENV_ROOT}/shims:${RBENV_ROOT}/bin:${PATH}"
ENV RUBY_VERSION=4.0.1

WORKDIR /app
CMD ["bash"]
