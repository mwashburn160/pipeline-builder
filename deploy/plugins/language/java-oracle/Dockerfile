# Java/Kotlin GraalVM Plugin — GraalVM Community Edition JDK
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports GraalVM native-image for ahead-of-time compilation
#
# GraalVM is a DISTRIBUTION-specific plugin, so it keeps its own JDK rather
# than the Corretto one in plugin-jvm-base. SINGLE-VERSION MODEL: one pinned
# GraalVM CE JDK (official tarball, pinned digest) + the SAME pinned,
# checksum-verified Maven/Gradle/Kotlin as plugin-jvm-base, copied from it.
# Bump the ARGs (JDK here, build tools in the jvm base) and rebuild to change;
# the running image is always deterministic.
#
# (Replaces the former `curl get.sdkman.io | bash` + `sdk install` flow, which
# piped a remote installer into a root shell and verified nothing.)

FROM plugin-base:26.10

# Build steps below need root (apt, writes under /opt); the image drops back
# to the unprivileged `plugin` user (uid 1000) at the end.
USER root

# System dependencies for builds + GraalVM native-image prerequisites.
# `libz-dev` was previously listed but it's a virtual package on Ubuntu —
# zlib1g-dev provides it. Real package only.
RUN apt-retry-install build-essential zlib1g-dev

# ─── GraalVM Community Edition JDK ───
# GraalVM CE (Oracle's open-source GraalVM build, GPLv2 + Classpath Exception,
# from github.com/graalvm/graalvm-ce-builds), not Oracle GraalVM: Oracle has
# published no Oracle GraalVM for JDK 25 past 25.0.4 (2026-07), which carries
# the JDK 25.0.5 / 25.0.5.1 CPU CVEs. CE tracks the JDK updates and ships the
# same native-image toolchain the commands drive.
# Release tag graal-<J>.<N>.<rest> ships jdk-<J>i<N>-<JAVA_VERSION> assets, so
# bump GRAALVM_VERSION and JAVA_VERSION together.
# Digests are the release's published .sha256 files (recomputed on download).
ARG GRAALVM_VERSION=25.6.5.1
ARG JAVA_VERSION=25.0.5.1
ARG JAVA_SHA256_AMD64=d792848db26f1602f0a5cf2cd9279d9a652d32ab450d891ce616c9ca67e359d0
ARG JAVA_SHA256_ARM64=d8e6edf0009bb5d70c6a670eb030d36aa804795427306434c0f7f63c01435307
ENV JAVA_HOME=/opt/java
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x64;     sum="${JAVA_SHA256_AMD64}" ;; \
      arm64) arch=aarch64; sum="${JAVA_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    line="$(echo "${GRAALVM_VERSION}" | cut -d. -f1)i$(echo "${GRAALVM_VERSION}" | cut -d. -f2)"; \
    fetch-verified "https://github.com/graalvm/graalvm-ce-builds/releases/download/graal-${GRAALVM_VERSION}/graalvm-community-jdk-${line}-${JAVA_VERSION}_linux-${arch}_bin.tar.gz" "$sum" /tmp/graalvm.tar.gz; \
    mkdir -p "${JAVA_HOME}"; \
    tar -xzf /tmp/graalvm.tar.gz -C "${JAVA_HOME}" --strip-components=1; \
    rm -f /tmp/graalvm.tar.gz

# ─── Maven / Gradle / Kotlin ───
# Copied from plugin-jvm-base, not re-downloaded, so these take whatever that
# base pins. The versions are deliberately not restated here (a copy of another
# image's pins goes stale the moment that image is bumped, and nothing fails
# when it does); see _base/_jvm-base/Dockerfile for the live values.
COPY --from=plugin-jvm-base:1.0 /opt/maven /opt/maven
COPY --from=plugin-jvm-base:1.0 /opt/gradle /opt/gradle
COPY --from=plugin-jvm-base:1.0 /opt/kotlin /opt/kotlin
ENV MAVEN_HOME=/opt/maven
ENV GRADLE_HOME=/opt/gradle
ENV PATH="${JAVA_HOME}/bin:/opt/maven/bin:/opt/gradle/bin:/opt/kotlin/bin:${PATH}"

# native-image ships with GraalVM CE (no separate `gu install` needed).
RUN java -version && mvn --version && gradle --version && kotlin -version && native-image --version

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
