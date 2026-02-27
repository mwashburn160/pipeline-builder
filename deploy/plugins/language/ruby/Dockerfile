# Ruby Plugin — Multi-version build environment using rbenv
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Ruby version is selected at runtime via RUBY_VERSION env var

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies for builds + rbenv compilation prerequisites
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    jq \
    ca-certificates \
    build-essential \
    libssl-dev \
    zlib1g-dev \
    libreadline-dev \
    libyaml-dev \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Install rbenv + ruby-build
ENV RBENV_ROOT=/opt/rbenv
RUN git clone https://github.com/rbenv/rbenv.git ${RBENV_ROOT} \
    && git clone https://github.com/rbenv/ruby-build.git ${RBENV_ROOT}/plugins/ruby-build

# Pre-install common Ruby versions
RUN ${RBENV_ROOT}/bin/rbenv install 3.2.6 && \
    ${RBENV_ROOT}/bin/rbenv install 3.3.6 && \
    ${RBENV_ROOT}/bin/rbenv global 3.3.6

# Add rbenv to PATH
ENV PATH="${RBENV_ROOT}/shims:${RBENV_ROOT}/bin:${PATH}"

# Default Ruby version (overridden by RUBY_VERSION env var at runtime)
ENV RUBY_VERSION=3.3.6

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
