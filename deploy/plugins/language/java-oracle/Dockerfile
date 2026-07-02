# Java/Kotlin Oracle Plugin — Oracle GraalVM JDK
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports GraalVM native-image for ahead-of-time compilation
# Java version is selected at runtime via JAVA_VERSION env var
# Kotlin compiler pre-installed for Kotlin projects (JVM target)

FROM pipeline-plugin-base:24.04

# System dependencies for builds + GraalVM native-image prerequisites.
# `libz-dev` was previously listed but it's a virtual package on Ubuntu —
# zlib1g-dev provides it, and the apt-retry-install dpkg sanity check
# can't see virtual package names. Real package only.
RUN apt-retry-install build-essential zlib1g-dev

# Install SDKMAN for JDK + build tool management
ENV SDKMAN_DIR=/opt/sdkman
RUN curl -fsSL "https://get.sdkman.io?rcupdate=false" | bash

# Pre-install current + previous Oracle GraalVM versions + build tools + Kotlin
RUN bash -c "source ${SDKMAN_DIR}/bin/sdkman-init.sh && \
    sdk install java 21.0.10-graal && \
    sdk install java 25.0.3-graal && \
    sdk install maven 3.9.9 && \
    sdk install gradle 9.6.0 && \
    sdk install kotlin 2.2.21 && \
    sdk default java 25.0.3-graal && \
    sdk default kotlin 2.2.21"

# Stable major-version aliases (21, 25) so JAVA_VERSION is a plain major,
# consistent with the Corretto plugins. The spec's `candidates/java/${JAVA_VERSION}`
# path resolves through these symlinks; JAVA_VERSION=25 switches JDKs.
RUN ln -s 21.0.10-graal "${SDKMAN_DIR}/candidates/java/21" \
 && ln -s 25.0.3-graal "${SDKMAN_DIR}/candidates/java/25"

# Add SDKMAN candidates to PATH
ENV PATH="${SDKMAN_DIR}/candidates/java/current/bin:${SDKMAN_DIR}/candidates/maven/current/bin:${SDKMAN_DIR}/candidates/gradle/current/bin:${SDKMAN_DIR}/candidates/kotlin/current/bin:${SDKMAN_DIR}/bin:${PATH}"

# Default Java version (overridden by JAVA_VERSION env var at runtime)
ENV JAVA_VERSION=25

# Default Kotlin version (overridden by KOTLIN_VERSION env var at runtime)
ENV KOTLIN_VERSION=2.2.21

# Build tool selection (auto = detect from project files)
ENV BUILD_TOOL=auto

# Enable native-image builds (set to true to build native executable)
ENV NATIVE_BUILD=false

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
