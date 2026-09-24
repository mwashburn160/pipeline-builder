# Pipeline Builder — Shared JVM Base Image
#
# Build target tag: pipeline-jvm-base:1.0
#
# One pinned Corretto JDK + Maven/Gradle/Kotlin, baked once, shared by every
# JVM plugin (java-corretto, jacoco, spotbugs, checkstyle, maven-publish, and
# the snyk/trivy/sonarcloud Java scanners). SINGLE-VERSION MODEL: bump the
# build-args and rebuild to change. Maven/Gradle/Kotlin come from the
# upstream archives, digest-verified.

FROM pipeline-plugin-base:24.04

USER root

RUN apt-retry-install build-essential

# Single Amazon Corretto JDK from the vendor apt repo. The repo signing key is
# pinned by fingerprint (fetch-apt-key); apt then verifies every package.
ARG JAVA_VERSION=25
RUN fetch-apt-key https://apt.corretto.aws/corretto.key /usr/share/keyrings/corretto-keyring.gpg \
       6DC3636DAE534049C8B94623A122542AB04F24E3 \
    && echo "deb [signed-by=/usr/share/keyrings/corretto-keyring.gpg] https://apt.corretto.aws stable main" \
       > /etc/apt/sources.list.d/corretto.list \
    && apt-retry-install "java-${JAVA_VERSION}-amazon-corretto-jdk"
ENV JAVA_HOME=/usr/lib/jvm/java-${JAVA_VERSION}-amazon-corretto
ENV PATH="${JAVA_HOME}/bin:${PATH}"
ENV JAVA_VERSION=${JAVA_VERSION}

# Maven, Gradle, Kotlin — pinned single versions from the upstream release
# archives, each verified against the digest the project publishes next to it
# (Maven .sha512, Gradle .sha256, Kotlin .sha256). No SDKMAN: its installer is
# an unpinned `curl | bash`. All three are JVM jars, so one download serves
# every architecture.
ARG MAVEN_VERSION=3.9.16
ARG MAVEN_SHA512=831a8591fe20c8243b1dbe7d71e3244f31d1665b0804b2e825e38cbbe5ce0cafb8338851f90780735568773e0a6cd07bbec107cda0b896b008b861075358b6f6
ARG GRADLE_VERSION=9.7.1
ARG GRADLE_SHA256=acd53f1edaf02f1a8ff99879f8a34b302661a057d9b063ae9e35b552f804d20a
ARG KOTLIN_VERSION=2.4.20
ARG KOTLIN_SHA256=59e9ca74c7904ef2c122b12114937673ccce68de820a663f0ed66ccf8799e0b7
RUN set -eux; \
    fetch-verified "https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz" "${MAVEN_SHA512}" /tmp/maven.tar.gz; \
    mkdir -p /opt/maven && tar -xzf /tmp/maven.tar.gz -C /opt/maven --strip-components=1; \
    fetch-verified "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" "${GRADLE_SHA256}" /tmp/gradle.zip; \
    unzip -q /tmp/gradle.zip -d /opt && mv "/opt/gradle-${GRADLE_VERSION}" /opt/gradle; \
    fetch-verified "https://github.com/JetBrains/kotlin/releases/download/v${KOTLIN_VERSION}/kotlin-compiler-${KOTLIN_VERSION}.zip" "${KOTLIN_SHA256}" /tmp/kotlin.zip; \
    unzip -q /tmp/kotlin.zip -d /opt && mv /opt/kotlinc /opt/kotlin; \
    rm -f /tmp/maven.tar.gz /tmp/gradle.zip /tmp/kotlin.zip
ENV MAVEN_HOME=/opt/maven
ENV GRADLE_HOME=/opt/gradle
ENV PATH="/opt/maven/bin:/opt/gradle/bin:/opt/kotlin/bin:${PATH}"
ENV KOTLIN_VERSION=${KOTLIN_VERSION}

RUN java -version && mvn --version && gradle --version && kotlin -version

WORKDIR /app
USER 1000:1000
CMD ["bash"]
