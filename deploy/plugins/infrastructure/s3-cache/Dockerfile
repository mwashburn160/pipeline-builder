# check=skip=SecretsUsedInArgOrEnv,UndefinedVar
# S3 Cache Plugin — Build Cache Restore/Save
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Restores and saves build caches to S3 for faster pipeline runs
# Supports zstd, gzip, and no compression

FROM pipeline-aws-cli-base:1.0

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

RUN apt-retry-install tar zstd gzip

# ─── Runtime configuration defaults ───
ENV CACHE_BUCKET=""
ENV CACHE_KEY="${CODEBUILD_BUILD_ID}"
ENV CACHE_PATHS="node_modules,.cache"
ENV CACHE_ACTION=auto
ENV CACHE_COMPRESSION=zstd

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
