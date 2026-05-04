# Python Plugin — Multi-version build environment using pyenv
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Python version is selected at runtime via PYTHON_VERSION env var
# Package manager auto-detected (pip/poetry/pipenv) or set via PACKAGE_MANAGER env var

FROM pipeline-plugin-base:24.04

# System dependencies for builds + pyenv compilation prerequisites
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libssl-dev \
    zlib1g-dev \
    libbz2-dev \
    libreadline-dev \
    libsqlite3-dev \
    libncursesw5-dev \
    libxml2-dev \
    libxmlsec1-dev \
    libffi-dev \
    liblzma-dev \
    && rm -rf /var/lib/apt/lists/*

# Install pyenv
ENV PYENV_ROOT=/opt/pyenv
RUN curl -fsSL https://pyenv.run | bash

# Pre-install current + previous Python versions
RUN /opt/pyenv/bin/pyenv install 3.13 && \
    /opt/pyenv/bin/pyenv install 3.14 && \
    /opt/pyenv/bin/pyenv global 3.14

# Add pyenv to PATH
ENV PATH="/opt/pyenv/shims:/opt/pyenv/bin:${PATH}"

# Default Python version (overridden by PYTHON_VERSION env var at runtime)
ENV PYTHON_VERSION=3.14

# Package manager selection (auto = detect from project files)
ENV PACKAGE_MANAGER=auto

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
