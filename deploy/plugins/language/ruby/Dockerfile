# Ruby Plugin — Multi-version build environment using rbenv
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Ruby version is selected at runtime via RUBY_VERSION env var

FROM pipeline-plugin-base:24.04

# System dependencies for builds + rbenv compilation prerequisites
RUN apt-retry-install build-essential libssl-dev zlib1g-dev libreadline-dev libyaml-dev libffi-dev

# Install rbenv + ruby-build
ENV RBENV_ROOT=/opt/rbenv
RUN git clone https://github.com/rbenv/rbenv.git ${RBENV_ROOT} \
    && git clone https://github.com/rbenv/ruby-build.git ${RBENV_ROOT}/plugins/ruby-build

# Pre-install current + previous Ruby versions
RUN ${RBENV_ROOT}/bin/rbenv install 3.4.8 && \
    ${RBENV_ROOT}/bin/rbenv install 4.0.1 && \
    ${RBENV_ROOT}/bin/rbenv global 4.0.1

# Add rbenv to PATH
ENV PATH="${RBENV_ROOT}/shims:${RBENV_ROOT}/bin:${PATH}"

# Default Ruby version (overridden by RUBY_VERSION env var at runtime)
ENV RUBY_VERSION=4.0.1

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
