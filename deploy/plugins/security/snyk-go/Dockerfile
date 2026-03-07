# Snyk Security Plugin — Go scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    build-essential \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# ─── Node.js (required by Snyk CLI) ───
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ─── Go via goenv ───
ENV GOENV_ROOT=/opt/goenv
RUN git clone https://github.com/go-nv/goenv.git ${GOENV_ROOT}
RUN ${GOENV_ROOT}/bin/goenv install 1.23.12 && \
    ${GOENV_ROOT}/bin/goenv install 1.24.13 && \
    ${GOENV_ROOT}/bin/goenv global 1.24.13
ENV PATH="${GOENV_ROOT}/shims:${GOENV_ROOT}/bin:${PATH}"

# ─── Snyk CLI ───
RUN npm install -g snyk

# ─── Runtime configuration defaults ───
ENV SNYK_SEVERITY_THRESHOLD=high
ENV GO_VERSION=1.24.13

# Working directory for pipeline source
WORKDIR /app

CMD ["bash"]
