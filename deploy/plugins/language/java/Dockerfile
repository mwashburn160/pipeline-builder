# Java/Kotlin Plugin — Eclipse Temurin JDK
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Temurin is a DISTRIBUTION-specific plugin, so it keeps its own Dockerfile
# rather than the Corretto-based pipeline-jvm-base. SINGLE-VERSION MODEL: one
# pinned Temurin JDK + Maven/Gradle/Kotlin, baked via SDKMAN as a BUILD-TIME
# installer (not a runtime version switcher). Bump the build-args and rebuild
# to change; the running image is always deterministic.

FROM pipeline-plugin-base:24.04

# System dependencies for builds + SDKMAN prerequisites
RUN apt-retry-install build-essential

# Single pinned Temurin JDK + Maven/Gradle/Kotlin via SDKMAN (build-time only).
ENV SDKMAN_DIR=/opt/sdkman
ARG JAVA_VERSION=25.0.3-tem
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

RUN java -version && mvn --version && gradle --version && kotlin -version

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
