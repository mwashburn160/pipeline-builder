# Maven Publish Plugin — Publish artifacts to Maven Central
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Publishes Java/Kotlin artifacts to Maven Central via OSSRH or custom repository
# Requires OSSRH_USERNAME + OSSRH_PASSWORD + GPG_PASSPHRASE injected at runtime via CodeBuild secrets

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
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# ─── Java 17 + Maven 3.9.9 via SDKMAN ───
ENV SDKMAN_DIR=/opt/sdkman
RUN curl -fsSL "https://get.sdkman.io?rcupdate=false" | bash
RUN bash -c "source ${SDKMAN_DIR}/bin/sdkman-init.sh && \
    sdk install java 17.0.18-tem && \
    sdk install maven 3.9.9 && \
    sdk default java 17.0.18-tem && \
    sdk default maven 3.9.9"

# Add SDKMAN candidates to PATH
ENV PATH="${SDKMAN_DIR}/candidates/java/current/bin:${SDKMAN_DIR}/candidates/maven/current/bin:${SDKMAN_DIR}/bin:${PATH}"

# ─── Runtime configuration defaults ───
# Non-sensitive config only — credentials injected at runtime via CodeBuild secrets
ENV MAVEN_REPOSITORY_URL=""

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
