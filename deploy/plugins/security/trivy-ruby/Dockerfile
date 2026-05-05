# Trivy Security Plugin — Ruby scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Inherits from the trivy family base image (pipeline-trivy-base:1.0)
# which provides trivy CLI + (where applicable) Node.js. This file
# only adds the Ruby toolchain.

FROM pipeline-trivy-base:1.0

# ─── Ruby via rbenv ───
# rbenv compiles Ruby from source — needs the C build chain. See
# language/ruby/Dockerfile for the canonical dep list.
RUN apt-retry-install build-essential libssl-dev zlib1g-dev libreadline-dev libyaml-dev libffi-dev

ENV RBENV_ROOT=/opt/rbenv
RUN git clone --depth 1 https://github.com/rbenv/rbenv.git ${RBENV_ROOT} && \
    git clone --depth 1 https://github.com/rbenv/ruby-build.git ${RBENV_ROOT}/plugins/ruby-build
RUN ${RBENV_ROOT}/bin/rbenv install 3.4.8 && \
    ${RBENV_ROOT}/bin/rbenv install 4.0.1 && \
    ${RBENV_ROOT}/bin/rbenv global 4.0.1
ENV PATH="${RBENV_ROOT}/shims:${RBENV_ROOT}/bin:${PATH}"
ENV RUBY_VERSION=4.0.1

WORKDIR /app
CMD ["bash"]
