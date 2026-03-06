# Postman Plugin — API Contract Testing via Newman
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs Postman collections using Newman CLI
# Supports environment files, global variables, and multiple reporters

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ─── Node.js ───
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ─── Newman (Postman CLI runner) + reporters ───
RUN npm install -g newman@6.2.1 \
    newman-reporter-htmlextra@1.23.1 \
    newman-reporter-junitfull@1.1.1

# ─── Runtime configuration defaults ───
ENV COLLECTION_FILE=""
ENV ENVIRONMENT_FILE=""
ENV GLOBALS_FILE=""
ENV ITERATION_COUNT=1
ENV NEWMAN_TIMEOUT=60000
ENV BAIL_ON_FAILURE=false

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
