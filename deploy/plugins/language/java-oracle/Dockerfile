# Java/Kotlin Oracle Plugin — Oracle GraalVM JDK
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports GraalVM native-image for ahead-of-time compilation
#
# GraalVM is a DISTRIBUTION-specific plugin, so it keeps its own Dockerfile
# rather than the Corretto-based pipeline-jvm-base. SINGLE-VERSION MODEL: one
# pinned GraalVM JDK + Maven/Gradle/Kotlin, baked via SDKMAN as a BUILD-TIME
# installer (not a runtime version switcher). Bump the build-args and rebuild
# to change; the running image is always deterministic.

FROM pipeline-plugin-base:24.04

# System dependencies for builds + GraalVM native-image prerequisites.
# `libz-dev` was previously listed but it's a virtual package on Ubuntu —
# zlib1g-dev provides it, and the apt-retry-install dpkg sanity check
# can't see virtual package names. Real package only.
RUN apt-retry-install build-essential zlib1g-dev

# Single pinned GraalVM JDK + Maven/Gradle/Kotlin via SDKMAN (build-time only).
ENV SDKMAN_DIR=/opt/sdkman
ARG JAVA_VERSION=25.0.3-graal
ARG MAVEN_VERSION=3.9.9
ARG GRADLE_VERSION=9.6.0
ARG KOTLIN_VERSION=2.2.21
RUN curl -fsSL "https://get.sdkman.io?rcupdate=false" | bash \
    && bash -c "source ${SDKMAN_DIR}/bin/sdkman-init.sh && \
        sdk install java ${JAVA_VERSION} && \
        sdk install maven ${MAVEN_VERSION} && \
        sdk install gradle ${GRADLE_VERSION} && \
        sdk install kotlin ${KOTLIN_VERSION} && \
        sdk default java ${JAVA_VERSION} && \
        sdk default kotlin ${KOTLIN_VERSION}"
ENV JAVA_HOME=${SDKMAN_DIR}/candidates/java/current
ENV PATH="${SDKMAN_DIR}/candidates/java/current/bin:${SDKMAN_DIR}/candidates/maven/current/bin:${SDKMAN_DIR}/candidates/gradle/current/bin:${SDKMAN_DIR}/candidates/kotlin/current/bin:${PATH}"

# native-image ships with Oracle GraalVM (no separate `gu install` needed).
RUN java -version && mvn --version && gradle --version && kotlin -version && native-image --version

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
