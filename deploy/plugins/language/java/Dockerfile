# Java/Kotlin Plugin — Eclipse Temurin JDK
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Temurin is a DISTRIBUTION-specific plugin, so it keeps its own JDK rather
# than the Corretto one in plugin-jvm-base. SINGLE-VERSION MODEL: one pinned
# Temurin JDK (official Adoptium tarball, pinned digest) + the SAME pinned,
# checksum-verified Maven/Gradle/Kotlin as plugin-jvm-base, copied from it.
# Bump the ARGs (JDK here, build tools in the jvm base) and rebuild to change;
# the running image is always deterministic.
#
# (Replaces the former `curl get.sdkman.io | bash` + `sdk install` flow, which
# piped a remote installer into a root shell and verified nothing.)

FROM plugin-base:24.04

# Build steps below need root (apt, writes under /opt); the image drops back
# to the unprivileged `plugin` user (uid 1000) at the end.
USER root

# System dependencies for builds
RUN apt-retry-install build-essential

# ─── Temurin JDK ───
# Digests are Adoptium's published SHA-256s for the jdk-${JAVA_VERSION}+${JAVA_BUILD} assets.
ARG JAVA_VERSION=25.0.5
ARG JAVA_BUILD=8
ARG JAVA_SHA256_AMD64=68982529869257d0ee6b824ec5aa270ff8b118bb438670da0b97ebdab178d7fb
ARG JAVA_SHA256_ARM64=bb5b2ded252f21c6090cf780b0a408ad0d83bbb557e702955643557f13231880
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
# Copied from plugin-jvm-base, not re-downloaded, so these take whatever that
# base pins — Maven 3.10.0, Gradle 9.8.2, Kotlin 2.4.21 at the time of writing.
# The previous note here named 3.9.16 / 9.7.1 / 2.4.20: restating another
# image's pins means they go stale the moment that image is bumped, and nothing
# fails when they do. Check _base/_jvm-base/Dockerfile for the live values.
COPY --from=plugin-jvm-base:1.0 /opt/maven /opt/maven
COPY --from=plugin-jvm-base:1.0 /opt/gradle /opt/gradle
COPY --from=plugin-jvm-base:1.0 /opt/kotlin /opt/kotlin
ENV MAVEN_HOME=/opt/maven
ENV GRADLE_HOME=/opt/gradle
ENV PATH="${JAVA_HOME}/bin:/opt/maven/bin:/opt/gradle/bin:/opt/kotlin/bin:${PATH}"

RUN java -version && mvn --version && gradle --version && kotlin -version

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
