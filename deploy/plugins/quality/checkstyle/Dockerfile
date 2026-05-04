# Checkstyle Plugin — Java Code Style Enforcement
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Enforces coding standards for Java projects (Google, Sun, custom)
# Multi-version support via SDKMAN

FROM pipeline-plugin-base:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ─── Java via SDKMAN ───
ENV SDKMAN_DIR=/opt/sdkman
RUN curl -fsSL "https://get.sdkman.io?rcupdate=false" | bash
RUN bash -c "source ${SDKMAN_DIR}/bin/sdkman-init.sh && \
    sdk install java 17.0.18-tem && \
    sdk install java 21.0.10-tem && \
    sdk install maven 3.9.9 && \
    sdk install gradle 8.12 && \
    sdk default java 21.0.10-tem"
ENV PATH="${SDKMAN_DIR}/candidates/java/current/bin:${SDKMAN_DIR}/candidates/maven/current/bin:${SDKMAN_DIR}/candidates/gradle/current/bin:${SDKMAN_DIR}/bin:${PATH}"

# ─── Checkstyle CLI — multi-version ───
RUN mkdir -p /opt/checkstyle/versions

RUN curl -fsSL https://github.com/checkstyle/checkstyle/releases/download/checkstyle-10.20.2/checkstyle-10.20.2-all.jar \
    -o /opt/checkstyle/versions/checkstyle-10.20.2.jar

RUN curl -fsSL https://github.com/checkstyle/checkstyle/releases/download/checkstyle-10.21.1/checkstyle-10.21.1-all.jar \
    -o /opt/checkstyle/versions/checkstyle-10.21.1.jar

RUN ln -sf /opt/checkstyle/versions/checkstyle-10.21.1.jar /opt/checkstyle/checkstyle.jar

# Download standard configs.
# Pin to the matching checkstyle release tag — fetching from `master` would
# silently break the build on upstream rename or restructure. Bump in
# lockstep with CHECKSTYLE_VERSION below.
RUN mkdir -p /opt/checkstyle/configs
RUN curl -fsSL https://raw.githubusercontent.com/checkstyle/checkstyle/checkstyle-10.21.1/src/main/resources/google_checks.xml \
    -o /opt/checkstyle/configs/google_checks.xml
RUN curl -fsSL https://raw.githubusercontent.com/checkstyle/checkstyle/checkstyle-10.21.1/src/main/resources/sun_checks.xml \
    -o /opt/checkstyle/configs/sun_checks.xml

# ─── Runtime configuration defaults ───
ENV CHECKSTYLE_VERSION=10.21.1
ENV CHECKSTYLE_CONFIG=google
ENV JAVA_VERSION=21.0.10-tem

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
