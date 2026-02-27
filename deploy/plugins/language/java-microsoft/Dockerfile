# Java/Kotlin Microsoft Plugin — Microsoft Build of OpenJDK
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Optimized for Azure workloads with long-term support
# Java version is selected at runtime via JAVA_VERSION env var
# Kotlin compiler pre-installed for Kotlin projects (JVM target)

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies for builds
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    jq \
    ca-certificates \
    build-essential \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install SDKMAN for JDK + build tool management
ENV SDKMAN_DIR=/opt/sdkman
RUN curl -fsSL "https://get.sdkman.io?rcupdate=false" | bash

# Pre-install Microsoft OpenJDK versions + build tools + Kotlin
RUN bash -c "source ${SDKMAN_DIR}/bin/sdkman-init.sh && \
    sdk install java 17.0.13-ms && \
    sdk install java 21.0.5-ms && \
    sdk install maven 3.9.9 && \
    sdk install gradle 8.12 && \
    sdk install kotlin 2.1.0 && \
    sdk install kotlin 1.9.25 && \
    sdk default java 17.0.13-ms && \
    sdk default kotlin 2.1.0"

# Add SDKMAN candidates to PATH
ENV PATH="${SDKMAN_DIR}/candidates/java/current/bin:${SDKMAN_DIR}/candidates/maven/current/bin:${SDKMAN_DIR}/candidates/gradle/current/bin:${SDKMAN_DIR}/candidates/kotlin/current/bin:${SDKMAN_DIR}/bin:${PATH}"

# Default Java version (overridden by JAVA_VERSION env var at runtime)
ENV JAVA_VERSION=17.0.13-ms

# Default Kotlin version (overridden by KOTLIN_VERSION env var at runtime)
ENV KOTLIN_VERSION=2.1.0

# Build tool selection (auto = detect from project files)
ENV BUILD_TOOL=auto

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
