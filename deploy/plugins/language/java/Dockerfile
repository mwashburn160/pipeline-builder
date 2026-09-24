# Java/Kotlin Plugin — Eclipse Temurin JDK
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Temurin is a DISTRIBUTION-specific plugin, so it keeps its own JDK rather
# than the Corretto one in pipeline-jvm-base. SINGLE-VERSION MODEL: one pinned
# Temurin JDK (official Adoptium tarball, pinned digest) + the SAME pinned,
# checksum-verified Maven/Gradle/Kotlin as pipeline-jvm-base, copied from it.
# Bump the ARGs (JDK here, build tools in the jvm base) and rebuild to change;
# the running image is always deterministic.
#
# (Replaces the former `curl get.sdkman.io | bash` + `sdk install` flow, which
# piped a remote installer into a root shell and verified nothing.)

FROM pipeline-plugin-base:24.04

# Build steps below need root (apt, writes under /opt); the image drops back
# to the unprivileged `plugin` user (uid 1000) at the end.
USER root

# System dependencies for builds
RUN apt-retry-install build-essential

# ─── Temurin JDK ───
# Digests are Adoptium's published SHA-256s for the jdk-${JAVA_VERSION}+${JAVA_BUILD} assets.
ARG JAVA_VERSION=25.0.4.1
ARG JAVA_BUILD=1
ARG JAVA_SHA256_AMD64=dbb698396d478e7fa2b1e50f4103324b2a99b90569ee27c33f2261f9215cf41e
ARG JAVA_SHA256_ARM64=69df11a02cfa3ef7d7ca645e03edce6778ec090e100f6ae2b42097865730ac52
ENV JAVA_HOME=/opt/java
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x64;     sum="${JAVA_SHA256_AMD64}" ;; \
      arm64) arch=aarch64; sum="${JAVA_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    major="${JAVA_VERSION%%.*}"; \
    fetch-verified "https://github.com/adoptium/temurin${major}-binaries/releases/download/jdk-${JAVA_VERSION}%2B${JAVA_BUILD}/OpenJDK${major}U-jdk_${arch}_linux_hotspot_${JAVA_VERSION}_${JAVA_BUILD}.tar.gz" "$sum" /tmp/jdk.tar.gz; \
    mkdir -p "${JAVA_HOME}"; \
    tar -xzf /tmp/jdk.tar.gz -C "${JAVA_HOME}" --strip-components=1; \
    rm -f /tmp/jdk.tar.gz

# ─── Maven / Gradle / Kotlin ───
# Same pinned versions + digests as pipeline-jvm-base (Maven 3.9.16, Gradle
# 9.7.1, Kotlin 2.4.20) — copied, not re-downloaded.
COPY --from=pipeline-jvm-base:1.0 /opt/maven /opt/maven
COPY --from=pipeline-jvm-base:1.0 /opt/gradle /opt/gradle
COPY --from=pipeline-jvm-base:1.0 /opt/kotlin /opt/kotlin
ENV MAVEN_HOME=/opt/maven
ENV GRADLE_HOME=/opt/gradle
ENV PATH="${JAVA_HOME}/bin:/opt/maven/bin:/opt/gradle/bin:/opt/kotlin/bin:${PATH}"

RUN java -version && mvn --version && gradle --version && kotlin -version

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
