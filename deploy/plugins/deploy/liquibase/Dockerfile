# Liquibase Plugin — Database Migration
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs Liquibase database migrations (update, rollback, status, validate, diff)
# Requires Java runtime for Liquibase execution

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
    openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

# ─── Liquibase v4.30.0 ───
RUN curl -fsSL https://github.com/liquibase/liquibase/releases/download/v4.30.0/liquibase-4.30.0.tar.gz \
    -o /tmp/liquibase.tar.gz \
    && mkdir -p /opt/liquibase \
    && tar -xzf /tmp/liquibase.tar.gz -C /opt/liquibase \
    && ln -s /opt/liquibase/liquibase /usr/local/bin/liquibase \
    && chmod +x /opt/liquibase/liquibase \
    && rm /tmp/liquibase.tar.gz

# ─── Runtime configuration defaults ───
ENV LIQUIBASE_URL=""
ENV LIQUIBASE_CHANGELOG_FILE=changelog.xml
ENV LIQUIBASE_ACTION=update
ENV LIQUIBASE_CONTEXTS=""
ENV LIQUIBASE_LABELS=""
ENV ROLLBACK_COUNT=1

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
