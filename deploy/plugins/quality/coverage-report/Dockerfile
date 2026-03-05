# Coverage Report Plugin — Code Coverage Aggregation
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Aggregates and validates coverage from multiple languages/tools
# Supports Istanbul/NYC (JS), coverage.py (Python), JaCoCo (Java), Go cover

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies + Java for JaCoCo
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    jq \
    ca-certificates \
    python3 \
    python3-pip \
    libxml2-utils \
    openjdk-17-jre-headless \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Coverage tools
RUN npm install -g nyc@17.1.0 c8@10.1.3 \
    && pip3 install --no-cache-dir --break-system-packages coverage==7.6.12

# ─── Runtime configuration defaults ───
ENV COVERAGE_THRESHOLD=80
ENV COVERAGE_FORMAT=text

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
