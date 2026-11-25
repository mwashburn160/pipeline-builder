# Pipeline Builder — Shared JVM Base Image
#
# Build target tag: plugin-jvm-base:1.0
#
# One pinned Corretto JDK + Maven/Gradle/Kotlin, baked once, shared by every
# JVM plugin (java-corretto, jacoco, spotbugs, checkstyle, maven-publish, and
# the snyk/trivy/sonarcloud Java scanners). SINGLE-VERSION MODEL: bump the
# build-args and rebuild to change. Maven/Gradle/Kotlin come from the
# upstream archives, digest-verified.

FROM plugin-base:26.10

USER root

RUN apt-retry-install build-essential

# Single Amazon Corretto JDK from the vendor apt repo. The repo signing key is
# pinned by fingerprint (fetch-apt-key); apt then verifies every package.
# LTS HOLD (re-checked 2026-11-18): the Corretto repo carries java-26 and
# java-27, but 25 is the LTS line and stays aligned with language/java and
# language/java-oracle (see "Current holds" in deploy/plugins/README.md).
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
# every architecture. Maven 3.10.1 -> 3.10.2, Gradle 9.9.1 -> 9.9.2
# (2026-11-25): each digest is the one published beside the archive, re-checked
# against a download. Maven 4.0.0 is still release-candidate only (rc-7), so 3.x
# stays.
ARG MAVEN_VERSION=3.10.2
ARG MAVEN_SHA512=57d2db6b37e7582119137ade544557bba741b29e62109ef81539a2bdfd6d0e641fdd5d8edb014af1816d0510deac6fac8f347433b3a1aa36316ba85aa77b8119
ARG GRADLE_VERSION=9.9.2
ARG GRADLE_SHA256=971fcd7150ca4ba04852c0b2ca0d2d0ab9468e14b03473eab19528809914c76b
ARG KOTLIN_VERSION=2.4.21
ARG KOTLIN_SHA256=7cc140e76daf416a0424a5557f99afd7ca89ebd463ea1101261e3e01c33e75cd
RUN set -eux; \
    fetch-verified "https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz" "${MAVEN_SHA512}" /tmp/maven.tar.gz; \
    mkdir -p /opt/maven && tar -xzf /tmp/maven.tar.gz -C /opt/maven --strip-components=1; \
    fetch-verified "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" "${GRADLE_SHA256}" /tmp/gradle.zip; \
    unzip -q /tmp/gradle.zip -d /opt && mv "/opt/gradle-${GRADLE_VERSION}" /opt/gradle; \
    fetch-verified "https://github.com/JetBrains/kotlin/releases/download/v${KOTLIN_VERSION}/kotlin-compiler-${KOTLIN_VERSION}.zip" "${KOTLIN_SHA256}" /tmp/kotlin.zip; \
    unzip -q /tmp/kotlin.zip -d /opt && mv /opt/kotlinc /opt/kotlin; \
    # kotlin-main-kts.jar is only the runtime for `*.main.kts` scripts, which no
    # plugin runs (builds go through Gradle/Maven, which fetch their own Kotlin).
    # It shades guava 33.6.0 (GHSA-xxph-c9ww-hj94, High; fixed in 33.7.2) and
    # Kotlin 2.4.21, the newest release, still ships it, so it is removed.
    rm -f /opt/kotlin/lib/kotlin-main-kts.jar; \
    rm -f /tmp/maven.tar.gz /tmp/gradle.zip /tmp/kotlin.zip
ENV MAVEN_HOME=/opt/maven
ENV GRADLE_HOME=/opt/gradle
ENV PATH="/opt/maven/bin:/opt/gradle/bin:/opt/kotlin/bin:${PATH}"
ENV KOTLIN_VERSION=${KOTLIN_VERSION}

RUN java -version && mvn --version && gradle --version && kotlin -version

WORKDIR /app
USER 1000:1000
CMD ["bash"]
