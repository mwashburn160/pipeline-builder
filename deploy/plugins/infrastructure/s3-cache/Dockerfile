# S3 Cache Plugin — Build Cache Restore/Save
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Restores and saves build caches to S3 for faster pipeline runs
# Supports zstd, gzip, and no compression

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    ca-certificates \
    unzip \
    tar \
    zstd \
    gzip \
    && rm -rf /var/lib/apt/lists/*

# ─── AWS CLI v2 ───
RUN curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscli.zip

# ─── Runtime configuration defaults ───
ENV CACHE_BUCKET=""
ENV CACHE_KEY="${CODEBUILD_BUILD_ID}"
ENV CACHE_PATHS="node_modules,.cache"
ENV CACHE_ACTION=auto
ENV CACHE_COMPRESSION=zstd

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
