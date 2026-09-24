# Java/Kotlin Oracle Plugin — Oracle GraalVM JDK
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports GraalVM native-image for ahead-of-time compilation
#
# GraalVM is a DISTRIBUTION-specific plugin, so it keeps its own JDK rather
# than the Corretto one in pipeline-jvm-base. SINGLE-VERSION MODEL: one pinned
# Oracle GraalVM JDK (official tarball, pinned digest) + the SAME pinned,
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

# System dependencies for builds + GraalVM native-image prerequisites.
# `libz-dev` was previously listed but it's a virtual package on Ubuntu —
# zlib1g-dev provides it. Real package only.
RUN apt-retry-install build-essential zlib1g-dev

# ─── Oracle GraalVM JDK ───
# Digests are Oracle's published .sha256 files for these archive tarballs.
ARG JAVA_VERSION=25.0.4
ARG JAVA_SHA256_AMD64=76007c309f821aaf435bce63162ea0395587fc77350801c81643fe7feea37276
ARG JAVA_SHA256_ARM64=7031aead8da4c6a7816c4e2be4eabfddaf7f4abcfe8e5f16134c4da69a5e70de
ENV JAVA_HOME=/opt/java
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x64;     sum="${JAVA_SHA256_AMD64}" ;; \
      arm64) arch=aarch64; sum="${JAVA_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    major="${JAVA_VERSION%%.*}"; \
    fetch-verified "https://download.oracle.com/graalvm/${major}/archive/graalvm-jdk-${JAVA_VERSION}_linux-${arch}_bin.tar.gz" "$sum" /tmp/graalvm.tar.gz; \
    mkdir -p "${JAVA_HOME}"; \
    tar -xzf /tmp/graalvm.tar.gz -C "${JAVA_HOME}" --strip-components=1; \
    rm -f /tmp/graalvm.tar.gz

# ─── Maven / Gradle / Kotlin ───
# Same pinned versions + digests as pipeline-jvm-base (Maven 3.9.16, Gradle
# 9.7.1, Kotlin 2.4.20) — copied, not re-downloaded.
COPY --from=pipeline-jvm-base:1.0 /opt/maven /opt/maven
COPY --from=pipeline-jvm-base:1.0 /opt/gradle /opt/gradle
COPY --from=pipeline-jvm-base:1.0 /opt/kotlin /opt/kotlin
ENV MAVEN_HOME=/opt/maven
ENV GRADLE_HOME=/opt/gradle
ENV PATH="${JAVA_HOME}/bin:/opt/maven/bin:/opt/gradle/bin:/opt/kotlin/bin:${PATH}"

# native-image ships with Oracle GraalVM (no separate `gu install` needed).
RUN java -version && mvn --version && gradle --version && kotlin -version && native-image --version

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
