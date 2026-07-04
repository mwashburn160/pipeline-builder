# Pipeline Builder — Shared JVM Base Image
#
# Build target tag: pipeline-jvm-base:1.0
#
# One pinned Corretto JDK + Maven/Gradle/Kotlin, baked once, shared by every
# JVM plugin (java-corretto, jacoco, spotbugs, checkstyle, maven-publish, and
# the snyk/trivy/sonarcloud Java scanners). SINGLE-VERSION MODEL: bump the
# build-args and rebuild to change. SDKMAN is used here only as a BUILD-TIME
# installer for pinned Maven/Gradle/Kotlin — not a runtime version switcher.

FROM pipeline-plugin-base:24.04

RUN apt-retry-install build-essential

# Single Amazon Corretto JDK from the vendor apt repo.
ARG JAVA_VERSION=25
RUN curl -fsSL https://apt.corretto.aws/corretto.key | gpg --dearmor -o /usr/share/keyrings/corretto-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/corretto-keyring.gpg] https://apt.corretto.aws stable main" \
       > /etc/apt/sources.list.d/corretto.list \
    && apt-retry-install "java-${JAVA_VERSION}-amazon-corretto-jdk"
ENV JAVA_HOME=/usr/lib/jvm/java-${JAVA_VERSION}-amazon-corretto
ENV PATH="${JAVA_HOME}/bin:${PATH}"
ENV JAVA_VERSION=${JAVA_VERSION}

# Maven, Gradle, Kotlin — pinned single versions via SDKMAN (build-time only).
ARG MAVEN_VERSION=3.9.9
ARG GRADLE_VERSION=9.6.0
ARG KOTLIN_VERSION=2.2.21
ENV SDKMAN_DIR=/opt/sdkman
RUN curl -fsSL "https://get.sdkman.io?rcupdate=false" | bash \
    && bash -c "source ${SDKMAN_DIR}/bin/sdkman-init.sh && \
        sdk install maven ${MAVEN_VERSION} && \
        sdk install gradle ${GRADLE_VERSION} && \
        sdk install kotlin ${KOTLIN_VERSION} && \
        sdk default kotlin ${KOTLIN_VERSION}"
ENV PATH="${SDKMAN_DIR}/candidates/maven/current/bin:${SDKMAN_DIR}/candidates/gradle/current/bin:${SDKMAN_DIR}/candidates/kotlin/current/bin:${PATH}"
ENV KOTLIN_VERSION=${KOTLIN_VERSION}

RUN java -version && mvn --version && gradle --version && kotlin -version

WORKDIR /app
CMD ["bash"]
