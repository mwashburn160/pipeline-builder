# Flyway Plugin — Database Migration
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Runs Flyway database migrations (migrate, repair, info, validate, clean)
# Requires Java runtime for Flyway execution

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

# ─── Flyway v10.22.0 ───
RUN curl -fsSL https://repo1.maven.org/maven2/org/flywaydb/flyway-commandline/10.22.0/flyway-commandline-10.22.0-linux-x64.tar.gz \
    -o /tmp/flyway.tar.gz \
    && tar -xzf /tmp/flyway.tar.gz -C /opt \
    && ln -s /opt/flyway-10.22.0/flyway /usr/local/bin/flyway \
    && rm /tmp/flyway.tar.gz

# ─── Runtime configuration defaults ───
ENV FLYWAY_URL=""
ENV FLYWAY_SCHEMAS=""
ENV FLYWAY_LOCATIONS=filesystem:./sql
ENV FLYWAY_ACTION=migrate
ENV FLYWAY_BASELINE_ON_MIGRATE=false
ENV FLYWAY_OUT_OF_ORDER=false

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
