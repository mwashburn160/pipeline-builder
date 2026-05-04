# check=skip=SecretsUsedInArgOrEnv,UndefinedVar
# S3 Cache Plugin — Build Cache Restore/Save
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Restores and saves build caches to S3 for faster pipeline runs
# Supports zstd, gzip, and no compression

FROM pipeline-plugin-base:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    tar \
    zstd \
    gzip \
    && rm -rf /var/lib/apt/lists/*

# ─── AWS CLI v2 ───
RUN ARCH=$(uname -m) && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" -o /tmp/awscli.zip \
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
