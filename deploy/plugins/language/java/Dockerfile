# Java/Kotlin Plugin — Multi-version build environment using SDKMAN
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Java version is selected at runtime via JAVA_VERSION env var
# Kotlin compiler pre-installed for Kotlin projects (JVM target)
# Build tool auto-detected (Maven/Gradle) or set via BUILD_TOOL env var

FROM pipeline-plugin-base:24.04

# System dependencies for builds + SDKMAN prerequisites
RUN apt-retry-install build-essential

# Install SDKMAN
ENV SDKMAN_DIR=/opt/sdkman
RUN curl -fsSL "https://get.sdkman.io?rcupdate=false" | bash

# Pre-install current + previous Java LTS versions, Maven, Gradle, and Kotlin
RUN bash -c "source ${SDKMAN_DIR}/bin/sdkman-init.sh && \
    sdk install java 17.0.18-tem && \
    sdk install java 21.0.10-tem && \
    sdk install maven 3.9.9 && \
    sdk install gradle 8.12 && \
    sdk install kotlin 2.1.0 && \
    sdk default java 21.0.10-tem && \
    sdk default kotlin 2.1.0"

# Add SDKMAN candidates to PATH
ENV PATH="${SDKMAN_DIR}/candidates/java/current/bin:${SDKMAN_DIR}/candidates/maven/current/bin:${SDKMAN_DIR}/candidates/gradle/current/bin:${SDKMAN_DIR}/candidates/kotlin/current/bin:${SDKMAN_DIR}/bin:${PATH}"

# Default Java version (overridden by JAVA_VERSION env var at runtime)
ENV JAVA_VERSION=21.0.10-tem

# Default Kotlin version (overridden by KOTLIN_VERSION env var at runtime)
ENV KOTLIN_VERSION=2.1.0

# Build tool selection (auto = detect from project files)
ENV BUILD_TOOL=auto

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
