# Snyk Security Plugin — Python scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies (includes Python build prerequisites)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    build-essential \
    gnupg \
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

# ─── Node.js (required by Snyk CLI) ───
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

# ─── Snyk CLI ───
RUN npm install -g snyk

# ─── Runtime configuration defaults ───
ENV SNYK_SEVERITY_THRESHOLD=high
ENV PYTHON_VERSION=3.14

# Working directory for pipeline source
WORKDIR /app

CMD ["bash"]
